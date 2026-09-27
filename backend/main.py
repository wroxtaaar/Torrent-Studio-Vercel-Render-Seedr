import asyncio
import base64
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

APP_NAME = "Torrent Studio API"
SEEDR_BASE = "https://www.seedr.cc/api/v0.1/p"
SEEDR_MEDIA_BASE = "https://www.seedr.cc/api"
SEEDR_TOKEN = os.getenv("SEEDR_API_TOKEN", "").strip()
SEEDR_LIBRARY_FOLDER_ID = os.getenv("SEEDR_LIBRARY_FOLDER_ID", "").strip()
SEEDR_MAX_SIZE_GB = float(os.getenv("SEEDR_MAX_SIZE_GB", "5"))
SEEDR_MAX_SIZE_BYTES = int(SEEDR_MAX_SIZE_GB * 1024**3)
TORRENT_SEARCH_API_URL = os.getenv("TORRENT_SEARCH_API_URL", "https://torrent-search-api-ujfa.onrender.com").rstrip("/")
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


def seedr_data(value: Any) -> Any:
    if isinstance(value, dict) and "data" in value:
        return value["data"]
    return value

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

def normalize_magnet(magnet: str) -> str:
    value = re.sub(r"[\r\n\t]+", "", str(magnet or "").strip())
    decoded = unquote(value)
    if decoded.lower().startswith("magnet:?"):
        value = decoded
    if not value.lower().startswith("magnet:?"):
        return value
    try:
        parsed = urlsplit(value)
        params = parse_qs(parsed.query, keep_blank_values=True)
        for raw in params.get("xt", []):
            raw = unquote(raw)
            m = re.fullmatch(r"urn:btih:([A-Za-z0-9]{32,40})", raw, re.I)
            if not m:
                continue
            h = m.group(1)
            if len(h) == 32:
                h = base64.b32decode(h.upper() + "=" * ((8-len(h)%8)%8)).hex()
            if len(h) == 40 and re.fullmatch(r"[0-9a-fA-F]{40}", h):
                return "magnet:?xt=urn:btih:" + h.lower()
    except Exception:
        pass
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
    for raw in arr(payload, ("tasks", "torrents")):
        task = seedr_data(raw)
        if not isinstance(task, dict) or task_hash(task) != h:
            continue
        if task_complete(task):
            folder = str(task.get("folder_created_id") or "").strip()
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

def _search_tokens(value: str) -> list[str]:
    return [token for token in re.findall(r"[a-z0-9]+", value.lower()) if token]


def _tvmaze_query(value: str) -> str:
    value = re.sub(r"\bS\d{1,2}(?:E\d{1,3})?.*$", "", value, flags=re.I)
    value = re.sub(r"\b(?:season|series)\s*\d+\b", "", value, flags=re.I)
    value = re.sub(r"\b(?:19|20)\d{2}\b", "", value)
    return re.sub(r"\s+", " ", value).strip()


def _normalize_title(value: str) -> str:
    return " ".join(_search_tokens(value))


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
    tv_query = _tvmaze_query(query)
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
    results.sort(
        key=lambda row: (row["seeders"] + row["leechers"], row["publishDate"]),
        reverse=True,
    )
    return results[:limit]


async def search_1337x(query: str, limit: int = 10) -> list[dict[str, Any]]:
    """
    Search through the dedicated Torrent Search MCP API.

    Torrent Studio no longer scrapes 1337x directly from Render. The search
    service aggregates multiple sources and exposes a stable HTTP API.
    """
    query = query.strip()
    if not query:
        return []

    base = TORRENT_SEARCH_API_URL
    search_url = f"{base}/torrent/search"

    try:
        async with httpx.AsyncClient(timeout=45, follow_redirects=True) as client:
            response = await client.post(
                search_url,
                # Fetch a broad candidate pool. We do relevance filtering here
                # instead of letting global seed counts hide exact title matches.
                params={"query": query, "max_items": 200, "per_source": 50},
                headers={"Accept": "application/json"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Torrent search service unavailable: {exc}") from exc

    tv_results, movie_results = await asyncio.gather(
        search_tv_eztv(query, limit=100),
        search_yts_movies(query, limit=100),
        return_exceptions=True,
    )
    if isinstance(tv_results, BaseException):
        tv_results = []
    if isinstance(movie_results, BaseException):
        movie_results = []

    if response.status_code >= 400:
        detail = response.text.strip()
        raise HTTPException(
            502,
            f"Torrent search service returned HTTP {response.status_code}: {detail[:500]}",
        )

    try:
        payload = response.json()
    except Exception as exc:
        raise HTTPException(502, "Torrent search service returned invalid JSON") from exc

    if not isinstance(payload, list):
        raise HTTPException(502, "Torrent search service returned an invalid result set")

    tokens = _search_tokens(
        re.sub(r"\b(?:19|20)\d{2}\b", " ", _tvmaze_query(query))
    )

    # Keep aggregate candidates strictly media-focused and title-relevant.
    # This prevents anime, games, music and unrelated high-seed torrents from
    # appearing just because they share one generic search token.
    aggregate_items = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        title = str(item.get("filename") or item.get("title") or "")
        category = str(item.get("category") or "").lower()
        normalized_title = _normalize_title(title)
        if tokens and not all(token in normalized_title for token in tokens):
            continue
        if category and any(
            blocked in category
            for blocked in ("anime", "games", "music", "software", "books")
        ):
            continue
        if category and "video" not in category and "movie" not in category and "tv" not in category:
            continue
        aggregate_items.append(item)

    payload_items = list(tv_results) + list(movie_results) + aggregate_items

    results: list[dict[str, Any]] = []
    seen_hashes: set[str] = set()
    for item in payload_items[: max(limit * 4, 50)]:
        if not isinstance(item, dict):
            continue

        filename = str(item.get("filename") or item.get("title") or "").strip()
        if not filename:
            continue

        item_hash = info_hash(
            str(item.get("magnet_link") or item.get("magnetUrl") or "")
        ) or str(item.get("id") or "").strip()
        if item_hash and item_hash in seen_hashes:
            continue
        if item_hash:
            seen_hashes.add(item_hash)

        magnet = str(item.get("magnet_link") or item.get("magnetUrl") or "").strip()
        source = str(item.get("source") or "torrent-search").strip()

        size_value = item.get("size", 0)
        size = int(size_value) if isinstance(size_value, (int, float)) else parse_size(str(size_value))

        results.append({
            "guid": str(item.get("id") or ""),
            "title": filename,
            "size": size,
            "seeders": int(item.get("seeders") or 0),
            "leechers": int(item.get("leechers") or 0),
            "indexer": source,
            "category": str(item.get("category") or ""),
            "protocol": "torrent",
            "publishDate": str(item.get("date") or ""),
            "magnetUrl": magnet or None,
            "infoHash": info_hash(magnet) if magnet else "",
            "downloadUrl": magnet or None,
            "infoUrl": str(item.get("page_url") or ""),
            "sourceUrl": str(item.get("page_url") or ""),
        })

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
    result = seedr_data(await seedr_request("/me/quota"))
    if not isinstance(result, dict):
        raise HTTPException(502, "Seedr returned an invalid quota response")
    storage = result.get("storage") if isinstance(result.get("storage"), dict) else {}
    max_space = int(float(result.get("space_max") or storage.get("limit") or result.get("maxSpace") or 0))
    used = int(float(result.get("space_used") or storage.get("used") or result.get("usedSpace") or 0))
    remaining = int(float(result.get("space_remaining") or storage.get("remaining") or result.get("remainingSpace") or max(0, max_space-used)))
    return {"configured": True, "maxSpace": max_space, "usedSpace": used, "remainingSpace": remaining}

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
    if created:
        try:
            await seedr_request(f"/tasks/{quote(tid)}/pause", "POST")
        except HTTPException:
            pass
    files = []
    for _ in range(8):
        try:
            files = await task_contents(tid)
        except HTTPException:
            files = []
        if files:
            break
        await asyncio.sleep(.4)
    return {"taskId": int(tid) if tid.isdigit() else tid, "name": str(task.get("title") or task.get("name") or ""), "files": files, "created": created, "paused": created}

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

    tid = task_id(task)
    if not tid:
        raise HTTPException(502, "Seedr did not return a task id")
    return {"backend": "seedr", "task_id": int(tid) if tid.isdigit() else tid, "id": int(tid) if tid.isdigit() else tid, "task": task}

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
    folder_id = str(task.get("folder_created_id") or (files[0].get("folderId") if files else ""))
    folderNameValue = await folder_name(folder_id) if folder_id else ""
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


async def build_seedr_metadata_tree(folder_id: str, path: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Build the first library response from the root and its immediate child
    folders. Child contents are fetched concurrently so folder cards already
    have exact file counts/sizes when the browser receives this response.
    """
    payload = await seedr_folder_payload(folder_id)
    summary = direct_folder_summary(folder_id, path, payload)

    child_entries: list[tuple[str, str, dict[str, Any]]] = []
    for raw in arr(payload, ("folders", "directories")):
        if not isinstance(raw, dict):
            continue
        child_id = str(raw.get("id") or raw.get("folder_id") or "").strip()
        if not child_id:
            continue
        child_name = str(raw.get("name") or raw.get("title") or child_id).strip() or child_id
        child_path = path.rstrip("/") + "/" + child_name
        child_entries.append((child_id, child_name, raw))

    async def load_child(entry: tuple[str, str, dict[str, Any]]) -> dict[str, Any]:
        child_id, child_name, raw = entry
        child_payload = await seedr_folder_payload(child_id)
        child_summary = direct_folder_summary(
            child_id,
            path.rstrip("/") + "/" + child_name,
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


async def get_seedr_metadata_tree() -> dict[str, Any]:
    global _seedr_metadata_cache, _seedr_metadata_task

    if not SEEDR_TOKEN:
        return {"configured": False, "root": None, "folders": []}

    now = asyncio.get_running_loop().time()
    if _seedr_metadata_cache and now - _seedr_metadata_cache[0] < SEEDR_METADATA_CACHE_SECONDS:
        return _seedr_metadata_cache[1]

    if _seedr_metadata_task is not None and not _seedr_metadata_task.done():
        return await _seedr_metadata_task

    async def build() -> dict[str, Any]:
        root = SEEDR_LIBRARY_FOLDER_ID
        if not root.isdigit():
            return {"configured": True, "root": None, "folders": []}

        root_summary, children = await build_seedr_metadata_tree(root, "/Torrent Studio")
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
async def seedr_library_metadata():
    return await get_seedr_metadata_tree()


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


async def _fetch_seedr_hls_manifest(file_id: str) -> tuple[str, str]:
    upstream_url = _seedr_media_url(file_id, "video")
    async with httpx.AsyncClient(timeout=35, follow_redirects=True) as client:
        response = await client.get(upstream_url, headers={"Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"})
    if response.status_code >= 400:
        detail = response.text[:500] or f"Seedr media endpoint returned HTTP {response.status_code}"
        raise HTTPException(response.status_code, detail)

    content_type = str(response.headers.get("content-type") or "").lower()
    text = response.text
    if "#EXTM3U" not in text[:200]:
        raise HTTPException(
            502,
            "Seedr did not return an HLS manifest for this file. The file may still be converting."
        )

    final_url = str(response.url)
    host = urlsplit(final_url).hostname or ""
    if not host:
        raise HTTPException(502, "Seedr returned an invalid HLS URL")

    allowed_hosts = {host.lower()}
    # Capture hosts already referenced by the master/media playlist.
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
    return text, final_url


async def _get_hls_source(file_id: str) -> tuple[str, set[str]]:
    now = asyncio.get_running_loop().time()
    cached = _seedr_hls_sources.get(file_id)
    if cached and cached[0] > now:
        return cached[1], cached[2]

    _manifest, final_url = await _fetch_seedr_hls_manifest(file_id)
    cached = _seedr_hls_sources[file_id]
    return final_url, cached[2]


@app.get("/api/seedr/files/stream")
async def seedr_file_stream(
    file_id: str = Query(...),
    type: str = Query("video"),
    name: str = Query(""),
):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")

    if type == "video":
        # Validate the upstream first so the frontend gets a clear API error
        # instead of a generic manifestLoadError in Hls.js.
        await _fetch_seedr_hls_manifest(file_id)
        return {
            "url": "/api/seedr/hls/" + quote(file_id, safe=""),
            "name": name or file_id,
            "protocol": "hls",
        }

    # Keep audio on Seedr's native MP3 media endpoint.
    return {
        "url": "/api/seedr/media/audio/" + quote(file_id, safe=""),
        "name": name or file_id,
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


@app.get("/api/seedr/media/audio/{file_id}")
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
    result = await seedr_add(MagnetRequest(magnet=magnet))
    return {"added": True, **result}
