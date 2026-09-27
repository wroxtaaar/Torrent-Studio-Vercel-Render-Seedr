import asyncio
import base64
import json
import logging
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlencode, urljoin, urlsplit

import httpx
import libtorrent as lt
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

APP_NAME = "Torrent Studio API"
logger = logging.getLogger("torrent-studio")
SEEDR_BASE = "https://www.seedr.cc/api/v0.1/p"
SEEDR_MEDIA_BASE = "https://www.seedr.cc/api"
SEEDR_V2_BASE = "https://v2.seedr.cc/api/v0.1/p"
SEEDR_TOKEN = os.getenv("SEEDR_API_TOKEN", "").strip()
SEEDR_LIBRARY_FOLDER_ID = os.getenv("SEEDR_LIBRARY_FOLDER_ID", "0").strip() or "0"
SEEDR_MAX_SIZE_GB = float(os.getenv("SEEDR_MAX_SIZE_GB", "5"))
SEEDR_MAX_SIZE_BYTES = int(SEEDR_MAX_SIZE_GB * 1024**3)
SEARCH_STOPWORDS = {"the", "a", "an", "movie", "film", "series", "season", "episode", "web", "show", "tv"}
TORRENT_SEARCH_API_URL = os.getenv("TORRENT_SEARCH_API_URL", "https://torrent-search-api-ujfa.onrender.com").rstrip("/")
KNABEN_API_URL = os.getenv("KNABEN_API_URL", "https://api.knaben.org/v1").rstrip("/")
TORRENT_METADATA_API_URL = os.getenv("TORRENT_METADATA_API_URL", "https://torrentmeta.fly.dev").rstrip("/")
SEARCH_SOURCE_TIMEOUT_SECONDS = float(os.getenv("SEARCH_SOURCE_TIMEOUT_SECONDS", "8.5"))
SEARCH_CACHE_SECONDS = float(os.getenv("SEARCH_CACHE_SECONDS", "60"))
TORRENT_METADATA_CACHE_FILE = Path(os.getenv("TORRENT_METADATA_CACHE_FILE", "/app/.torrent_metadata_cache.json"))
TORRENT_METADATA_JOB_TIMEOUT_SECONDS = float(os.getenv("TORRENT_METADATA_JOB_TIMEOUT_SECONDS", "60"))
_search_cache: dict[tuple[str, int], tuple[float, list[dict[str, Any]]]] = {}

# Metadata is deliberately independent of Seedr. The cache survives requests
# within a Render instance, while the global libtorrent session keeps DHT state
# warm between magnets until the container is restarted.
_metadata_cache: dict[str, dict[str, Any]] = {}
_metadata_jobs: dict[str, dict[str, Any]] = {}
_libtorrent_session: Any | None = None
_libtorrent_session_lock: asyncio.Lock | None = None

app = FastAPI(title=APP_NAME)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class MagnetRequest(BaseModel):
    magnet: str
    folder_id: str | int | None = None
    torrent_name: str | None = None



def decode_torrent_metadata(raw: bytes) -> dict[bytes, Any]:
    """Decode the small bencoded .torrent metadata file produced by aria2."""
    position = 0

    def parse() -> Any:
        nonlocal position
        if position >= len(raw):
            raise ValueError("unexpected end of bencode")

        marker = raw[position:position + 1]
        if marker == b"i":
            position += 1
            end = raw.find(b"e", position)
            if end < 0:
                raise ValueError("unterminated integer")
            value = int(raw[position:end])
            position = end + 1
            return value

        if marker == b"l":
            position += 1
            value = []
            while position < len(raw) and raw[position:position + 1] != b"e":
                value.append(parse())
            if position >= len(raw):
                raise ValueError("unterminated list")
            position += 1
            return value

        if marker == b"d":
            position += 1
            value: dict[bytes, Any] = {}
            while position < len(raw) and raw[position:position + 1] != b"e":
                key = parse()
                if not isinstance(key, bytes):
                    raise ValueError("dictionary key is not bytes")
                value[key] = parse()
            if position >= len(raw):
                raise ValueError("unterminated dictionary")
            position += 1
            return value

        if marker.isdigit():
            colon = raw.find(b":", position)
            if colon < 0:
                raise ValueError("invalid byte string")
            size = int(raw[position:colon])
            position = colon + 1
            end = position + size
            if end > len(raw):
                raise ValueError("byte string exceeds metadata")
            value = raw[position:end]
            position = end
            return value

        raise ValueError("invalid bencode token")

    value = parse()
    if position != len(raw):
        raise ValueError("trailing bencode data")
    if not isinstance(value, dict):
        raise ValueError("torrent metadata root is not a dictionary")
    return value

def _load_metadata_cache() -> None:
    global _metadata_cache
    try:
        if TORRENT_METADATA_CACHE_FILE.exists():
            data = json.loads(TORRENT_METADATA_CACHE_FILE.read_text("utf-8"))
            if isinstance(data, dict):
                _metadata_cache = {
                    str(key).lower(): value
                    for key, value in data.items()
                    if isinstance(value, dict)
                }
    except Exception as exc:
        logger.info("Metadata cache load skipped: %s", exc)


def _save_metadata_cache() -> None:
    try:
        TORRENT_METADATA_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = TORRENT_METADATA_CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_metadata_cache, ensure_ascii=False), "utf-8")
        tmp.replace(TORRENT_METADATA_CACHE_FILE)
    except Exception as exc:
        logger.info("Metadata cache save skipped: %s", exc)


async def _fetch_source_torrent_descriptor(source_url: str, info_hash_value: str) -> dict[str, Any] | None:
    """Try to obtain a real .torrent descriptor from a trusted search detail URL."""
    if not source_url:
        return None

    try:
        parsed = urlsplit(source_url)
        host = (parsed.hostname or "").lower().rstrip(".")
    except Exception:
        return None

    # Search results currently expose Knaben detail URLs. Keep this narrowly
    # scoped rather than turning the endpoint into an arbitrary URL fetcher.
    allowed_hosts = {
        "knaben.org", "www.knaben.org", "api.knaben.org",
        "knaben.eu", "www.knaben.eu",
        "knaben.xyz", "www.knaben.xyz",
    }
    if host not in allowed_hosts:
        return None

    candidates = [source_url]
    try:
        async with httpx.AsyncClient(
            timeout=8.0,
            follow_redirects=True,
            headers={"User-Agent": "Torrent-Studio/1.0"},
        ) as client:
            response = await client.get(source_url)
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").lower()

            if "bittorrent" in content_type or source_url.lower().split("?", 1)[0].endswith(".torrent"):
                candidates = [str(response.url)]
                raw = response.content
            else:
                html = response.text
                soup = BeautifulSoup(html, "html.parser")
                for anchor in soup.find_all("a", href=True):
                    href = str(anchor.get("href") or "").strip()
                    absolute = urljoin(str(response.url), href)
                    if absolute.lower().split("?", 1)[0].endswith(".torrent"):
                        candidates.append(absolute)

                # Some indexers expose a download attribute without a .torrent
                # suffix in the visible URL.
                for anchor in soup.find_all("a", href=True):
                    href = str(anchor.get("href") or "").strip()
                    absolute = urljoin(str(response.url), href)
                    label = " ".join(anchor.stripped_strings).lower()
                    if "torrent" in label and absolute not in candidates:
                        candidates.append(absolute)

                raw = None

            for candidate in candidates[:8]:
                try:
                    if raw is None or candidate != str(response.url):
                        descriptor = await client.get(candidate)
                        descriptor.raise_for_status()
                        candidate_type = descriptor.headers.get("content-type", "").lower()
                        body = descriptor.content
                    else:
                        candidate_type = content_type
                        body = raw

                    if len(body) > 8 * 1024 * 1024:
                        continue
                    if body.startswith(b"d") and b"4:info" in body:
                        return _metadata_from_torrent_bytes(
                            body,
                            info_hash_value,
                            "search_torrent_descriptor",
                        )
                except Exception:
                    continue
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("Direct torrent descriptor lookup failed: %s", exc)

    return None


def _metadata_from_torrent_bytes(raw: bytes, info_hash_value: str, source: str) -> dict[str, Any]:
    meta = decode_torrent_metadata(raw)
    info = meta.get(b"info")
    if not isinstance(info, dict):
        raise ValueError("torrent metadata has no info dictionary")

    def btext(value: Any) -> str:
        return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value or "")

    name = btext(info.get(b"name")) or f"Torrent {info_hash_value[:8]}"
    files: list[dict[str, Any]] = []
    multi = info.get(b"files")
    if isinstance(multi, list):
        for index, item in enumerate(multi):
            if not isinstance(item, dict):
                continue
            parts = item.get(b"path") or []
            relative = "/".join(btext(part) for part in parts) if isinstance(parts, list) else btext(parts)
            files.append({
                "index": index,
                "name": relative or name,
                "size": int(item.get(b"length") or 0),
                "path": relative or name,
                "type": "file",
                "priority": 1,
            })
    else:
        files.append({
            "index": 0,
            "name": name,
            "size": int(info.get(b"length") or 0),
            "path": name,
            "type": "file",
            "priority": 1,
        })

    result = {
        "name": name,
        "hash": info_hash_value.lower(),
        "files": files,
        "totalSize": sum(int(item.get("size") or 0) for item in files),
        "source": source,
        "pending": False,
        "createdPreview": False,
        "message": "Torrent metadata loaded without starting Seedr.",
    }
    _metadata_cache[info_hash_value.lower()] = result
    _save_metadata_cache()
    return result


async def _get_libtorrent_session() -> Any:
    global _libtorrent_session, _libtorrent_session_lock
    if _libtorrent_session is not None:
        return _libtorrent_session
    if _libtorrent_session_lock is None:
        _libtorrent_session_lock = asyncio.Lock()
    async with _libtorrent_session_lock:
        if _libtorrent_session is not None:
            return _libtorrent_session
        session = lt.session()
        session.apply_settings({
            "enable_dht": True,
            "enable_lsd": False,
            "enable_upnp": False,
            "enable_natpmp": False,
            "enable_outgoing_tcp": True,
            "enable_outgoing_utp": True,
            "enable_incoming_tcp": True,
            "enable_incoming_utp": True,
            "listen_interfaces": "0.0.0.0:0",
            "dht_bootstrap_nodes": (
                "router.bittorrent.com:6881,"
                "router.utorrent.com:6881,"
                "dht.transmissionbt.com:6881"
            ),
            "announce_to_all_trackers": True,
            "announce_to_all_tiers": True,
            "connection_speed": 50,
            "handshake_timeout": 10,
        })
        _libtorrent_session = session
        logger.info("Started persistent libtorrent metadata session")
        return session


def _metadata_from_libtorrent_sync(magnet: str, info_hash_value: str) -> dict[str, Any]:
    tmp = tempfile.mkdtemp(prefix="torrent-metadata-lt-")
    session = _libtorrent_session
    if session is None:
        raise RuntimeError("libtorrent session is not initialized")

    handle = None
    try:
        atp = lt.parse_magnet_uri(magnet)
        atp.save_path = tmp
        atp.flags = atp.flags | lt.torrent_flags.upload_mode
        atp.flags = atp.flags & ~lt.torrent_flags.auto_managed
        handle = session.add_torrent(atp)

        deadline = time.monotonic() + TORRENT_METADATA_JOB_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if handle.has_metadata():
                ti = handle.torrent_file()
                if ti is None:
                    raise RuntimeError("libtorrent returned metadata without torrent info")
                fs = ti.layout()
                files = []
                for index in range(fs.num_files()):
                    path = str(fs.file_path(index))
                    files.append({
                        "index": index,
                        "name": path,
                        "size": int(fs.file_size(index)),
                        "path": path,
                        "type": "file",
                        "priority": 1,
                    })
                return {
                    "name": str(ti.name() or f"Torrent {info_hash_value[:8]}"),
                    "hash": info_hash_value.lower(),
                    "files": files,
                    "totalSize": sum(int(item["size"]) for item in files),
                    "source": "libtorrent_metadata",
                    "pending": False,
                    "createdPreview": False,
                    "message": "Torrent metadata loaded without starting Seedr.",
                }

            for alert in session.pop_alerts():
                message = str(alert)
                if "error" in message.lower() or "tracker" in message.lower():
                    logger.info("libtorrent metadata alert: %s", message[:500])
            time.sleep(0.2)

        status = handle.status()
        raise TimeoutError(
            f"Metadata is still resolving (state={status.state}, "
            f"peers={status.num_peers}, seeds={status.num_seeds})"
        )
    finally:
        try:
            if handle is not None and handle.is_valid():
                session.remove_torrent(handle)
        except Exception:
            pass
        shutil.rmtree(tmp, ignore_errors=True)


async def _run_metadata_job(job_id: str, magnet: str, info_hash_value: str) -> None:
    """Resolve metadata in parallel so a slow DHT lookup cannot block a faster resolver."""
    job = _metadata_jobs[job_id]
    job["status"] = "resolving"

    async def resolve_libtorrent() -> dict[str, Any] | None:
        session = await _get_libtorrent_session()
        return await asyncio.to_thread(
            _metadata_from_libtorrent_sync,
            magnet,
            info_hash_value,
        )

    remote_task = asyncio.create_task(
        _fetch_remote_torrent_metadata(magnet, info_hash_value)
    )
    knaben_task = asyncio.create_task(_lookup_knaben_by_hash(info_hash_value))
    libtorrent_task = asyncio.create_task(resolve_libtorrent())

    tasks = (remote_task, knaben_task, libtorrent_task)
    errors: list[str] = []
    try:
        # Race independent metadata sources. This is important on Render:
        # DHT may have zero peers while the public metadata service or an
        # indexer already has the same torrent cached.
        for task in asyncio.as_completed(tasks):
            try:
                result = await task
            except TimeoutError as exc:
                errors.append(str(exc))
                continue
            except Exception as exc:
                errors.append(str(exc))
                continue

            if result and isinstance(result, dict) and result.get("files"):
                _metadata_cache[info_hash_value.lower()] = result
                _save_metadata_cache()
                job.update({"status": "ready", "result": result, "error": None})
                logger.info(
                    "Metadata job %s resolved via %s",
                    job_id,
                    result.get("source", "unknown"),
                )
                return

        message = errors[-1] if errors else "No metadata resolver returned a file list."
        job.update({"status": "error", "error": message})
        logger.warning("Metadata job %s failed: %s", job_id, message)
    finally:
        # The local libtorrent thread may continue after another resolver wins;
        # keep the shared session alive rather than cancelling it mid-operation.
        # Cancel only outstanding HTTP/indexer requests.
        for task in (remote_task, knaben_task):
            if not task.done():
                task.cancel()


_load_metadata_cache()


def seedr_data(value: Any) -> Any:
    if isinstance(value, dict) and "data" in value:
        return value["data"]
    return value

async def seedr_root_request() -> Any:
    """Fetch the Seedr account root using Seedr's dedicated root endpoint."""
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")

    url = "https://www.seedr.cc/api/folder"
    headers = {"Accept": "application/json"}
    params = {"access_token": SEEDR_TOKEN}

    async with httpx.AsyncClient(timeout=35, follow_redirects=True) as client:
        response = await client.get(url, headers=headers, params=params)

    raw = response.text
    try:
        data = response.json() if raw else None
    except Exception:
        data = raw

    if response.status_code >= 400:
        detail = raw
        if isinstance(data, dict):
            detail = (
                data.get("error_description")
                or data.get("reason_phrase")
                or data.get("message")
                or data.get("error")
                or raw
            )
        raise HTTPException(response.status_code, str(detail or "Seedr root request failed"))

    return data


async def seedr_request(path: str, method: str = "GET", body: Any = None, form: bool = False) -> Any:
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")
    url = SEEDR_BASE.rstrip("/") + "/" + str(path).lstrip("/")
    headers = {"Authorization": f"Bearer {SEEDR_TOKEN}", "Accept": "application/json"}
    kwargs: dict[str, Any] = {}
    if body is not None:
        if form:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            kwargs["data"] = body
        else:
            headers["Content-Type"] = "application/json"
            kwargs["json"] = body
    async with httpx.AsyncClient(timeout=35, follow_redirects=True) as client:
        response = await client.request(method, url, headers=headers, **kwargs)
    raw = response.text
    try:
        data = response.json() if raw else None
    except Exception:
        data = raw
    if response.status_code >= 400:
        detail = raw
        if isinstance(data, dict):
            detail = data.get("error_description") or data.get("reason_phrase") or data.get("message") or data.get("error") or raw
        raise HTTPException(response.status_code, str(detail or "Seedr API request failed"))
    if isinstance(data, dict):
        soft = str(data.get("reason_phrase") or "").strip().lower()
        if soft == "not_enough_space":
            raise HTTPException(413, "Not enough storage space in your Seedr account.")
    return data

def arr(value: Any, keys: tuple[str, ...]) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in keys:
            if isinstance(value.get(key), list):
                return value[key]
    return []

def unwrap_seedr_task(value: Any) -> dict[str, Any]:
    """Normalize task responses that may be wrapped in data/task objects."""
    current = value
    for _ in range(4):
        if not isinstance(current, dict):
            return {}
        nested = current.get("task")
        if isinstance(nested, dict):
            current = nested
            continue
        return current
    return current if isinstance(current, dict) else {}


def seedr_task_folder_id(task: dict[str, Any]) -> str:
    nested_torrent = task.get("torrent") if isinstance(task.get("torrent"), dict) else {}
    payload = task.get("torrent_payload") if isinstance(task.get("torrent_payload"), dict) else {}

    return str(
        task.get("folder_created_id")
        or task.get("folder_created")
        or task.get("folder_id")
        or task.get("folderId")
        or nested_torrent.get("folder_created_id")
        or nested_torrent.get("folder_id")
        or nested_torrent.get("folderId")
        or payload.get("folder_created_id")
        or payload.get("folder_id")
        or payload.get("folderId")
        or ""
    ).strip()


def magnet_display_name(value: Any) -> str:
    """Extract the torrent display name (dn) from a magnet-like value."""
    raw = str(value or "").strip()
    if not raw.lower().startswith("magnet:?"):
        return ""
    try:
        params = parse_qs(urlsplit(raw).query, keep_blank_values=True)
        return str((params.get("dn") or [""])[0]).strip()
    except Exception:
        return ""


def seedr_task_name(task: dict[str, Any]) -> str:
    nested_torrent = task.get("torrent") if isinstance(task.get("torrent"), dict) else {}
    payload = task.get("torrent_payload") if isinstance(task.get("torrent_payload"), dict) else {}
    meta = task.get("meta") if isinstance(task.get("meta"), dict) else {}
    nested_link = (
        task.get("torrent_magnet")
        or task.get("magnet")
        or task.get("magnet_url")
        or nested_torrent.get("torrent_magnet")
        or nested_torrent.get("magnet")
        or payload.get("torrent_magnet")
        or payload.get("magnet")
        or ""
    )
    magnet_name = magnet_display_name(nested_link)

    # A magnet's dn is the closest match to the title the user selected from
    # search. Prefer it before Seedr's own generated/provider title.
    return str(
        task.get("torrent_name")
        or magnet_name
        or nested_torrent.get("torrent_name")
        or payload.get("torrent_name")
        or task.get("torrent_title")
        or task.get("torrentTitle")
        or nested_torrent.get("title")
        or nested_torrent.get("name")
        or payload.get("title")
        or payload.get("name")
        or task.get("title")
        or task.get("name")
        or meta.get("torrent_name")
        or meta.get("title")
        or ""
    ).strip()


def normalize_magnet(magnet: str) -> str:
    """Normalize the BTIH while preserving the magnet's tracker and name parameters."""
    value = re.sub(r"[\r\n\t]+", "", str(magnet or "").strip())
    decoded = unquote(value)
    if decoded.lower().startswith("magnet:?"):
        value = decoded
    if not value.lower().startswith("magnet:?"):
        return value

    try:
        parsed = urlsplit(value)
        params = parse_qs(parsed.query, keep_blank_values=True)
        valid_hash = ""
        for raw in params.get("xt", []):
            raw = unquote(raw)
            match = re.fullmatch(r"urn:btih:([A-Za-z0-9]{32,40})", raw, re.I)
            if not match:
                continue
            candidate = match.group(1)
            if len(candidate) == 32:
                candidate = base64.b32decode(
                    candidate.upper() + "=" * ((8 - len(candidate) % 8) % 8)
                ).hex()
            if len(candidate) == 40 and re.fullmatch(r"[0-9a-fA-F]{40}", candidate):
                valid_hash = candidate.lower()
                break

        if not valid_hash:
            return value

        # Keep the human-readable name and all supplied trackers. Some
        # metadata-only peers are reachable only through the trackers present
        # in the original magnet.
        rebuilt: list[tuple[str, str]] = [("xt", "urn:btih:" + valid_hash)]
        for key in ("dn", "tr"):
            for item in params.get(key, []):
                text_value = str(item or "").strip()
                if text_value:
                    rebuilt.append((key, text_value))

        return "magnet:?" + urlencode(rebuilt, doseq=True)
    except Exception:
        return value

def info_hash(magnet: str) -> str:
    for _ in range(3):
        m = re.search(r"(?:urn:btih:|btih:)([A-Za-z0-9]{32,40})", magnet, re.I)
        if m:
            h = m.group(1)
            if len(h) == 40 and re.fullmatch(r"[0-9a-fA-F]{40}", h):
                return h.lower()
            if len(h) == 32:
                try:
                    return base64.b32decode(h.upper() + "=" * ((8-len(h)%8)%8)).hex()
                except Exception:
                    pass
        magnet = unquote(magnet)
    return ""

def task_id(task: dict[str, Any]) -> str:
    return str(task.get("user_torrent_id") or task.get("id") or task.get("task_id") or "").strip()

def task_hash(task: dict[str, Any]) -> str:
    for key in ("hash", "torrent_hash", "info_hash"):
        value = str(task.get(key) or "").strip()
        h = info_hash(value) if value else ""
        if h:
            return h
        if re.fullmatch(r"[0-9a-fA-F]{40}", value):
            return value.lower()
    payload = task.get("torrent_payload")
    if isinstance(payload, dict):
        value = str(payload.get("hash") or "").strip()
        if re.fullmatch(r"[0-9a-fA-F]{40}", value):
            return value.lower()
    return ""

def task_complete(task: dict[str, Any]) -> bool:
    state = str(task.get("state") or task.get("status") or "").lower()
    try:
        progress = float(task.get("progress") or 0)
    except Exception:
        progress = 0
    return state in {"finished", "completed", "complete", "seeding", "stopped", "idle"} or progress >= 100

async def find_task_by_hash(h: str) -> dict[str, Any] | None:
    payload = seedr_data(await seedr_request("/tasks"))
    for raw in arr(payload, ("tasks", "torrents", "items")):
        task = unwrap_seedr_task(seedr_data(raw))
        if not task or task_hash(task) != h:
            continue
        if task_complete(task):
            folder = seedr_task_folder_id(task)
            if not folder:
                continue
            try:
                contents = seedr_data(await seedr_request(f"/fs/folder/{quote(folder)}/contents"))
                if not arr(contents, ("files", "items")) and not arr(contents, ("folders", "directories")):
                    continue
            except HTTPException as exc:
                if exc.status_code == 404:
                    continue
                raise
        return task
    return None

async def rename_seedr_folder(folder_id: str, name: str) -> bool:
    """Best-effort rename of a Seedr folder to the canonical torrent name."""
    folder_id = str(folder_id or "").strip()
    name = str(name or "").strip()
    if not folder_id or not name:
        return False

    safe_name = name[:255]
    # Seedr documentation lists rename_to, while its example uses name.
    # Try the documented form first, then the example form.
    for body in (
        {"rename_to": safe_name},
        {"name": safe_name},
    ):
        try:
            await seedr_request(
                f"/fs/folder/{quote(folder_id)}/rename",
                "POST",
                body,
                form=True,
            )
            return True
        except HTTPException as exc:
            if exc.status_code in (400, 404, 405):
                continue
            logger.info("Seedr folder rename failed for %s: HTTP %s", folder_id, exc.status_code)
            return False
        except Exception as exc:
            logger.info("Seedr folder rename failed for %s: %s", folder_id, exc)
            return False
    return False


async def add_task(magnet: str, folder_id: int) -> dict[str, Any]:
    normalized = normalize_magnet(magnet)
    try:
        result = seedr_data(await seedr_request("/tasks", "POST", {"torrent_magnet": normalized, "folder_id": folder_id}, form=True))
        if isinstance(result, dict):
            return result
    except HTTPException as exc:
        h = info_hash(normalized)
        if exc.status_code == 400 and h:
            result = seedr_data(await seedr_request("/tasks", "POST", {"torrent_magnet": f"magnet:?xt=urn:btih:{h}", "folder_id": folder_id}, form=True))
            if isinstance(result, dict):
                return result
        raise
    raise HTTPException(502, "Seedr did not return a valid task response")

def normalize_file(item: Any, folder_id: str = "") -> dict[str, Any]:
    if not isinstance(item, dict):
        return {"id": "", "name": "Unnamed file", "size": 0, "folderId": folder_id}
    return {
        "id": str(item.get("id") or item.get("file_id") or ""),
        # Seedr V2 presentation endpoints use the canonical file id.
        # Keep legacy folder_file_id only as a fallback for older API shapes.
        "streamId": str(
            item.get("id")
            or item.get("file_id")
            or item.get("folder_file_id")
            or item.get("folderFileId")
            or ""
        ),
        "name": str(item.get("name") or item.get("title") or "Unnamed file"),
        "size": int(float(item.get("size") or 0)),
        "folderId": str(item.get("folder_id") or item.get("folderId") or folder_id),
    }

async def task_contents(tid: str) -> list[dict[str, Any]]:
    payload = seedr_data(await seedr_request(f"/tasks/{quote(tid)}/contents"))
    if not isinstance(payload, dict):
        return []
    files = [normalize_file(x, str(payload.get("folder_created_id") or "")) for x in arr(payload, ("files", "items"))]
    folder = str(payload.get("folder_created_id") or "").strip()
    if folder and (not files or any(not x["id"] for x in files)):
        try:
            folder_payload = seedr_data(await seedr_request(f"/fs/folder/{quote(folder)}/contents"))
            folder_files = arr(folder_payload, ("files", "items"))
            if folder_files:
                files = [normalize_file(x, folder) for x in folder_files]
        except HTTPException:
            pass
    return files

async def folder_name(folder_id: str) -> str:
    for endpoint in (f"/fs/folder/{quote(folder_id)}", f"/fs/folder/{quote(folder_id)}/contents"):
        try:
            payload = seedr_data(await seedr_request(endpoint))
            if isinstance(payload, dict):
                for key in ("name", "title", "folder_name", "folderName", "path"):
                    value = str(payload.get(key) or "").strip()
                    if value:
                        return Path(value.rstrip("/")).name
                for key in ("folder", "directory"):
                    child = payload.get(key)
                    if isinstance(child, dict):
                        for name_key in ("name", "title", "folder_name", "folderName", "path"):
                            value = str(child.get(name_key) or "").strip()
                            if value:
                                return Path(value.rstrip("/")).name
        except HTTPException:
            continue
    return ""

SEEDR_FOLDER_CONCURRENCY = 8
_seedr_folder_semaphore = asyncio.Semaphore(SEEDR_FOLDER_CONCURRENCY)

# Library metadata is shared between the Files explorer and the Seedr Library
# so opening the Files tab does not trigger the same Seedr tree walk twice.
SEEDR_METADATA_CACHE_SECONDS = 5
SEEDR_FOLDER_CACHE_SECONDS = 15
_seedr_metadata_cache: tuple[float, dict[str, Any]] | None = None
_seedr_metadata_task: asyncio.Task | None = None
_seedr_folder_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_seedr_torrent_names: dict[str, str] = {}
_seedr_torrent_names_by_task: dict[str, str] = {}

SEEDR_AUTO_DELETE_SECONDS = 2 * 60 * 60
SEEDR_CLEANUP_FILE = Path("/app/.seedr_cleanup.json")
_seedr_cleanup_jobs: dict[str, dict[str, Any]] = {}
_seedr_cleanup_worker_task: asyncio.Task | None = None


def _load_seedr_cleanup_jobs() -> None:
    global _seedr_cleanup_jobs
    try:
        raw = SEEDR_CLEANUP_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, dict):
            _seedr_cleanup_jobs = {
                str(k): v for k, v in data.items()
                if isinstance(v, dict) and float(v.get("deleteAt") or 0) > 0
            }
    except Exception:
        _seedr_cleanup_jobs = {}


def _save_seedr_cleanup_jobs() -> None:
    try:
        SEEDR_CLEANUP_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SEEDR_CLEANUP_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_seedr_cleanup_jobs, separators=(",", ":")), encoding="utf-8")
        tmp.replace(SEEDR_CLEANUP_FILE)
    except Exception as exc:
        logger.info("Could not persist Seedr cleanup schedule: %s", exc)


def schedule_seedr_cleanup(
    task_id_value: str,
    torrent_name: str,
    folder_id: str = "",
    added_at: float | None = None,
) -> None:
    tid = str(task_id_value or "").strip()
    if not tid:
        return

    now = time.time()
    started = float(added_at or now)
    _seedr_cleanup_jobs[tid] = {
        "taskId": tid,
        "torrentName": str(torrent_name or "").strip() or f"Torrent {tid}",
        "folderId": str(folder_id or "").strip(),
        "addedAt": started,
        "deleteAt": started + SEEDR_AUTO_DELETE_SECONDS,
    }
    _save_seedr_cleanup_jobs()


async def _cleanup_seedr_job(tid: str, job: dict[str, Any]) -> bool:
    folder_id = str(job.get("folderId") or "").strip()
    torrent_name = str(job.get("torrentName") or f"Torrent {tid}").strip()

    # Seedr may expose the folder only after the task starts.
    if not folder_id:
        try:
            raw = seedr_data(await seedr_request(f"/tasks/{quote(tid)}"))
            task = unwrap_seedr_task(raw)
            folder_id = seedr_task_folder_id(task)
            if folder_id:
                job["folderId"] = folder_id
                _save_seedr_cleanup_jobs()
        except HTTPException as exc:
            if exc.status_code == 404:
                _seedr_cleanup_jobs.pop(tid, None)
                _save_seedr_cleanup_jobs()
                return True
            return False
        except Exception:
            return False

    if not folder_id or not folder_id.isdigit() or folder_id == SEEDR_LIBRARY_FOLDER_ID:
        return False

    # Stop the Seedr task first so an active transfer cannot keep rebuilding
    # files while the folder is being removed.
    try:
        await seedr_request(f"/tasks/{quote(tid)}", "DELETE")
    except HTTPException as exc:
        if exc.status_code != 404:
            logger.info("Seedr task cleanup failed for %s: HTTP %s", tid, exc.status_code)
            return False
    except Exception as exc:
        logger.info("Seedr task cleanup failed for %s: %s", tid, exc)
        return False

    try:
        await seedr_folder_delete(folder_id)
    except HTTPException as exc:
        if exc.status_code != 404:
            logger.info("Seedr folder cleanup failed for %s (%s): HTTP %s", torrent_name, folder_id, exc.status_code)
            return False
    except Exception as exc:
        logger.info("Seedr folder cleanup failed for %s (%s): %s", torrent_name, folder_id, exc)
        return False

    _seedr_cleanup_jobs.pop(tid, None)
    _save_seedr_cleanup_jobs()
    logger.info("Auto-deleted Seedr torrent after 2 hours: %s (task=%s folder=%s)", torrent_name, tid, folder_id)
    return True


async def _seedr_cleanup_worker() -> None:
    while True:
        try:
            now = time.time()
            due = [
                (tid, job)
                for tid, job in list(_seedr_cleanup_jobs.items())
                if float(job.get("deleteAt") or 0) <= now
            ]
            for tid, job in due:
                await _cleanup_seedr_job(tid, job)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.info("Seedr cleanup worker error: %s", exc)
        await asyncio.sleep(30)



async def collect_folder(folder_id: str, path: str = "/", depth: int = 0) -> list[dict[str, Any]]:
    if depth > 8:
        return []

    async with _seedr_folder_semaphore:
        try:
            payload = seedr_data(await seedr_request(f"/fs/folder/{quote(folder_id)}/contents"))
        except HTTPException as exc:
            if exc.status_code == 404:
                return []
            raise

    if not isinstance(payload, dict):
        return []

    files: list[dict[str, Any]] = []
    for raw in arr(payload, ("files", "items")):
        item = normalize_file(raw, folder_id)
        item["folderPath"] = path
        item["url"] = None
        files.append(item)

    child_jobs: list[asyncio.Future] = []
    for raw in arr(payload, ("folders", "directories")):
        child_id = str(raw.get("id") or raw.get("folder_id") or "") if isinstance(raw, dict) else ""
        if not child_id:
            continue

        child_name = (
            str(raw.get("name") or raw.get("title") or child_id)
            if isinstance(raw, dict)
            else child_id
        )
        child_path = path.rstrip("/") + "/" + child_name
        child_jobs.append(collect_folder(child_id, child_path, depth + 1))

    if child_jobs:
        children = await asyncio.gather(*child_jobs, return_exceptions=True)
        for child in children:
            if isinstance(child, list):
                files.extend(child)

    return files

def _safe_download_filename(filename: str, fallback: str) -> str:
    value = str(filename or "").strip().replace("\r", "").replace("\n", "")
    value = re.sub(r'[\\/:*?"<>|]+', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value[:240] or fallback


async def _stream_seedr_download(url: str):
    client = httpx.AsyncClient(timeout=None, follow_redirects=True)
    request = client.build_request("GET", url, headers={"Accept": "*/*"})
    response = await client.send(request, stream=True)

    if response.status_code >= 400:
        try:
            detail = (await response.aread()).decode("utf-8", errors="replace")[:500]
        finally:
            await response.aclose()
            await client.aclose()
        raise HTTPException(response.status_code, detail or "Seedr download request failed")

    content_type = response.headers.get("content-type") or "application/octet-stream"
    content_length = response.headers.get("content-length")
    content_range = response.headers.get("content-range")

    async def body():
        try:
            async for chunk in response.aiter_bytes(1024 * 1024):
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    headers = {
        "Content-Disposition": "",
        "Accept-Ranges": response.headers.get("accept-ranges", "bytes"),
        "Cache-Control": "no-store",
    }
    if content_length:
        headers["Content-Length"] = content_length
    if content_range:
        headers["Content-Range"] = content_range

    return body, content_type, headers


async def download_url(file_id: str) -> dict[str, str]:
    payload = seedr_data(await seedr_request(f"/download/file/{quote(file_id)}/url"))
    if isinstance(payload, dict):
        url = str(payload.get("url") or payload.get("download_url") or payload.get("downloadUrl") or payload.get("direct_url") or "")
        name = str(payload.get("name") or payload.get("filename") or "")
    else:
        url, name = str(payload or ""), ""
    if not url:
        raise HTTPException(502, "Seedr did not return a download URL")
    return {"url": url, "name": name}

def _srt_to_webvtt(text: str) -> str:
    """Convert a UTF-8/legacy SRT subtitle into browser-compatible WebVTT."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    lines = normalized.split("\n")
    output = ["WEBVTT", ""]
    for line in lines:
        if "-->" in line:
            line = re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", line)
        output.append(line)
    result = "\n".join(output)
    return result if result.endswith("\n") else result + "\n"


async def _seedr_subtitle_text(file_id: str, filename: str) -> tuple[str, str]:
    result = await download_url(file_id)
    url = result["url"]
    lower = (filename or result.get("name") or "").lower()
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
        raw = response.content

    if lower.endswith(".vtt"):
        text = raw.decode("utf-8-sig", errors="replace")
        if not text.lstrip().startswith("WEBVTT"):
            text = _srt_to_webvtt(text)
    elif lower.endswith(".srt"):
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("cp1252", errors="replace")
        text = _srt_to_webvtt(text)
    else:
        raise HTTPException(415, "Only SRT and WebVTT subtitle files are supported")
    return text, "text/vtt; charset=utf-8"


@app.get("/api/seedr/files/{file_id}/subtitle")
async def seedr_file_subtitle(
    file_id: str,
    filename: str = Query(""),
):
    """Proxy a Seedr SRT/VTT file as WebVTT for the browser <track> element."""
    text, content_type = await _seedr_subtitle_text(file_id, filename)
    return Response(
        content=text,
        media_type=content_type,
        headers={"Cache-Control": "private, max-age=300"},
    )


OPEN_SUBTITLES_API_KEY = os.getenv("OPENSUBTITLES_API_KEY", "").strip()
OPEN_SUBTITLES_API_URL = "https://api.opensubtitles.com/api/v1"
OPEN_SUBTITLES_USER_AGENT = os.getenv("OPENSUBTITLES_USER_AGENT", "Torrent-Studio v1.0").strip() or "Torrent-Studio v1.0"
_downloaded_subtitles: dict[str, tuple[float, str, str]] = {}


async def _opensubtitles_request(method: str, path: str, *, params: dict[str, str] | None = None, json_body: dict[str, Any] | None = None) -> Any:
    if not OPEN_SUBTITLES_API_KEY:
        raise HTTPException(503, "OpenSubtitles is not configured. Add OPENSUBTITLES_API_KEY to Render.")
    headers = {"Api-Key": OPEN_SUBTITLES_API_KEY, "User-Agent": OPEN_SUBTITLES_USER_AGENT, "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=25, follow_redirects=True) as client:
        response = await client.request(method, OPEN_SUBTITLES_API_URL + path, params=params, json=json_body, headers=headers)
    if response.status_code >= 400:
        detail = response.text[:500] or f"OpenSubtitles HTTP {response.status_code}"
        try:
            body = response.json()
            detail = str(body.get("message") or body.get("error") or detail)
        except Exception:
            pass
        raise HTTPException(response.status_code, detail)
    try:
        return response.json()
    except Exception as exc:
        raise HTTPException(502, "OpenSubtitles returned an invalid response") from exc


@app.get("/api/subtitles/search")
async def search_subtitles(query: str = Query(..., min_length=1, max_length=300), language: str = Query("en", max_length=10)):
    payload = await _opensubtitles_request(
        "GET", "/subtitles",
        params={"query": query.strip(), "languages": language.strip().lower() or "en", "order_by": "download_count", "order_direction": "desc"},
    )
    results = []
    for item in payload.get("data", []) if isinstance(payload, dict) else []:
        if not isinstance(item, dict):
            continue
        attrs = item.get("attributes") or {}
        files = attrs.get("files") or []
        first_file = files[0] if isinstance(files, list) and files else {}
        if not isinstance(first_file, dict):
            first_file = {}
        file_id = str(first_file.get("file_id") or "").strip()
        if not file_id:
            continue
        results.append({
            "fileId": file_id,
            "language": str(attrs.get("language") or language or "en"),
            "release": str(attrs.get("release") or ((attrs.get("feature_details") or {}).get("movie_name")) or "Subtitle"),
            "downloads": int(attrs.get("download_count") or 0),
            "format": str(attrs.get("format") or first_file.get("format") or "srt"),
            "hearingImpaired": bool(attrs.get("hearing_impaired")),
        })
        if len(results) >= 20:
            break
    return {"results": results}


@app.post("/api/subtitles/download")
async def download_subtitle(payload: dict[str, Any]):
    file_id = str(payload.get("fileId") or "").strip()
    if not file_id:
        raise HTTPException(400, "Subtitle file id is required")
    result = await _opensubtitles_request("POST", "/download", json_body={"file_id": int(file_id) if file_id.isdigit() else file_id})
    link = str(result.get("link") or result.get("url") or "").strip()
    if not link:
        raise HTTPException(502, "OpenSubtitles did not return a subtitle download link")
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        response = await client.get(link, headers={"Api-Key": OPEN_SUBTITLES_API_KEY, "User-Agent": OPEN_SUBTITLES_USER_AGENT})
    if response.status_code >= 400:
        raise HTTPException(response.status_code, "Could not retrieve the downloaded subtitle")
    raw = response.content
    filename = str(result.get("file_name") or result.get("filename") or "subtitle.srt")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")
    if not text.lstrip().startswith("WEBVTT"):
        text = _srt_to_webvtt(text)
    token = base64.urlsafe_b64encode(os.urandom(18)).decode("ascii").rstrip("=")
    _downloaded_subtitles[token] = (time.time() + 900, text, filename)
    return {"url": "/api/subtitles/content/" + token, "language": str(result.get("language") or "en"), "title": filename.rsplit("/", 1)[-1], "format": "vtt"}


@app.get("/api/subtitles/content/{token}")
async def subtitle_content(token: str):
    item = _downloaded_subtitles.get(token)
    if not item:
        raise HTTPException(404, "Subtitle expired")
    expires_at, text, _filename = item
    if expires_at <= time.time():
        _downloaded_subtitles.pop(token, None)
        raise HTTPException(404, "Subtitle expired")
    return Response(content=text, media_type="text/vtt; charset=utf-8", headers={"Cache-Control": "private, max-age=300"})


def _search_tokens(value: str) -> list[str]:
    return [token for token in re.findall(r"[a-z0-9]+", value.lower()) if token]


def _media_search_parts(value: str) -> tuple[str, int | None, int | None]:
    """Split a media query into title text plus optional season/episode constraints."""
    q = re.sub(r"\s+", " ", value.strip())
    season_match = re.search(r"\b(?:season|series)\s*(\d{1,2})\b", q, re.I)
    episode_match = re.search(r"\bS(\d{1,2})(?:E(\d{1,3}))?\b", q, re.I)
    season = int(season_match.group(1)) if season_match else (
        int(episode_match.group(1)) if episode_match else None
    )
    episode = (
        int(season_match.group(1)) if False else None
    )
    if episode_match and episode_match.group(2):
        episode = int(episode_match.group(2))

    title = q
    title = re.sub(r"\b(?:season|series)\s*\d{1,2}\b", " ", title, flags=re.I)
    title = re.sub(r"\bS\d{1,2}(?:E\d{1,3})?\b", " ", title, flags=re.I)
    title = re.sub(
        r"\b(?:19|20)\d{2}\b|"
        r"\b(?:2160p|1440p|1080p|720p|480p|4k|8k)\b|"
        r"\b(?:webrip|web-dl|bluray|brrip|x264|x265|h264|h265|hevc|hdr)\b",
        " ",
        title,
        flags=re.I,
    )
    title = re.sub(r"\s+", " ", title).strip()
    return title, season, episode


def _season_episode_match(title: str, season: int | None, episode: int | None) -> bool:
    if season is None:
        return True

    upper = title.upper()
    match = re.search(r"\bS(\d{1,2})(?:E(\d{1,3}))?\b", upper)
    if match:
        if int(match.group(1)) != season:
            return False
        if episode is not None and (not match.group(2) or int(match.group(2)) != episode):
            return False
        return True

    season_word = re.search(r"\bSEASON[\s._-]*(\d{1,2})\b", upper)
    if season_word:
        if int(season_word.group(1)) != season:
            return False
        return episode is None

    return False


def _tvmaze_query(value: str) -> str:
    value = re.sub(r"\bS\d{1,2}(?:E\d{1,3})?.*$", "", value, flags=re.I)
    value = re.sub(r"\b(?:season|series)\s*\d+\b", "", value, flags=re.I)
    value = re.sub(r"\b(?:19|20)\d{2}\b", "", value)
    return re.sub(r"\s+", " ", value).strip()


def _normalize_title(value: str) -> str:
    return " ".join(_search_tokens(value))


X1337_HOSTS = [
    "1337x.to",
    "1337x.st",
    "x1337x.ws",
    "x1337x.eu",
    "x1337x.cc",
]


def _x1337_rows(html_text: str) -> list[dict[str, str]]:
    """Parse the 1337x search table without requiring the source's API."""
    start = html_text.find("table-list")
    if start < 0:
        return []

    rows: list[dict[str, str]] = []
    for tr in html_text[start:].split("<tr")[1:]:
        link_match = re.search(
            r'href="(/torrent/[^"]+)"[^>]*>([^<]+)</a>',
            tr,
            re.IGNORECASE,
        )
        if not link_match:
            continue
        size_match = re.search(
            r'class="coll-4 size[^"]*">\s*([\d.]+\s*[KMGT]i?B)',
            tr,
            re.IGNORECASE,
        )
        seeds_match = re.search(
            r'class="coll-2 seeds[^"]*">\s*([\d,]+)',
            tr,
            re.IGNORECASE,
        )
        leech_match = re.search(
            r'class="coll-3 leeches[^"]*">\s*([\d,]+)',
            tr,
            re.IGNORECASE,
        )
        rows.append({
            "title": BeautifulSoup(
                html.unescape(link_match.group(2).strip()), "html.parser"
            ).get_text(" ", strip=True),
            "path": link_match.group(1),
            "size": size_match.group(1) if size_match else "0 B",
            "seeders": (seeds_match.group(1).replace(",", "") if seeds_match else "0"),
            "leechers": (leech_match.group(1).replace(",", "") if leech_match else "0"),
        })
    return rows


async def search_1337x_direct(query: str, limit: int = 30) -> list[dict[str, Any]]:
    """Search 1337x using working hosts, with detail-page magnet resolution."""
    q, season, episode = _media_search_parts(query)
    if not q:
        return []

    encoded = quote(q, safe="").replace("%20", "+")
    paths = [
        f"/search/{encoded}/1/",
        f"/category-search/{encoded}/Movies/1/",
        f"/category-search/{encoded}/TV/1/",
    ]

    listing_html = ""
    base = ""
    used_path = ""
    async with httpx.AsyncClient(
        timeout=12,
        follow_redirects=True,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/126.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    ) as client:
        for host in X1337_HOSTS:
            for path in paths:
                try:
                    response = await client.get(f"https://{host}{path}")
                    if response.status_code >= 400:
                        continue
                    if "table-list" not in response.text:
                        continue
                    listing_html = response.text
                    base = f"https://{host}"
                    used_path = path
                    break
                except httpx.HTTPError:
                    continue
            if listing_html:
                break

        if not listing_html:
            return []

        candidates = _x1337_rows(listing_html)
        tokens = _search_tokens(q)
        candidates = [
            row for row in candidates
            if all(token in _normalize_title(row["title"]) for token in tokens)
            and _season_episode_match(row["title"], season, episode)
        ][: min(max(limit, 1), 30)]

        async def fetch_detail(row: dict[str, str]) -> dict[str, Any] | None:
            try:
                response = await client.get(base + row["path"])
                response.raise_for_status()
            except httpx.HTTPError:
                return None

            match = re.search(
                r"magnet:\?xt=urn:btih:[^\"'<>\s]+",
                response.text,
                re.IGNORECASE,
            )
            if not match:
                return None

            magnet = html.unescape(match.group(0))
            try:
                size_text = row["size"]
                size_match = re.match(
                    r"([\d.]+)\s*([KMGT]i?B)",
                    size_text,
                    re.IGNORECASE,
                )
                units = {"KB": 1024, "KIB": 1024, "MB": 1024**2, "MIB": 1024**2,
                         "GB": 1024**3, "GIB": 1024**3, "TB": 1024**4, "TIB": 1024**4}
                size = int(float(size_match.group(1)) * units[size_match.group(2).upper()]) if size_match else 0
            except Exception:
                size = 0

            return {
                "guid": f"1337x-{info_hash(magnet) or row['path']}",
                "title": row["title"],
                "size": size,
                "seeders": int(row["seeders"] or 0),
                "leechers": int(row["leechers"] or 0),
                "indexer": "1337x",
                "protocol": "torrent",
                "publishDate": "",
                "magnetUrl": magnet,
                "infoHash": info_hash(magnet),
                "downloadUrl": magnet,
                "infoUrl": base + row["path"],
                "sourceUrl": base + row["path"],
                "category": "Video",
            }

        fetched = await asyncio.gather(*(fetch_detail(row) for row in candidates), return_exceptions=True)

    results = [item for item in fetched if isinstance(item, dict)]
    logger.info("1337x direct search '%s': %d results via %s", query, len(results), used_path)
    return results


async def search_yts_movies(query: str, limit: int = 50) -> list[dict[str, Any]]:
    """Search YTS directly so movie searches are not lost in aggregate ranking."""
    movie_query = re.sub(
        r"\b(?:19|20)\d{2}\b|\b(?:2160p|1440p|1080p|720p|480p|4k|8k)\b|\b(?:webrip|web-dl|bluray|brrip|x264|x265|h264|h265|hevc|hdr)\b",
        " ",
        query,
        flags=re.I,
    )
    movie_query = re.sub(r"\s+", " ", movie_query).strip()
    if not movie_query:
        return []

    payload = None
    async with httpx.AsyncClient(timeout=12, follow_redirects=True) as client:
        for host in ("yts.mx", "yts.am", "yts.rs"):
            try:
                response = await client.get(
                    f"https://{host}/api/v2/list_movies.json",
                    params={"query_term": movie_query, "limit": "50"},
                    headers={"Accept": "application/json"},
                )
                response.raise_for_status()
                parsed = response.json()
                if isinstance(parsed, dict):
                    payload = parsed
                    break
            except (httpx.HTTPError, ValueError):
                continue

    if not isinstance(payload, dict):
        return []

    target_tokens = _search_tokens(movie_query)
    results: list[dict[str, Any]] = []
    for movie in (payload.get("data") or {}).get("movies") or []:
        if not isinstance(movie, dict):
            continue
        title = str(movie.get("title_long") or movie.get("title") or "").strip()
        if not title:
            continue
        title_tokens = _normalize_title(title)
        if target_tokens and not all(token in title_tokens for token in target_tokens):
            continue

        released = movie.get("date_uploaded_unix")
        try:
            from datetime import datetime, timezone
            published = datetime.fromtimestamp(
                int(released), tz=timezone.utc
            ).isoformat() if released else ""
        except Exception:
            published = ""

        for torrent in movie.get("torrents") or []:
            if not isinstance(torrent, dict):
                continue
            h = str(torrent.get("hash") or "").strip().lower()
            if not re.fullmatch(r"[0-9a-f]{40}", h):
                continue
            quality = str(torrent.get("quality") or "").strip()
            kind = str(torrent.get("type") or "").strip()
            suffix = " ".join(x for x in (quality, kind) if x)
            display_title = f"{title} [{suffix}]" if suffix else title
            magnet = (
                f"magnet:?xt=urn:btih:{h}&dn={quote(display_title, safe='')}"
            )
            for tracker in (
                "udp://tracker.opentrackr.org:1337/announce",
                "udp://open.stealth.si:80/announce",
            ):
                magnet += "&tr=" + quote(tracker, safe="")

            results.append({
                "guid": f"yts-{h}",
                "title": display_title,
                "size": int(float(torrent.get("size_bytes") or 0)),
                "seeders": int(torrent.get("seeds") or 0),
                "leechers": int(torrent.get("peers") or 0),
                "indexer": "yts.mx",
                "protocol": "torrent",
                "publishDate": published,
                "magnetUrl": magnet,
                "infoHash": h,
                "downloadUrl": magnet,
                "infoUrl": "",
                "sourceUrl": "",
            })

    results.sort(
        key=lambda row: (row["seeders"] + row["leechers"], row["publishDate"]),
        reverse=True,
    )
    return results[:limit]


async def search_tv_eztv(query: str, limit: int = 30) -> list[dict[str, Any]]:
    tv_query, _season, _episode = _media_search_parts(query)
    tv_query = _tvmaze_query(tv_query)
    if not tv_query:
        return []

    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=True) as client:
            response = await client.get(
                "https://api.tvmaze.com/search/shows",
                params={"q": tv_query},
                headers={"Accept": "application/json"},
            )
            response.raise_for_status()
            matches = response.json()
    except (httpx.HTTPError, ValueError):
        return []

    if not isinstance(matches, list):
        return []

    target = _normalize_title(tv_query)
    imdb_id = ""
    for match in matches[:10]:
        show = match.get("show") if isinstance(match, dict) else None
        if not isinstance(show, dict):
            continue
        name = str(show.get("name") or "").strip()
        external = show.get("externals")
        candidate = str(external.get("imdb") or "").strip() if isinstance(external, dict) else ""
        if candidate and _normalize_title(name) == target:
            imdb_id = candidate
            break

    if not imdb_id:
        return []

    payload: dict[str, Any] | None = None
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        for host in ("eztv.yt", "eztvx.to"):
            try:
                response = await client.get(
                    f"https://{host}/api/get-torrents",
                    params={"imdb_id": imdb_id, "limit": "100", "page": "1"},
                    headers={"Accept": "application/json"},
                )
                response.raise_for_status()
                parsed = response.json()
                if isinstance(parsed, dict):
                    payload = parsed
                    break
            except (httpx.HTTPError, ValueError):
                continue

    if not payload:
        return []

    results: list[dict[str, Any]] = []
    for item in payload.get("torrents") or []:
        if not isinstance(item, dict):
            continue
        h = str(item.get("hash") or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{40}", h):
            continue
        title = str(item.get("filename") or item.get("title") or "").strip()
        if not title:
            continue
        magnet = str(item.get("magnet_url") or "").strip()
        if not magnet:
            magnet = f"magnet:?xt=urn:btih:{h}&dn={quote(title, safe='')}"
        try:
            from datetime import datetime, timezone
            published = datetime.fromtimestamp(
                int(item.get("date_released_unix") or 0), tz=timezone.utc
            ).isoformat() if item.get("date_released_unix") else ""
        except Exception:
            published = ""
        results.append({
            "guid": f"eztv-{h}",
            "title": title,
            "size": int(float(item.get("size_bytes") or 0)),
            "seeders": int(item.get("seeds") or 0),
            "leechers": int(item.get("peers") or 0),
            "indexer": "eztv.yt",
            "protocol": "torrent",
            "publishDate": published,
            "magnetUrl": magnet,
            "infoHash": h,
            "downloadUrl": magnet,
            "infoUrl": "",
            "sourceUrl": "",
        })
    _, season, episode = _media_search_parts(query)
    if season is not None:
        results = [
            row for row in results
            if _season_episode_match(row["title"], season, episode)
        ]

    results.sort(
        key=lambda row: (row["seeders"] + row["leechers"], row["publishDate"]),
        reverse=True,
    )
    return results[:limit]


async def search_knaben(query: str, limit: int = 100) -> list[dict[str, Any]]:
    """Search Knaben with the same broad media query used by the former Vercel search route."""
    title_query, season, episode = _media_search_parts(query)
    if not title_query:
        return []

    target_tokens = _search_tokens(title_query)
    # Keep the full Knaben candidate pool. The previous working Vercel
    # implementation requested 300 before applying local filtering.
    request_size = 300

    body = {
        "search_type": "100%",
        "search_field": "title",
        "query": title_query,
        "order_by": "seeders",
        "order_direction": "desc",
        "from": 0,
        "size": request_size,
        "hide_unsafe": True,
        "hide_xxx": True,
        "seconds_since_last_seen": 604800,
    }

    try:
        async with httpx.AsyncClient(timeout=8.5) as client:
            response = await client.post(
                KNABEN_API_URL,
                json=body,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
            )
            response.raise_for_status()
            payload = response.json()
            logger.info(
                "Knaben HTTP %s for '%s': %d hits",
                response.status_code,
                query,
                len(payload.get("hits", [])) if isinstance(payload, dict) and isinstance(payload.get("hits"), list) else 0,
            )
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Knaben search failed for '%s': %s", query, exc)
        return []

    hits = payload.get("hits") if isinstance(payload, dict) else None
    if not isinstance(hits, list):
        return []

    results: list[dict[str, Any]] = []
    for hit in hits:
        if not isinstance(hit, dict):
            continue

        title = str(hit.get("title") or "").strip()
        category = str(hit.get("category") or "").strip()
        if not title:
            continue

        normalized_title = _normalize_title(title)
        if target_tokens and not all(token in normalized_title for token in target_tokens):
            continue
        if category and any(
            blocked in category.lower()
            for blocked in ("anime", "games", "music", "software", "books", "porn", "xxx", "adult")
        ):
            continue
        if category and not any(
            allowed in category.lower()
            for allowed in ("video", "movie", "tv", "television", "series")
        ):
            continue
        if season is not None and not _season_episode_match(title, season, episode):
            continue

        magnet = str(hit.get("magnetUrl") or "").strip()
        h = str(hit.get("hash") or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{40}", h):
            h = info_hash(magnet)

        results.append({
            "guid": f"knaben-{h or hit.get('id') or title}",
            "title": title,
            "size": int(hit.get("bytes") or 0),
            "seeders": int(hit.get("seeders") or 0),
            "leechers": int(hit.get("peers") or 0),
            "indexer": str(hit.get("cachedOrigin") or hit.get("tracker") or "Knaben").strip(),
            "protocol": "torrent",
            "publishDate": str(hit.get("date") or ""),
            "magnetUrl": magnet or None,
            "infoHash": h if re.fullmatch(r"[0-9a-f]{40}", h, re.I) else "",
            "downloadUrl": magnet or None,
            "infoUrl": str(hit.get("details") or ""),
            "sourceUrl": str(hit.get("details") or ""),
            "descriptorUrl": str(hit.get("link") or ""),
            "category": category,
        })

    target_text = _normalize_title(title_query)
    results.sort(
        key=lambda row: (
            1 if _normalize_title(str(row["title"])).startswith(target_text) else 0,
            int(row.get("seeders") or 0),
        ),
        reverse=True,
    )
    logger.info("Knaben search '%s': %d relevant results", query, len(results))
    return results[:limit]



async def search_1337x(query: str, limit: int = 50) -> list[dict[str, Any]]:
    """Broad torrent search: known-good Knaben first, aggregate Render search as fallback/supplement."""
    query = query.strip()
    if not query:
        return []

    limit = min(max(int(limit or 50), 1), 50)
    cache_key = (re.sub(r"\s+", " ", query).lower(), limit)
    now = asyncio.get_running_loop().time()
    cached = _search_cache.get(cache_key)
    if cached and now - cached[0] < SEARCH_CACHE_SECONDS:
        return cached[1]

    normalized_query, season, episode = _media_search_parts(query)
    normalized_query = normalized_query or query
    target_tokens = [
        token for token in _search_tokens(normalized_query)
        if token not in SEARCH_STOPWORDS
    ]

    async def aggregate_fallback() -> list[dict[str, Any]]:
        try:
            async with httpx.AsyncClient(timeout=8.5, follow_redirects=True) as client:
                response = await client.post(
                    f"{TORRENT_SEARCH_API_URL}/torrent/search",
                    params={
                        "query": normalized_query,
                        "max_items": 300,
                        "per_source": 50,
                    },
                    headers={"Accept": "application/json"},
                )
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            logger.info("Aggregate search fallback failed: %s", exc)
            return []

        if not isinstance(payload, list):
            return []

        results: list[dict[str, Any]] = []
        for item in payload:
            if not isinstance(item, dict):
                continue

            title = str(item.get("filename") or item.get("title") or "").strip()
            if not title:
                continue

            title_tokens = set(_search_tokens(title))
            if target_tokens and not all(token in title_tokens for token in target_tokens):
                continue
            if season is not None and not _season_episode_match(title, season, episode):
                continue

            category = str(item.get("category") or "").strip().lower()
            if category and any(
                blocked in category
                for blocked in ("anime", "games", "music", "software", "books", "porn", "xxx", "adult")
            ):
                continue
            if category and not any(
                allowed in category
                for allowed in ("video", "movie", "tv", "television", "series")
            ):
                continue

            magnet = str(item.get("magnet_link") or item.get("magnetUrl") or "").strip()
            h = info_hash(magnet)
            raw_hash = str(item.get("infoHash") or item.get("hash") or "").strip().lower()
            if not h and re.fullmatch(r"[0-9a-f]{40}", raw_hash):
                h = raw_hash

            results.append({
                "guid": str(item.get("guid") or item.get("id") or f"aggregate-{h or title}"),
                "title": title,
                "size": int(item.get("size") or 0) if isinstance(item.get("size"), (int, float)) else parse_size(str(item.get("size") or "")),
                "seeders": int(item.get("seeders") or 0),
                "leechers": int(item.get("leechers") or 0),
                "indexer": str(item.get("indexer") or item.get("source") or "torrent-search").strip(),
                "protocol": "torrent",
                "publishDate": str(item.get("publishDate") or item.get("date") or ""),
                "infoHash": h if re.fullmatch(r"[0-9a-f]{40}", h, re.I) else "",
                "magnetUrl": magnet or None,
                "downloadUrl": magnet or None,
                "infoUrl": str(item.get("infoUrl") or item.get("page_url") or ""),
                "sourceUrl": str(item.get("sourceUrl") or item.get("page_url") or ""),
                "descriptorUrl": str(
                    item.get("torrentUrl")
                    or item.get("torrent_url")
                    or item.get("descriptorUrl")
                    or ""
                ),
                "category": str(item.get("category") or ""),
            })

        return results

    # Knaben is the primary provider. Do not make every search wait for the
    # secondary Render-hosted aggregator; it has a separate network path and
    # can occasionally be slow or unavailable. Only use it when the primary
    # result set is too small.
    try:
        knaben_results = await search_knaben(query, limit=limit)
    except Exception as exc:
        logger.warning("Primary Knaben search failed for '%s': %s", query, exc)
        knaben_results = []

    aggregate_results: list[dict[str, Any]] = []
    if len(knaben_results) < limit:
        try:
            aggregate_results = await asyncio.wait_for(
                aggregate_fallback(),
                timeout=5.5,
            )
        except (asyncio.TimeoutError, Exception) as exc:
            logger.info("Secondary aggregate search skipped/failed for '%s': %s", query, exc)
            aggregate_results = []

    results: list[dict[str, Any]] = []
    seen: set[str] = set()

    # Preserve the known-good Knaben results first.
    for item in knaben_results:
        if not isinstance(item, dict):
            continue
        key = str(item.get("infoHash") or item.get("magnetUrl") or item.get("guid") or "").strip().lower()
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        results.append(item)
        if len(results) >= limit:
            break

    # Supplement missing results from the Render-hosted aggregate index.
    if len(results) < limit:
        for item in aggregate_results:
            if not isinstance(item, dict):
                continue
            key = str(item.get("infoHash") or item.get("magnetUrl") or item.get("guid") or "").strip().lower()
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            results.append(item)
            if len(results) >= limit:
                break

    results = results[:limit]
    _search_cache[cache_key] = (now, results)
    if len(_search_cache) > 100:
        oldest = min(_search_cache.items(), key=lambda pair: pair[1][0])[0]
        _search_cache.pop(oldest, None)

    logger.info(
        "Search '%s': %d results (Knaben=%d, aggregate=%d)",
        query,
        len(results),
        len(knaben_results),
        len(aggregate_results),
    )
    return results

def parse_size(value: str) -> int:
    m = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)", value or "", re.I)
    if not m:
        return 0
    n = float(m.group(1))
    units = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}
    return int(n * units[m.group(2).upper()])

@app.get("/")
async def root():
    return {"name": APP_NAME, "status": "ok"}

@app.on_event("startup")
async def start_seedr_cleanup_worker():
    global _seedr_cleanup_worker_task
    _load_seedr_cleanup_jobs()
    if _seedr_cleanup_worker_task is None or _seedr_cleanup_worker_task.done():
        _seedr_cleanup_worker_task = asyncio.create_task(_seedr_cleanup_worker())


@app.get("/health")
async def health():
    return {"status": "ok", "seedrConfigured": bool(SEEDR_TOKEN), "torrentSearchApi": TORRENT_SEARCH_API_URL}

@app.get("/api/search")
async def api_search(q: str = Query(..., min_length=1), limit: int = Query(50, ge=1, le=50)):
    return await search_1337x(q, limit)

@app.get("/api/seedr/quota")
async def seedr_quota():
    if not SEEDR_TOKEN:
        return {"configured": False, "maxSpace": 0, "usedSpace": 0, "remainingSpace": 0}

    def extract_space_stats(payload: Any) -> tuple[int, int]:
        data = seedr_data(payload)
        if not isinstance(data, dict):
            return 0, 0

        account = data.get("account") if isinstance(data.get("account"), dict) else {}
        storage = data.get("storage") if isinstance(data.get("storage"), dict) else {}

        max_space = int(float(
            data.get("space_max")
            or account.get("space_max")
            or storage.get("limit")
            or data.get("maxSpace")
            or 0
        ))
        used = int(float(
            data.get("space_used")
            or account.get("space_used")
            or storage.get("used")
            or data.get("usedSpace")
            or 0
        ))
        return max(0, max_space), max(0, used)

    # The Seedr folder-contents response includes the account's space_max and
    # space_used fields alongside the filesystem data. Prefer it because it is
    # the same data source used to build the Library and correctly reflects
    # storage occupied by completed files/folders.
    root_id = str(SEEDR_LIBRARY_FOLDER_ID or "").strip()
    max_space = 0
    used = 0

    if root_id.isdigit():
        try:
            max_space, used = extract_space_stats(
                await seedr_request(f"/fs/folder/{quote(root_id)}/contents")
            )
        except HTTPException:
            pass

    # Fall back to the account quota endpoint if the filesystem response does
    # not carry the space fields on a particular Seedr API response.
    if max_space <= 0:
        max_space, used = extract_space_stats(await seedr_request("/me/quota"))

    remaining = max(0, max_space - used)
    return {
        "configured": True,
        "maxSpace": max_space,
        "usedSpace": used,
        "remainingSpace": remaining,
    }

@app.get("/api/seedr/tasks")
async def seedr_tasks():
    if not SEEDR_TOKEN:
        return {"configured": False, "tasks": []}
    payload = seedr_data(await seedr_request("/tasks"))
    tasks = []
    for raw in arr(payload, ("tasks", "torrents")):
        if isinstance(raw, dict):
            tasks.append(raw)
    return {"configured": True, "tasks": tasks}

@app.post("/api/seedr/tasks/inspect-selection")
async def seedr_inspect_selection(body: MagnetRequest):
    """Read Seedr's documented unwanted-file bitmap without pausing or changing it.

    This is intentionally a probe for free-account compatibility. It may add the
    torrent if it is not already present, but it never pauses the task and never
    writes an unwanted-file selection.
    """
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")

    folder = str(body.folder_id or SEEDR_LIBRARY_FOLDER_ID).strip()
    if not folder.isdigit():
        raise HTTPException(503, "SEEDR_LIBRARY_FOLDER_ID must be configured")

    magnet = normalize_magnet(body.magnet)
    h = info_hash(magnet)
    if not h:
        raise HTTPException(400, "A valid BTIH magnet link is required")

    existing = await find_task_by_hash(h)
    created = False
    task = existing
    if not task:
        task = await add_task(magnet, int(folder))
        created = True

    task = unwrap_seedr_task(task)
    tid = task_id(task)
    if not tid:
        raise HTTPException(502, "Seedr did not return a task id")

    torrent_name = str(body.torrent_name or "").strip() or seedr_task_name(task) or f"Torrent {tid}"
    task_folder_id = seedr_task_folder_id(task)

    # Keep a disposable probe task on the same per-torrent 2-hour cleanup
    # policy used by normal Seedr additions. Existing tasks are never re-timed.
    if created:
        schedule_seedr_cleanup(tid, torrent_name, task_folder_id)

    unwanted = await seedr_request(f"/tasks/{quote(tid)}/unwanted")

    return {
        "taskId": int(tid) if tid.isdigit() else tid,
        "created": created,
        "torrentName": torrent_name,
        "folderId": task_folder_id or None,
        "unwanted": seedr_data(unwanted),
        "writeTested": False,
    }

@app.post("/api/seedr/tasks/prepare")
async def seedr_prepare(body: MagnetRequest):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")
    folder = str(body.folder_id or SEEDR_LIBRARY_FOLDER_ID).strip()
    if not folder.isdigit():
        raise HTTPException(503, "SEEDR_LIBRARY_FOLDER_ID must be configured")
    magnet = normalize_magnet(body.magnet)
    h = info_hash(magnet)
    if not h:
        raise HTTPException(400, "A valid BTIH magnet link is required")
    existing = await find_task_by_hash(h)
    created = False
    task = existing
    if not task:
        task = await add_task(magnet, int(folder))
        created = True
    tid = task_id(task)
    if not tid:
        raise HTTPException(502, "Seedr did not return a task id")
    # Seedr pause is intentionally not used. Free accounts may not support
    # pausing reliably, and metadata preparation must never depend on it.
    files = []
    for _ in range(8):
        try:
            files = await task_contents(tid)
        except HTTPException:
            files = []
        if files:
            break
        await asyncio.sleep(.4)
    return {
        "taskId": int(tid) if tid.isdigit() else tid,
        "name": str(task.get("title") or task.get("name") or ""),
        "files": files,
        "created": created,
        "paused": False,
    }

@app.post("/api/seedr/add")
async def seedr_add(body: MagnetRequest):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")
    folder = str(body.folder_id or SEEDR_LIBRARY_FOLDER_ID).strip()
    if not folder.isdigit():
        raise HTTPException(503, "SEEDR_LIBRARY_FOLDER_ID must be configured")
    magnet = normalize_magnet(body.magnet)
    h = info_hash(magnet)
    if not h:
        raise HTTPException(400, "A valid BTIH magnet link is required")

    # Fast path: add directly to Seedr. The previous implementation scanned
    # all existing tasks and inspected folders before every add, which added
    # several network round trips to the Add button path. Only do the lookup
    # when Seedr rejects the add as a possible duplicate.
    try:
        task = await add_task(magnet, int(folder))
    except HTTPException as exc:
        if exc.status_code == 400:
            existing = await find_task_by_hash(h)
            if existing:
                task = existing
            else:
                raise
        else:
            raise

    task = unwrap_seedr_task(task)
    tid = task_id(task)
    if not tid:
        raise HTTPException(502, "Seedr did not return a task id")

    torrent_name = str(body.torrent_name or "").strip()
    task_id_value = str(tid).strip()
    task_folder_id = seedr_task_folder_id(task)

    # Keep the exact title chosen in the search result tied to the task even
    # when Seedr has not created/exposed its folder yet.
    if torrent_name and task_id_value:
        _seedr_torrent_names_by_task[task_id_value] = torrent_name

    folder_renamed = False
    if torrent_name and task_folder_id:
        _seedr_torrent_names[task_folder_id] = torrent_name
        folder_renamed = await rename_seedr_folder(task_folder_id, torrent_name)

    schedule_seedr_cleanup(
        task_id_value,
        torrent_name or seedr_task_name(task) or f"Torrent {task_id_value}",
        task_folder_id,
    )

    return {
        "backend": "seedr",
        "task_id": int(tid) if tid.isdigit() else tid,
        "id": int(tid) if tid.isdigit() else tid,
        "torrent_name": torrent_name,
        "folder_id": task_folder_id or None,
        "folder_renamed": folder_renamed,
        "task": task,
    }

@app.get("/api/seedr/tasks/{tid}/progress")
async def seedr_task_progress(tid: str):
    """Fast polling endpoint: only fetch task state/progress from Seedr."""
    try:
        raw = seedr_data(await seedr_request(f"/tasks/{quote(tid)}"))
    except HTTPException as exc:
        if exc.status_code == 404:
            return {
                "taskId": tid,
                "status": "not_found",
                "progress": 0,
                "name": "",
                "folderId": "",
            }
        raise

    task = (
        raw.get("task")
        if isinstance(raw, dict) and isinstance(raw.get("task"), dict)
        else (raw if isinstance(raw, dict) else {})
    )
    progress = float(task.get("progress") or 0)
    complete = task_complete(task)
    if complete:
        progress = 100

    state = str(task.get("state") or task.get("status") or "").lower()
    status = "completed" if complete else (
        "waiting" if state in {"queued", "pending", "waiting", "paused", "stopped"} else "downloading"
    )

    task_folder_id = seedr_task_folder_id(task)
    task_id_value = str(tid).strip()

    canonical_name = str(
        _seedr_torrent_names_by_task.get(task_id_value)
        or _seedr_torrent_names.get(task_folder_id)
        or seedr_task_name(task)
        or ""
    ).strip()

    if task_folder_id and canonical_name:
        previous_name = _seedr_torrent_names.get(task_folder_id)
        _seedr_torrent_names[task_folder_id] = canonical_name
        # Seedr can expose the folder only after the task starts. Rename at
        # that point, rather than only immediately after /tasks POST.
        if previous_name != canonical_name:
            try:
                await rename_seedr_folder(task_folder_id, canonical_name)
            except Exception:
                pass
            global _seedr_metadata_cache
            _seedr_metadata_cache = None

    seedr_task_display_name = canonical_name
    return {
        "taskId": tid,
        "status": status,
        "progress": progress,
        "name": seedr_task_display_name,
        "folderId": task_folder_id,
    }

@app.get("/api/seedr/tasks/{tid}")
async def seedr_task(tid: str):
    try:
        raw = seedr_data(await seedr_request(f"/tasks/{quote(tid)}"))
    except HTTPException as exc:
        if exc.status_code == 404:
            return {"taskId": tid, "status": "not_found", "progress": 0, "files": [], "downloadUrl": None}
        raise
    task = raw.get("task") if isinstance(raw, dict) and isinstance(raw.get("task"), dict) else (raw if isinstance(raw, dict) else {})
    progress = float(task.get("progress") or 0)
    complete = task_complete(task)
    if complete:
        progress = 100
    files = await task_contents(tid)
    folder_id = seedr_task_folder_id(task) or str(files[0].get("folderId") if files else "")
    task_id_value = str(tid).strip()
    canonical_name = str(
        _seedr_torrent_names_by_task.get(task_id_value)
        or _seedr_torrent_names.get(folder_id)
        or seedr_task_name(task)
        or ""
    ).strip()
    if folder_id and canonical_name:
        previous_name = _seedr_torrent_names.get(folder_id)
        _seedr_torrent_names[folder_id] = canonical_name
        if previous_name != canonical_name:
            try:
                await rename_seedr_folder(folder_id, canonical_name)
            except Exception:
                pass
            global _seedr_metadata_cache
            _seedr_metadata_cache = None
    folderNameValue = canonical_name or (await folder_name(folder_id) if folder_id else "")
    for f in files:
        f["folderPath"] = "/Torrent Studio" + ("/" + folderNameValue if folderNameValue else "")
        f["url"] = None
        if f["id"]:
            try:
                f["url"] = (await download_url(f["id"]))["url"]
            except HTTPException:
                pass
    return {"taskId": tid, "name": str(task.get("title") or task.get("name") or ""), "folderName": folderNameValue, "folderId": folder_id, "status": "completed" if complete else "downloading", "progress": progress, "task": task, "files": files, "downloadUrl": next((f["url"] for f in files if f.get("url")), None)}

async def seedr_folder_payload(folder_id: str) -> dict[str, Any]:
    """Fetch one Seedr folder level, with a short-lived in-process cache."""
    folder_id = str(folder_id).strip()
    if not folder_id:
        return {}

    now = asyncio.get_running_loop().time()
    cached = _seedr_folder_cache.get(folder_id)
    if cached and now - cached[0] < SEEDR_FOLDER_CACHE_SECONDS:
        return cached[1]

    async with _seedr_folder_semaphore:
        # Re-check after waiting for the semaphore so concurrent callers do
        # not issue duplicate Seedr requests for the same folder.
        now = asyncio.get_running_loop().time()
        cached = _seedr_folder_cache.get(folder_id)
        if cached and now - cached[0] < SEEDR_FOLDER_CACHE_SECONDS:
            return cached[1]

        try:
            # Seedr exposes the account root through /api/folder; numeric
            # folder IDs use the /fs/folder/{id}/contents endpoint.
            if folder_id == "0":
                payload = seedr_data(await seedr_root_request())
            else:
                payload = seedr_data(await seedr_request(f"/fs/folder/{quote(folder_id)}/contents"))
        except HTTPException as exc:
            if exc.status_code == 404:
                return {}
            raise

    result = payload if isinstance(payload, dict) else {}
    _seedr_folder_cache[folder_id] = (asyncio.get_running_loop().time(), result)
    return result


def direct_folder_summary(folder_id: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    files = arr(payload, ("files", "items"))
    folders = arr(payload, ("folders", "directories"))
    total_size = 0
    valid_files = 0
    for raw in files:
        if not isinstance(raw, dict):
            continue
        try:
            size = int(float(raw.get("size") or 0))
        except Exception:
            size = 0
        total_size += max(0, size)
        if str(raw.get("id") or raw.get("file_id") or "").strip():
            valid_files += 1

    return {
        "id": str(folder_id),
        "folderId": str(folder_id),
        "name": Path(path.rstrip("/")).name or "Root Files",
        "path": path,
        "filesCount": valid_files,
        "totalSize": total_size,
        "folderCount": len([x for x in folders if isinstance(x, dict)]),
    }


async def build_seedr_metadata_tree(
    folder_id: str,
    path: str,
    folder_name_overrides: dict[str, str] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Build the first library response from the root and its immediate child
    folders. Child contents are fetched concurrently so folder cards already
    have exact file counts/sizes when the browser receives this response.
    """
    folder_name_overrides = folder_name_overrides or {}
    payload = await seedr_folder_payload(folder_id)
    summary = direct_folder_summary(folder_id, path, payload)

    child_entries: list[tuple[str, str, dict[str, Any]]] = []
    for raw in arr(payload, ("folders", "directories")):
        if not isinstance(raw, dict):
            continue
        child_id = str(raw.get("id") or raw.get("folder_id") or "").strip()
        if not child_id:
            continue
        folder_override = str(folder_name_overrides.get(child_id) or "").strip()
        child_name = (
            folder_override
            or str(raw.get("name") or raw.get("title") or child_id).strip()
            or child_id
        )
        child_path = path.rstrip("/") + "/" + child_name
        child_entries.append((child_id, child_name, raw))

    async def load_child(entry: tuple[str, str, dict[str, Any]]) -> dict[str, Any]:
        child_id, child_name, raw = entry
        child_payload = await seedr_folder_payload(child_id)

        # Older Seedr folders can be exposed with their raw 40-character
        # identifier as the visible name. For a single-file torrent we can
        # recover the human title from the actual file name and normalize the
        # folder once, so existing downloads also get fixed on refresh.
        effective_child_name = child_name
        child_files = arr(child_payload, ("files", "items"))
        if (
            re.fullmatch(r"[0-9a-fA-F]{40}", effective_child_name)
            and len(child_files) == 1
            and isinstance(child_files[0], dict)
        ):
            raw_file_name = str(
                child_files[0].get("name")
                or child_files[0].get("title")
                or ""
            ).strip()
            inferred_name = Path(raw_file_name.replace("\\", "/")).name
            inferred_name = Path(inferred_name).stem.strip()
            if inferred_name:
                try:
                    renamed = await rename_seedr_folder(child_id, inferred_name)
                except Exception:
                    renamed = False
                _seedr_torrent_names[child_id] = inferred_name
                effective_child_name = inferred_name
                if renamed:
                    logger.info(
                        "Renamed legacy hash-named Seedr folder %s to %s",
                        child_id,
                        inferred_name,
                    )

        child_summary = direct_folder_summary(
            child_id,
            path.rstrip("/") + "/" + effective_child_name,
            child_payload,
        )

        # Some Seedr responses expose size/count directly on the folder item;
        # use those only when the contents endpoint did not provide a value.
        if child_summary["filesCount"] == 0:
            for key in ("files_count", "file_count", "filesCount", "fileCount", "count"):
                value = raw.get(key)
                if value is not None:
                    try:
                        child_summary["filesCount"] = max(0, int(value))
                        break
                    except (TypeError, ValueError):
                        pass

        if child_summary["totalSize"] == 0:
            for key in ("size", "total_size", "totalSize"):
                value = raw.get(key)
                if value is not None:
                    try:
                        child_summary["totalSize"] = max(0, int(float(value)))
                        break
                    except (TypeError, ValueError):
                        pass

        child_summary["torrentName"] = (
            _seedr_torrent_names.get(child_id)
            or folder_name_overrides.get(child_id)
            or (effective_child_name if re.fullmatch(r"[0-9a-fA-F]{40}", child_name) is None else "")
            or ""
        )
        child_summary["folderCount"] = len(
            [x for x in arr(child_payload, ("folders", "directories")) if isinstance(x, dict)]
        )
        return child_summary

    children: list[dict[str, Any]] = []
    if child_entries:
        results = await asyncio.gather(
            *(load_child(entry) for entry in child_entries),
            return_exceptions=True,
        )
        for result in results:
            if isinstance(result, dict):
                children.append(result)

    # The top-level library badge represents all files in its visible torrent
    # folders, not just files placed directly in the root.
    summary["filesCount"] += sum(int(item.get("filesCount") or 0) for item in children)
    summary["totalSize"] += sum(int(item.get("totalSize") or 0) for item in children)
    summary["folderCount"] = len(children)

    return summary, children


async def get_seedr_metadata_tree(force_refresh: bool = False) -> dict[str, Any]:
    global _seedr_metadata_cache, _seedr_metadata_task

    if not SEEDR_TOKEN:
        return {"configured": False, "root": None, "folders": []}

    now = asyncio.get_running_loop().time()

    if force_refresh:
        # A completed Seedr task can become visible in the filesystem a few
        # seconds after the metadata cache was populated. Clear both caches so
        # the completion flow can see the new folder immediately.
        _seedr_metadata_cache = None
        _seedr_folder_cache.clear()

    if _seedr_metadata_cache and now - _seedr_metadata_cache[0] < SEEDR_METADATA_CACHE_SECONDS:
        return _seedr_metadata_cache[1]

    if _seedr_metadata_task is not None and not _seedr_metadata_task.done():
        return await _seedr_metadata_task

    async def build() -> dict[str, Any]:
        # Seedr's account root is exposed through a dedicated endpoint.
        # Keep SEEDR_LIBRARY_FOLDER_ID as an optional override for deployments
        # that want to start from a specific existing folder.
        root = SEEDR_LIBRARY_FOLDER_ID
        if not root.isdigit():
            root = "0"

        # Resolve human-readable torrent names from Seedr task metadata in one
        # call. The folder contents/counts and task list are independent, so
        # fetch them concurrently without adding a serial round trip.
        folder_name_overrides: dict[str, str] = dict(_seedr_torrent_names)
        task_folders: list[tuple[str, str]] = []
        try:
            tasks_payload = seedr_data(await seedr_request("/tasks"))
            for raw_task in arr(tasks_payload, ("tasks", "torrents", "items")):
                task = unwrap_seedr_task(seedr_data(raw_task))
                if not task:
                    continue

                task_folder_id = seedr_task_folder_id(task)
                task_name = seedr_task_name(task)

                if task_folder_id:
                    task_folders.append((task_folder_id, task_name))

                if task_folder_id and task_name:
                    # The title supplied by our search/add flow is canonical.
                    # Seedr's task title can contain provider/site prefixes
                    # (for example "www.UIndex.org - ..."), so never let task
                    # metadata overwrite an existing canonical title.
                    if task_folder_id not in _seedr_torrent_names:
                        _seedr_torrent_names[task_folder_id] = task_name
                    folder_name_overrides[task_folder_id] = (
                        _seedr_torrent_names.get(task_folder_id) or task_name
                    )
        except HTTPException:
            # Folder metadata remains usable even when task-name lookup fails.
            pass

        try:
            root_summary, children = await build_seedr_metadata_tree(
                root,
                "/Torrent Studio",
                folder_name_overrides,
            )
        except HTTPException as exc:
            # Some Seedr API tokens can read tasks and file operations while
            # denying the account-root filesystem listing. Reconstruct the
            # visible library from task folder IDs instead of failing the
            # entire Seedr Library panel.
            if exc.status_code not in {401, 403} or not task_folders:
                raise

            unique_folders: dict[str, str] = {}
            for folder_id, task_name in task_folders:
                if folder_id and folder_id != root:
                    unique_folders.setdefault(
                        folder_id,
                        folder_name_overrides.get(folder_id)
                        or _seedr_torrent_names.get(folder_id)
                        or task_name
                        or folder_id,
                    )

            async def load_task_folder(folder_id: str, name: str) -> dict[str, Any] | None:
                try:
                    payload = await seedr_folder_payload(folder_id)
                except HTTPException:
                    return None
                if not payload:
                    return None
                summary = direct_folder_summary(
                    folder_id,
                    "/Torrent Studio/" + name,
                    payload,
                )
                summary["torrentName"] = name
                summary["folderCount"] = len(
                    [x for x in arr(payload, ("folders", "directories")) if isinstance(x, dict)]
                )
                return summary

            results = await asyncio.gather(
                *(load_task_folder(folder_id, name) for folder_id, name in unique_folders.items()),
                return_exceptions=True,
            )
            children = [result for result in results if isinstance(result, dict)]
            root_summary = {
                "id": root,
                "folderId": root,
                "name": "Torrent Studio",
                "path": "/Torrent Studio",
                "filesCount": sum(int(item.get("filesCount") or 0) for item in children),
                "totalSize": sum(int(item.get("totalSize") or 0) for item in children),
                "folderCount": len(children),
            }

        return {
            "configured": True,
            "root": root_summary,
            "folders": children,
        }

    _seedr_metadata_task = asyncio.create_task(build())
    try:
        result = await _seedr_metadata_task
        _seedr_metadata_cache = (asyncio.get_running_loop().time(), result)
        return result
    finally:
        _seedr_metadata_task = None


@app.get("/api/seedr/library")
async def seedr_library_metadata(fresh: bool = Query(False)):
    return await get_seedr_metadata_tree(force_refresh=fresh)


@app.get("/api/seedr/folders/{folder_id}/contents")
async def seedr_folder_contents(folder_id: str):
    if not SEEDR_TOKEN:
        return {"configured": False, "folderId": folder_id, "files": [], "folders": []}

    payload = await seedr_folder_payload(folder_id)
    files: list[dict[str, Any]] = []
    for raw in arr(payload, ("files", "items")):
        file = normalize_file(raw, folder_id)
        file["url"] = None
        files.append(file)

    folders: list[dict[str, Any]] = []
    for raw in arr(payload, ("folders", "directories")):
        if not isinstance(raw, dict):
            continue
        child_id = str(raw.get("id") or raw.get("folder_id") or "").strip()
        if not child_id:
            continue
        child_name = str(raw.get("name") or raw.get("title") or child_id).strip() or child_id
        folders.append({"id": child_id, "folderId": child_id, "name": child_name})

    return {"configured": True, "folderId": folder_id, "files": files, "folders": folders}


@app.get("/api/seedr/files")
async def seedr_files():
    # Backwards-compatible full file endpoint. New UI code uses
    # /api/seedr/library + /api/seedr/folders/{id}/contents instead.
    if not SEEDR_TOKEN:
        return {"configured": False, "files": []}

    root = SEEDR_LIBRARY_FOLDER_ID
    if not root.isdigit():
        return {"configured": True, "files": []}

    result = await collect_folder(root, "/Torrent Studio")
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in result:
        item_id = str(item.get("id") or "")
        if item_id and item_id not in seen:
            seen.add(item_id)
            unique.append(item)

    return {"configured": True, "files": unique}

@app.get("/api/seedr/files/{file_id}/download")
async def seedr_file_download(file_id: str):
    return await download_url(file_id)


@app.get("/api/seedr/files/{file_id}/download/direct")
async def seedr_file_download_direct(
    file_id: str,
    filename: str = Query(""),
):
    """Stream a Seedr file with an explicit browser download filename."""
    result = await download_url(file_id)
    filename_value = _safe_download_filename(
        filename or result.get("name") or "",
        f"seedr-file-{file_id}",
    )
    body, content_type, headers = await _stream_seedr_download(result["url"])
    ascii_name = filename_value.encode("ascii", errors="ignore").decode("ascii").strip() or f"seedr-file-{file_id}"
    headers["Content-Disposition"] = (
        'attachment; filename="' + ascii_name.replace('"', "_") + '"'
        + "; filename*=UTF-8''" + quote(filename_value, safe="")
    )
    return StreamingResponse(
        body(),
        media_type=content_type,
        headers=headers,
    )


async def seedr_folder_download_url(folder_id: str) -> str:
    folder_id = str(folder_id or "").strip()
    if not folder_id or not folder_id.isdigit():
        raise HTTPException(400, "Invalid Seedr folder id")

    # Seedr's current API variants have exposed either a URL-producing endpoint
    # or a direct download endpoint. Try the URL form first, then direct form.
    for endpoint in (
        f"/download/folder/{quote(folder_id)}/url",
        f"/download/folder/{quote(folder_id)}",
    ):
        try:
            payload = seedr_data(await seedr_request(endpoint))
        except HTTPException as exc:
            if exc.status_code in (400, 404, 405):
                continue
            raise

        if isinstance(payload, dict):
            url = str(
                payload.get("url")
                or payload.get("download_url")
                or payload.get("downloadUrl")
                or payload.get("direct_url")
                or ""
            ).strip()
            if url:
                return url
        elif isinstance(payload, str) and payload.strip().startswith(("http://", "https://")):
            return payload.strip()

    raise HTTPException(502, "Seedr did not return a folder download URL")


@app.get("/api/seedr/folders/{folder_id}/download")
async def seedr_folder_download(folder_id: str):
    url = await seedr_folder_download_url(folder_id)
    return {"url": url}


@app.get("/api/seedr/folders/{folder_id}/download/direct")
async def seedr_folder_download_direct(
    folder_id: str,
    filename: str = Query(""),
):
    """Stream a Seedr folder archive with an explicit .zip filename."""
    url = await seedr_folder_download_url(folder_id)
    filename_value = _safe_download_filename(
        filename,
        f"seedr-folder-{folder_id}.zip",
    )
    if not filename_value.lower().endswith(".zip"):
        filename_value += ".zip"

    body, content_type, headers = await _stream_seedr_download(url)
    ascii_name = filename_value.encode("ascii", errors="ignore").decode("ascii").strip() or f"seedr-folder-{folder_id}.zip"
    headers["Content-Disposition"] = (
        'attachment; filename="' + ascii_name.replace('"', "_") + '"'
        + "; filename*=UTF-8''" + quote(filename_value, safe="")
    )
    return StreamingResponse(
        body(),
        media_type=content_type or "application/zip",
        headers=headers,
    )

# HLS stream sources are kept server-side. The browser receives a same-origin
# manifest URL so the Seedr access token never needs to be exposed to the client.
SEEDR_HLS_CACHE_SECONDS = 600
_seedr_hls_sources: dict[str, tuple[float, str, set[str]]] = {}


def _seedr_media_url(file_id: str, media_type: str) -> str:
    if media_type == "video":
        endpoint = f"/media/hls/{quote(file_id)}"
    elif media_type == "audio":
        endpoint = f"/media/mp3/{quote(file_id)}"
    else:
        raise HTTPException(400, "Unsupported Seedr media type")
    return SEEDR_MEDIA_BASE.rstrip("/") + endpoint + "?access_token=" + quote(SEEDR_TOKEN, safe="")

def seedr_v2_bearer_token() -> str:
    """Accept a raw Seedr PAT or MediaFusion-style base64 JSON token."""
    raw = SEEDR_TOKEN.strip()
    if not raw:
        return ""
    try:
        decoded = base64.b64decode(raw, validate=True).decode("utf-8")
        payload = json.loads(decoded)
        token = str(payload.get("access_token") or "").strip() if isinstance(payload, dict) else ""
        if token:
            return token
    except Exception:
        pass
    return raw


async def seedr_v2_request(path: str) -> Any:
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")
    bearer = seedr_v2_bearer_token()
    if not bearer:
        raise HTTPException(503, "Seedr access token is empty")
    url = SEEDR_V2_BASE.rstrip("/") + "/" + str(path).lstrip("/")
    async with httpx.AsyncClient(timeout=35, follow_redirects=True) as client:
        response = await client.get(
            url,
            headers={"Authorization": f"Bearer {bearer}", "Accept": "application/json"},
        )
    raw = response.text
    try:
        data = response.json() if raw else None
    except Exception:
        data = raw
    if response.status_code >= 400:
        detail = raw
        if isinstance(data, dict):
            detail = data.get("error_description") or data.get("message") or data.get("error") or raw
        raise HTTPException(response.status_code, str(detail or "Seedr V2 request failed"))
    return data

async def seedr_v2_video_url(file_id: str) -> str:
    """Use Seedr V2 current presentation URL, with direct-download fallback."""
    if not file_id:
        return ""
    try:
        payload = seedr_data(await seedr_v2_request(f"/presentations/file/{quote(file_id)}/video"))
        if isinstance(payload, dict):
            link = payload.get("link")
            link_url = link.get("url") if isinstance(link, dict) else ""
            url = str(payload.get("url") or payload.get("stream_url") or link_url or "").strip()
            if url.startswith(("http://", "https://")):
                return url
    except HTTPException:
        pass

    try:
        payload = seedr_data(await seedr_v2_request(f"/download/file/{quote(file_id)}/url"))
        if isinstance(payload, dict):
            url = str(payload.get("url") or payload.get("download_url") or "").strip()
            if url.startswith(("http://", "https://")):
                return url
    except HTTPException:
        pass

    return ""


def _absolute_hls_uri(base_url: str, uri: str) -> str:
    absolute = urljoin(base_url, uri)
    # Some HLS manifests use one access query string on the playlist URL and
    # omit it from relative segment/variant URLs. Carry it forward.
    if not urlsplit(uri).query:
        base_query = urlsplit(base_url).query
        if base_query and not urlsplit(absolute).query:
            absolute += "?" + base_query
    return absolute


def _encode_hls_target(url: str) -> str:
    return base64.urlsafe_b64encode(url.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_hls_target(value: str) -> str:
    padding = "=" * ((4 - len(value) % 4) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding).decode("utf-8")
    except Exception as exc:
        raise HTTPException(400, "Invalid HLS resource token") from exc


def _rewrite_hls_manifest(file_id: str, manifest_text: str, base_url: str) -> str:
    lines = manifest_text.splitlines()
    rewritten: list[str] = []

    def proxy_url(absolute: str) -> str:
        return "/api/seedr/hls/" + quote(file_id, safe="") + "/resource?u=" + _encode_hls_target(absolute)

    for line in lines:
        current = line
        def replace_uri(match: re.Match[str]) -> str:
            uri = match.group(1)
            return 'URI="' + proxy_url(_absolute_hls_uri(base_url, uri)) + '"'
        current = re.sub(r'URI="([^"]+)"', replace_uri, current)

        stripped = current.strip()
        if stripped and not stripped.startswith("#"):
            current = proxy_url(_absolute_hls_uri(base_url, stripped))
        rewritten.append(current)

    return "\n".join(rewritten) + ("\n" if manifest_text.endswith("\n") else "")


async def _presentation_is_hls(url: str) -> bool:
    """Probe a Seedr presentation URL without downloading the full media file."""
    if not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            response = await client.get(url, headers={"Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*", "Range": "bytes=0-2047"})
        content_type = str(response.headers.get("content-type") or "").lower()
        prefix = response.content[:2048].decode("utf-8", errors="ignore")
        return "mpegurl" in content_type or "#EXTM3U" in prefix
    except Exception as exc:
        logger.info("Seedr presentation probe failed: %s", exc)
        return False


async def _fetch_seedr_hls_manifest(file_id: str) -> tuple[str, str]:
    """Resolve a browser-playable HLS manifest from Seedr V2, then v1 fallback."""
    candidates: list[str] = []
    presentation_url = await seedr_v2_video_url(file_id)
    if presentation_url:
        candidates.append(presentation_url)
    # Seedr's legacy HLS endpoint explicitly requests a converted browser stream.
    candidates.append(_seedr_media_url(file_id, "video"))

    last_detail = "Seedr did not return an HLS manifest"
    for upstream_url in dict.fromkeys(candidates):
        try:
            async with httpx.AsyncClient(timeout=35, follow_redirects=True) as client:
                response = await client.get(
                    upstream_url,
                    headers={"Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"},
                )
            if response.status_code >= 400:
                last_detail = response.text[:500] or f"Seedr returned HTTP {response.status_code}"
                continue

            content_type = str(response.headers.get("content-type") or "").lower()
            text = response.text
            if "#EXTM3U" not in text[:200]:
                last_detail = f"Seedr returned {content_type or 'non-HLS content'}"
                continue

            final_url = str(response.url)
            host = urlsplit(final_url).hostname or ""
            if not host:
                last_detail = "Seedr returned an invalid HLS URL"
                continue

            allowed_hosts = {host.lower()}
            for raw_uri in re.findall(r'(?:URI="([^"]+)"|^([^#\s][^\r\n]*))', text, flags=re.M):
                uri = raw_uri[0] or raw_uri[1]
                if uri:
                    try:
                        ref_host = urlsplit(_absolute_hls_uri(final_url, uri)).hostname
                        if ref_host:
                            allowed_hosts.add(ref_host.lower())
                    except Exception:
                        pass

            _seedr_hls_sources[file_id] = (
                asyncio.get_running_loop().time() + SEEDR_HLS_CACHE_SECONDS,
                final_url,
                allowed_hosts,
            )
            logger.info("Seedr HLS manifest resolved: file=%s source=%s", file_id, urlsplit(final_url).hostname)
            return text, final_url
        except Exception as exc:
            last_detail = str(exc)
            continue

    raise HTTPException(502, last_detail)

async def _get_hls_source(file_id: str) -> tuple[str, set[str]]:
    now = asyncio.get_running_loop().time()
    cached = _seedr_hls_sources.get(file_id)
    if cached and cached[0] > now:
        return cached[1], cached[2]

    _manifest, final_url = await _fetch_seedr_hls_manifest(file_id)
    cached = _seedr_hls_sources[file_id]
    return final_url, cached[2]


async def resolve_seedr_stream_id(file_id: str, name: str = "") -> str:
    """Resolve the Seedr playback file identifier without requiring HLS."""
    candidate = str(file_id or "").strip()
    if candidate:
        try:
            presentation = await seedr_v2_video_url(candidate)
            if presentation:
                return candidate
        except HTTPException:
            pass
        try:
            await _fetch_seedr_hls_manifest(candidate)
            return candidate
        except HTTPException:
            pass

    if not name:
        raise HTTPException(404, "Seedr playback file could not be resolved")

    try:
        result = seedr_data(await seedr_request(f"/search/fs?query={quote(name)}"))
    except HTTPException as exc:
        raise HTTPException(exc.status_code, "Seedr file lookup failed") from exc

    candidates = arr(result, ("files", "items"))
    wanted_name = Path(name).name.lower()
    for raw in candidates:
        if not isinstance(raw, dict):
            continue
        raw_name = str(raw.get("name") or raw.get("title") or "").strip()
        if raw_name.lower() != wanted_name:
            continue

        # Match MediaFusion: Seedr V2 playback uses the actual file id.
        resolved = str(
            raw.get("id")
            or raw.get("file_id")
            or raw.get("folder_file_id")
            or raw.get("folderFileId")
            or ""
        ).strip()
        if not resolved:
            continue

        try:
            await _fetch_seedr_hls_manifest(resolved)
            logger.info("Seedr playback id resolved by filename: %s -> %s", name, resolved)
            return resolved
        except HTTPException:
            continue

    raise HTTPException(404, f"No playable Seedr stream found for {name}")


@app.get("/api/seedr/files/stream")
async def seedr_file_stream(
    file_id: str = Query(""),
    type: str = Query("video"),
    name: str = Query(""),
):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")

    resolved_id = await resolve_seedr_stream_id(file_id, name)

    if type == "video":
        # Seedr normally uses HLS for browser playback, but some presentation
        # URLs are already directly playable by a native browser <video>.
        # Detect that case and proxy it through our same-origin Range-aware
        # endpoint. Keep HLS for presentations that actually return a
        # manifest.
        presentation_url = await seedr_v2_video_url(resolved_id)
        if presentation_url and not await _presentation_is_hls(presentation_url):
            return {
                "url": "/api/seedr/media/video/" + quote(resolved_id, safe=""),
                "externalUrl": presentation_url,
                "name": name or resolved_id,
                "resolvedFileId": resolved_id,
                "protocol": "direct",
            }

        try:
            await _fetch_seedr_hls_manifest(resolved_id)
            return {
                "url": "/api/seedr/hls/" + quote(resolved_id, safe=""),
                "externalUrl": presentation_url or _seedr_media_url(resolved_id, "video"),
                "name": name or resolved_id,
                "resolvedFileId": resolved_id,
                "protocol": "hls",
            }
        except HTTPException:
            # If the presentation URL exists but HLS preparation failed,
            # still expose the direct proxy as a last resort. The browser
            # will receive the same Seedr presentation URL we verified.
            if presentation_url:
                return {
                    "url": "/api/seedr/media/video/" + quote(resolved_id, safe=""),
                    "externalUrl": presentation_url,
                    "name": name or resolved_id,
                    "resolvedFileId": resolved_id,
                    "protocol": "direct",
                }
            raise

    return {
        "url": "/api/seedr/media/audio/" + quote(resolved_id, safe=""),
        "externalUrl": _seedr_media_url(resolved_id, "audio"),
        "name": name or resolved_id,
        "resolvedFileId": resolved_id,
        "protocol": "mp3",
    }

@app.get("/api/seedr/hls/{file_id}")
async def seedr_hls_manifest(file_id: str):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")

    manifest, final_url = await _fetch_seedr_hls_manifest(file_id)
    cached = _seedr_hls_sources.get(file_id)
    allowed_hosts = cached[2] if cached else {urlsplit(final_url).hostname.lower()}
    rewritten = _rewrite_hls_manifest(file_id, manifest, final_url)

    return Response(
        content=rewritten,
        media_type="application/vnd.apple.mpegurl",
        headers={
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/api/seedr/hls/{file_id}/resource")
async def seedr_hls_resource(request: Request, file_id: str, u: str = Query(...)):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")

    target = _decode_hls_target(u)
    parsed = urlsplit(target)
    host = (parsed.hostname or "").lower()
    if not host:
        raise HTTPException(400, "Invalid HLS target URL")

    try:
        base_url, allowed_hosts = await _get_hls_source(file_id)
    except HTTPException:
        raise

    if host not in allowed_hosts:
        raise HTTPException(403, "HLS resource host is not allowed")

    headers: dict[str, str] = {"Accept": "*/*"}
    if request is not None:
        range_header = request.headers.get("range")
        if range_header:
            headers["Range"] = range_header

    async with httpx.AsyncClient(timeout=35, follow_redirects=True) as client:
        response = await client.get(target, headers=headers)

    if response.status_code >= 400:
        return Response(
            content=response.content,
            status_code=response.status_code,
            media_type=response.headers.get("content-type", "application/octet-stream"),
            headers={"Access-Control-Allow-Origin": "*"},
        )

    content_type = str(response.headers.get("content-type") or "").lower()
    body = response.content

    if "mpegurl" in content_type or "#EXTM3U" in body[:200].decode("utf-8", errors="ignore"):
        text = body.decode("utf-8", errors="replace")
        final_url = str(response.url)
        final_host = urlsplit(final_url).hostname
        if final_host:
            allowed_hosts.add(final_host.lower())
        _seedr_hls_sources[file_id] = (
            asyncio.get_running_loop().time() + SEEDR_HLS_CACHE_SECONDS,
            final_url,
            allowed_hosts,
        )
        body = _rewrite_hls_manifest(file_id, text, final_url).encode("utf-8")
        content_type = "application/vnd.apple.mpegurl"

    response_headers = {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Accept-Ranges": response.headers.get("accept-ranges", "bytes"),
    }
    for header in ("content-range", "content-length", "etag", "last-modified"):
        if response.headers.get(header):
            response_headers[header.title()] = response.headers[header]

    return Response(
        content=body,
        status_code=response.status_code,
        media_type=content_type or "application/octet-stream",
        headers=response_headers,
    )


@app.get("/api/seedr/media/video/{file_id}")
async def seedr_video_media(file_id: str, request: Request):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")

    upstream_url = await seedr_v2_video_url(file_id)
    if not upstream_url:
        raise HTTPException(404, "Seedr returned no video presentation URL")

    headers = {"Accept": "video/*,application/octet-stream,*/*"}
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header

    client = httpx.AsyncClient(timeout=60, follow_redirects=True)
    try:
        response = await client.send(
            client.build_request("GET", upstream_url, headers=headers),
            stream=True,
        )
    except Exception:
        await client.aclose()
        raise

    if response.status_code >= 400:
        body = await response.aread()
        status = response.status_code
        content_type = response.headers.get("content-type", "application/octet-stream")
        await response.aclose()
        await client.aclose()
        return Response(
            content=body,
            status_code=status,
            media_type=content_type,
            headers={"Access-Control-Allow-Origin": "*"},
        )

    response_headers = {
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": response.headers.get("accept-ranges", "bytes"),
        "Cache-Control": "no-store",
    }
    for header in ("content-range", "content-length", "etag", "last-modified"):
        if response.headers.get(header):
            response_headers[header.title()] = response.headers[header]

    async def body_stream():
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(
        body_stream(),
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "video/mp4"),
        headers=response_headers,
    )


async def seedr_audio_media(file_id: str, request: Request):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")

    headers = {"Accept": "*/*"}
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header

    upstream_url = _seedr_media_url(file_id, "audio")
    async with httpx.AsyncClient(timeout=35, follow_redirects=True) as client:
        response = await client.get(upstream_url, headers=headers)

    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "audio/mpeg"),
        headers={
            "Access-Control-Allow-Origin": "*",
            "Accept-Ranges": response.headers.get("accept-ranges", "bytes"),
            "Content-Range": response.headers.get("content-range", ""),
        },
    )

@app.delete("/api/seedr/tasks/{tid}")
async def seedr_task_delete(tid: str):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")
    global _seedr_metadata_cache
    try:
        result = await seedr_request(f"/tasks/{quote(tid)}", "DELETE")
    except HTTPException as exc:
        if exc.status_code != 405:
            raise
        result = await seedr_request(f"/tasks/{quote(tid)}/delete", "POST")
    _seedr_metadata_cache = None
    _seedr_folder_cache.clear()
    return result

@app.delete("/api/seedr/files/{file_id}")
async def seedr_file_delete(file_id: str):
    global _seedr_metadata_cache
    result = await seedr_request(f"/fs/file/{quote(file_id)}", "DELETE")
    _seedr_metadata_cache = None
    _seedr_folder_cache.clear()
    return result

@app.delete("/api/seedr/folders/{folder_id}")
async def seedr_folder_delete(folder_id: str):
    global _seedr_metadata_cache
    result = await seedr_request(f"/fs/folder/{quote(folder_id)}", "DELETE")
    _seedr_metadata_cache = None
    _seedr_folder_cache.clear()
    return result

# Compatibility endpoints for the preserved UI. They intentionally do not run
# qBittorrent or maintain local torrent storage; Seedr is the only transfer backend.
@app.get("/api/v2/torrents/info")
async def empty_torrents(filter: str | None = None):
    return []

def _libtorrent_metadata_sync(magnet: str) -> tuple[str, str, list[dict[str, Any]], int]:
    """Resolve only torrent metadata using libtorrent; never request content pieces."""
    tmp = tempfile.mkdtemp(prefix="torrent-metadata-lt-")
    ses = None
    handle = None
    try:
        ses = lt.session()

        # Explicitly enable the discovery paths needed for magnet metadata on
        # a cloud host. Keep UPnP/NAT-PMP/LSd off: they are not useful on
        # Render and can add connection delay. DHT + tracker access remain on.
        ses.apply_settings({
            "enable_dht": True,
            "enable_lsd": False,
            "enable_upnp": False,
            "enable_natpmp": False,
            "enable_outgoing_tcp": True,
            "enable_outgoing_utp": True,
            "enable_incoming_tcp": True,
            "enable_incoming_utp": True,
            "listen_interfaces": "0.0.0.0:0",
            "dht_bootstrap_nodes": (
                "router.bittorrent.com:6881,"
                "router.utorrent.com:6881,"
                "dht.transmissionbt.com:6881"
            ),
            "use_dht_as_fallback": False,
            "announce_to_all_trackers": True,
            "announce_to_all_tiers": True,
            "connection_speed": 50,
            "handshake_timeout": 10,
        })

        atp = lt.parse_magnet_uri(magnet)
        atp.save_path = tmp

        # upload_mode prevents piece requests. Disable auto-management so the
        # session cannot later take the torrent out of upload mode automatically.
        atp.flags = atp.flags | lt.torrent_flags.upload_mode
        atp.flags = atp.flags & ~lt.torrent_flags.auto_managed

        handle = ses.add_torrent(atp)

        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            if handle.has_metadata():
                break
            for alert in ses.pop_alerts():
                message = str(alert)
                if "error" in message.lower() or "tracker" in message.lower() or "dht" in message.lower():
                    logger.info("libtorrent alert for %s: %s", info_hash(magnet), message[:500])
            time.sleep(0.15)

        if not handle.has_metadata():
            status = handle.status()
            raise TimeoutError(
                f"libtorrent metadata timeout (state={status.state}, "
                f"peers={status.num_peers}, seeds={status.num_seeds})"
            )

        ti = handle.torrent_file()
        if ti is None:
            raise RuntimeError("libtorrent reported metadata but torrent_file() is empty")

        fs = ti.layout()
        torrent_name = str(ti.name() or "")
        files: list[dict[str, Any]] = []
        for index in range(fs.num_files()):
            path = str(fs.file_path(index))
            size = int(fs.file_size(index))
            if not path:
                continue
            files.append({
                "index": index,
                "name": path,
                "size": size,
                "path": path,
                "type": "file",
                "priority": 1,
            })

        total_size = sum(int(item.get("size") or 0) for item in files)
        return torrent_name, magnet, files, total_size
    finally:
        try:
            if ses is not None and handle is not None and handle.is_valid():
                ses.remove_torrent(handle)
        except Exception:
            pass
        try:
            if ses is not None:
                del ses
        except Exception:
            pass
        shutil.rmtree(tmp, ignore_errors=True)


async def _fetch_remote_torrent_metadata(magnet: str, info_hash_value: str) -> dict[str, Any] | None:
    """Use the public torrent-metadata resolver as a metadata-only fallback."""
    if not TORRENT_METADATA_API_URL:
        return None
    try:
        # This service resolves BEP-9 metadata from a magnet without starting
        # a file download. Give Fly.io enough time to wake a sleeping instance.
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            response = await client.post(
                TORRENT_METADATA_API_URL.rstrip("/") + "/",
                json={"query": magnet},
                headers={"Accept": "application/json", "Content-Type": "application/json"},
            )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("Remote metadata service failed for %s: %s", info_hash_value, exc)
        return None

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None
    returned_hash = str(data.get("infoHash") or "").strip().lower()
    if returned_hash and returned_hash != info_hash_value.lower():
        logger.info("Remote metadata hash mismatch: wanted %s, got %s", info_hash_value, returned_hash)
        return None

    raw_files = data.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        return None

    files: list[dict[str, Any]] = []
    for index, item in enumerate(raw_files):
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or item.get("name") or "").strip()
        if not path:
            continue
        files.append({
            "index": index,
            "name": str(item.get("name") or path),
            "size": int(float(item.get("size") or 0)),
            "path": path,
            "type": "file",
            "priority": 1,
        })
    if not files:
        return None

    result = {
        "name": str(data.get("name") or files[0]["name"]),
        "hash": info_hash_value.lower(),
        "files": files,
        "totalSize": sum(int(item["size"]) for item in files),
        "source": "remote_torrent_metadata",
        "pending": False,
        "createdPreview": False,
        "message": "Torrent metadata loaded without starting Seedr.",
    }
    _metadata_cache[info_hash_value.lower()] = result
    _save_metadata_cache()
    return result


async def _lookup_knaben_by_hash(info_hash_value: str) -> dict[str, Any] | None:
    """Find and parse a Knaben cached descriptor for an exact info-hash."""
    target = info_hash_value.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40}", target):
        return None

    payload_base = {
        "search_type": "100%",
        "query": target,
        "from": 0,
        "size": 20,
        "hide_unsafe": False,
        "hide_xxx": False,
    }

    async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
        for field in ("hash", None):
            payload = dict(payload_base)
            if field:
                payload["search_field"] = field
            try:
                response = await client.post(
                    KNABEN_API_URL,
                    json=payload,
                    headers={"Accept": "application/json", "Content-Type": "application/json"},
                )
                response.raise_for_status()
                data = response.json()
            except (httpx.HTTPError, ValueError):
                continue

            hits = data.get("hits") if isinstance(data, dict) else None
            if not isinstance(hits, list):
                continue

            for hit in hits:
                if not isinstance(hit, dict):
                    continue
                hit_hash = str(hit.get("hash") or "").strip().lower()
                if hit_hash != target:
                    continue

                descriptor = str(hit.get("link") or "").strip()
                if descriptor:
                    parsed = await _fetch_source_torrent_descriptor(descriptor, target)
                    if parsed:
                        return parsed

                details = str(hit.get("details") or "").strip()
                if details:
                    parsed = await _fetch_source_torrent_descriptor(details, target)
                    if parsed:
                        return parsed
    return None


@app.post("/api/v2/torrents/inspect-magnet")
async def seedr_inspect_magnet(body: dict[str, Any]):
    """Return cached metadata immediately or start a background resolver."""
    raw_magnet = str(body.get("magnet") or body.get("source") or "").strip()
    if not raw_magnet:
        raise HTTPException(400, "A magnet link is required")

    magnet = normalize_magnet(raw_magnet)
    h = info_hash(magnet)
    if not h:
        raise HTTPException(400, "A valid BTIH magnet link is required")
    h = h.lower()

    cached = _metadata_cache.get(h)
    if cached:
        return cached

    # Search results can carry a detail URL. When that page exposes a real
    # .torrent descriptor, use it before touching DHT/trackers.
    descriptor_url = str(body.get("descriptorUrl") or "").strip()
    source_url = str(body.get("sourceUrl") or body.get("infoUrl") or "").strip()

    # First use an actual descriptor URL returned by the indexer.
    for candidate_url in (descriptor_url, source_url):
        if candidate_url:
            descriptor_result = await _fetch_source_torrent_descriptor(candidate_url, h)
            if descriptor_result:
                return descriptor_result

    # Search results may have an exact hash cached by Knaben. For a pasted
    # magnet there is no source URL, so do this lookup in the background rather
    # than making the user wait on a second network request before the job starts.
    if descriptor_url or source_url:
        try:
            hash_result = await _lookup_knaben_by_hash(h)
        except Exception as exc:
            logger.info("Knaben hash lookup failed for %s: %s", h, exc)
            hash_result = None
        if hash_result:
            return hash_result

    job_id = h
    existing = _metadata_jobs.get(job_id)
    if existing and existing.get("status") == "ready" and existing.get("result"):
        return existing["result"]

    if not existing or existing.get("status") == "error":
        _metadata_jobs[job_id] = {
            "status": "queued",
            "hash": h,
            "startedAt": time.time(),
            "error": None,
        }
        asyncio.create_task(_run_metadata_job(job_id, magnet, h))

    # Give a fast first attempt a short window. Slow metadata resolution
    # continues in the background and is polled by the frontend.
    for _ in range(10):
        await asyncio.sleep(0.2)
        job = _metadata_jobs.get(job_id, {})
        if job.get("status") == "ready" and job.get("result"):
            return job["result"]
        if job.get("status") == "error":
            raise HTTPException(502, str(job.get("error") or "Metadata lookup failed"))

    return JSONResponse(
        status_code=202,
        content={
            "status": "resolving",
            "jobId": job_id,
            "hash": h,
            "source": "libtorrent_metadata",
            "message": "Torrent metadata is still resolving. Seedr has not been started.",
        },
    )


@app.get("/api/v2/torrents/inspect-magnet/status")
async def seedr_inspect_magnet_status(jobId: str = Query(...)):
    job = _metadata_jobs.get(jobId.lower())
    if not job:
        cached = _metadata_cache.get(jobId.lower())
        if cached:
            return cached
        raise HTTPException(404, "Metadata job not found")

    if job.get("status") == "ready" and job.get("result"):
        return job["result"]

    if job.get("status") == "error":
        raise HTTPException(502, str(job.get("error") or "Metadata lookup failed"))

    return {
        "status": "resolving",
        "jobId": jobId,
        "hash": jobId,
        "source": "libtorrent_metadata",
        "message": job.get("error") or "Torrent metadata is still resolving. Seedr has not been started.",
    }



@app.get("/api/v2/torrents/files")
async def empty_torrent_files(hash: str):
    return []

@app.post("/api/v2/torrents/pause")
async def noop_pause(body: dict[str, Any]):
    return {}

@app.post("/api/v2/torrents/resume")
async def noop_resume(body: dict[str, Any]):
    return {}

@app.post("/api/v2/torrents/delete")
async def noop_delete(body: dict[str, Any]):
    return {}

@app.post("/api/v2/torrents/filePrio")
async def noop_prio(body: dict[str, Any]):
    return {}

@app.get("/api/files")
async def files_compat(
    folder: str = "/",
    search: str = "",
    type: str = "all",
    folder_id: str = "",
):
    # Only load files for the folder currently open in the UI. Folder metadata
    # is returned separately by /api/folders.
    target_id = folder_id.strip()
    if not target_id:
        target_id = SEEDR_LIBRARY_FOLDER_ID if folder in {"/", "/Torrent Studio"} else ""

    if not target_id.isdigit():
        metadata = await get_seedr_metadata_tree()
        for item in metadata.get("folders", []) if isinstance(metadata, dict) else []:
            if str(item.get("path") or "") == folder:
                target_id = str(item.get("id") or "")
                break

    if not target_id.isdigit():
        return []

    payload = await seedr_folder_payload(target_id)
    result = []
    for raw in arr(payload, ("files", "items")):
        f = normalize_file(raw, target_id)
        name = f["name"]
        if search and search.lower() not in name.lower():
            continue

        lower = name.lower()
        if type != "all":
            if type == "video" and not re.search(r"\.(mkv|mp4|m4v|webm|avi|mov|m3u8|ts)$", lower):
                continue
            if type == "audio" and not re.search(r"\.(mp3|wav|flac|aac|ogg|m4a)$", lower):
                continue
            if type == "document" and not re.search(r"\.(pdf|txt|doc|docx|xls|xlsx|ppt|pptx|csv)$", lower):
                continue
            if type == "archive" and not re.search(r"\.(zip|rar|7z|tar|gz|bz2)$", lower):
                continue

        folder_path = folder if folder not in {"", "/"} else "/Torrent Studio"
        result.append({
            "id": f["id"],
            "name": name,
            "path": folder_path.rstrip("/") + "/" + name,
            "folder": folder_path,
            "size": f["size"],
            "type": "video" if re.search(r"\.(mp4|mkv|webm|avi|mov|m4v|m3u8|ts)$", lower) else "other",
            "mimeType": "video/mp4" if re.search(r"\.mp4$", lower) else "application/octet-stream",
            "createdAt": 0,
            "isStreamable": bool(re.search(r"\.(mp4|mkv|webm|avi|mov|m3u8|ts|mp3|m4a|flac|aac|ogg)$", lower)),
            "ownerId": "seedr",
            "ownerName": "Seedr",
            "downloadUrl": f"/api/seedr/files/{f['id']}/download",
            "streamUrl": "",
        })
    return result


@app.get("/api/folders")
async def folders_compat():
    metadata = await get_seedr_metadata_tree()
    return [
        {
            "id": str(item.get("id") or ""),
            "name": str(item.get("name") or "Folder"),
            "path": str(item.get("path") or "/"),
            "ownerId": "seedr",
            "ownerName": "Seedr",
            "isShared": False,
            "permissions": {},
            "createdAt": 0,
            "filesCount": int(item.get("filesCount") or 0),
            "totalSize": int(item.get("totalSize") or 0),
        }
        for item in metadata.get("folders", [])
    ] if isinstance(metadata, dict) else []

@app.get("/api/storage/stats")
async def storage_stats():
    q = await seedr_quota()
    metadata = await get_seedr_metadata_tree()
    root = metadata.get("root") if isinstance(metadata, dict) else {}
    used = int(q.get("usedSpace") or 0)
    total = int(q.get("maxSpace") or SEEDR_MAX_SIZE_BYTES)
    pct = (used / total * 100) if total else 0
    return {
        "totalBytes": total,
        "usedBytes": used,
        "freeBytes": max(0, total-used),
        "usedPercentage": pct,
        "filesCount": int((root or {}).get("filesCount") or 0),
        "torrentsCount": 0,
        "isUnlimited": False,
        "serverCapacityLabel": "Seedr cloud storage",
        "alertLevel": "critical" if pct > 90 else "warning" if pct > 80 else "normal",
    }

@app.get("/api/users")
async def users():
    user = {"id": "seedr-user", "name": "Seedr User", "email": "", "role": "admin", "avatar": ""}
    return {"users": [user], "activeUserId": user["id"], "activeUser": user}

@app.get("/api/logs")
async def logs():
    return []

@app.post("/api/logs/clear")
async def clear_logs():
    return {}

@app.get("/api/notifications")
async def notifications():
    return []

@app.post("/api/notifications/read")
async def notifications_read():
    return {}

@app.post("/api/notifications/test")
async def notifications_test():
    return {}

@app.get("/api/cleanup/settings")
async def cleanup_settings():
    return {"autoCleanCompletedDays": 7, "autoPurgeOrphans": False, "autoCleanTempFiles": False, "storageThresholdPercent": 80}

@app.post("/api/cleanup/settings")
async def update_cleanup_settings(body: dict[str, Any]):
    return body

@app.post("/api/cleanup/run")
async def run_cleanup():
    return {"bytesFreed": 0, "filesRemoved": 0, "tempRemoved": 0, "orphansRemoved": 0}

@app.get("/api/qbt/settings")
async def qbt_settings():
    return {"isExternal": False, "host": "", "username": "", "connected": False, "version": "Seedr backend"}

@app.post("/api/qbt/settings")
async def update_qbt_settings(body: dict[str, Any]):
    return {"isExternal": False, "host": "", "username": "", "connected": False, "version": "Seedr backend"}

@app.post("/api/files/delete")
async def delete_file_compat(body: dict[str, Any]):
    return await seedr_file_delete(str(body.get("id") or ""))

@app.post("/api/files/rename")
async def rename_file_compat(body: dict[str, Any]):
    raise HTTPException(501, "Rename is not exposed by this Seedr API deployment")

@app.post("/api/files/move")
async def move_file_compat(body: dict[str, Any]):
    raise HTTPException(501, "Move is not exposed by this Seedr API deployment")

@app.post("/api/files/folder")
async def create_folder_compat(body: dict[str, Any]):
    raise HTTPException(501, "Folder creation is not exposed by this Seedr API deployment")

@app.post("/api/folders/share")
async def share_folder_compat(body: dict[str, Any]):
    raise HTTPException(501, "Sharing is not provided by Seedr")

@app.post("/api/users/switch")
async def switch_user(body: dict[str, Any]):
    return {"activeUser": {"id": "seedr-user", "name": "Seedr User", "email": "", "role": "admin", "avatar": ""}}

@app.post("/api/users/create")
async def create_user(body: dict[str, Any]):
    raise HTTPException(501, "Multi-user accounts are not provided by this deployment")

@app.get("/api/search/torrents/add")
async def search_add_info():
    return JSONResponse({"added": False, "reason": "Use the Seedr magnet action"}, status_code=405)

@app.post("/api/search/torrents/add")
async def search_torrent_add(body: dict[str, Any]):
    source = str(body.get("source") or "")
    magnet = source if source.lower().startswith("magnet:") else ""
    if not magnet and body.get("infoHash"):
        magnet = "magnet:?xt=urn:btih:" + str(body["infoHash"])
    if not magnet:
        return {"added": False, "reason": "no_magnet_or_info_hash"}
    result = await seedr_add(
        MagnetRequest(
            magnet=magnet,
            torrent_name=str(body.get("torrent_name") or "").strip() or None,
        )
    )
    return {"added": True, **result}
