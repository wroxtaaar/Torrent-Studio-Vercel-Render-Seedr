import asyncio
import base64
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

APP_NAME = "Torrent Studio API"
SEEDR_BASE = "https://www.seedr.cc/api/v0.1/p"
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
                params={"query": query, "max_items": limit, "per_source": 15},
                headers={"Accept": "application/json"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Torrent search service unavailable: {exc}") from exc

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

    results: list[dict[str, Any]] = []
    for item in payload[:limit]:
        if not isinstance(item, dict):
            continue

        filename = str(item.get("filename") or item.get("title") or "").strip()
        if not filename:
            continue

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

@app.get("/api/seedr/files/stream")
async def seedr_file_stream(name: str = Query(...), type: str = Query("video")):
    # Seedr presentation URLs are account-dependent. Search the file and return
    # the media presentation URL when available; otherwise fail clearly.
    result = seedr_data(await seedr_request(f"/search/fs?query={quote(name)}"))
    candidates = arr(result, ("files", "items"))
    wanted = next((x for x in candidates if str(x.get("name") or "").lower() == Path(name).name.lower()), None)
    urls = wanted.get("presentation_urls") or wanted.get("presentationUrls") if isinstance(wanted, dict) else {}
    media = urls.get(type) if isinstance(urls, dict) else {}
    url = str(media.get("hls") or media.get("url") or media.get("stream") or "") if isinstance(media, dict) else ""
    if not url:
        raise HTTPException(404, f"No {type} playback URL is available from Seedr for this file")
    return {"url": url, "name": str(wanted.get("name") if isinstance(wanted, dict) else name)}

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
