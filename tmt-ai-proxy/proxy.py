#!/usr/bin/env python3
"""
Project-aware logging proxy for Anthropic API requests.

Forwards traffic to Anthropic and logs each request/response to a per-project
SQLite database under /data/<project>.db. The project name is extracted from
Claude Code's system prompt (the working directory) so the same proxy can
serve many concurrent project sessions.
"""
import asyncio
import json
import os
import pathlib
import re
from datetime import datetime
from typing import Optional

import aiohttp
import aiosqlite
from aiohttp import web

from prompt_extract import extract_user_prompt


PROXY_PORT = int(os.getenv("PROXY_PORT", "8080"))
TARGET_API_URL = os.getenv("TARGET_API_URL", "https://api.anthropic.com")
DATA_DIR = pathlib.Path(os.getenv("DATA_DIR", "/data"))
PROJECT_ROOT = os.getenv("PROJECT_ROOT", "/workspace").rstrip("/")
DEFAULT_PROJECT = os.getenv("DEFAULT_PROJECT", "default")

# aiohttp transparently decompresses the upstream response before we ever see
# it, so we may only advertise encodings it can actually decode. Claude Code
# asks for "gzip, deflate, br, zstd"; br needs the Brotli package (installed)
# and zstd is unsupported by aiohttp 3.9 entirely -- letting either through
# unhandled fails the whole request instead of just skipping compression.
def _decodable_encodings() -> str:
    encodings = ["gzip", "deflate"]
    try:
        import brotli  # noqa: F401

        encodings.append("br")
    except ImportError:
        pass
    return ", ".join(encodings)


ACCEPT_ENCODING = _decodable_encodings()

MIGRATIONS_DIR = pathlib.Path(__file__).parent / "migrations"
SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]")
SENSITIVE_HEADERS = {
    "authorization",
    "x-api-key",
    "anthropic-api-key",
    "x-claude-code-session-id",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-auth-token",
}


def redact_headers(headers: dict) -> dict:
    return {
        k: ("[REDACTED]" if k.lower() in SENSITIVE_HEADERS else v)
        for k, v in headers.items()
    }
CWD_PATTERNS = [
    # Match the project root literally, then capture the first segment.
    re.compile(
        r"(?:working\s+directory|cwd|workdir)\s*[:=]\s*" + re.escape(PROJECT_ROOT) + r"/([^/\s\"'\n\r]+)",
        re.IGNORECASE,
    ),
]


def sanitize_project(name: str) -> str:
    """Coerce a raw project string into something safe to use as a filename."""
    cleaned = SAFE_NAME_RE.sub("_", name).strip("._-")
    return cleaned or DEFAULT_PROJECT


def extract_project_name(request_body: Optional[str]) -> str:
    """
    Pull a project name out of the request body.

    Claude Code embeds its working directory in the system prompt; we look for
    `/workspace/<name>` (configurable via PROJECT_ROOT) and use <name> as the DB.
    """
    if not request_body:
        return DEFAULT_PROJECT

    try:
        body = json.loads(request_body)
    except (json.JSONDecodeError, TypeError):
        return DEFAULT_PROJECT

    # The system field can be a string OR a list of {type, text} blocks.
    system = body.get("system", "")
    if isinstance(system, list):
        haystack = "\n".join(
            block.get("text", "") for block in system if isinstance(block, dict)
        )
    else:
        haystack = str(system or "")

    # Also peek at the latest user message — Claude Code restates cwd there too.
    messages = body.get("messages") or []
    if isinstance(messages, list) and messages:
        last = messages[-1]
        if isinstance(last, dict):
            content = last.get("content")
            if isinstance(content, str):
                haystack += "\n" + content
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and isinstance(block.get("text"), str):
                        haystack += "\n" + block["text"]

    for pattern in CWD_PATTERNS:
        match = pattern.search(haystack)
        if match:
            return sanitize_project(match.group(1))

    return DEFAULT_PROJECT


def compact_streaming_response(raw_body: str) -> str:
    """
    Collapse an SSE response into a single JSON object so the DB stays small.
    Returns the original body unchanged if it isn't an SSE stream.
    """
    if not raw_body or not raw_body.strip().startswith("event:"):
        return raw_body

    chunk_count = 0
    blocks = {}  # index -> {"block": start block, "text": [], "json": []}
    metadata = {}
    usage = {}
    stream_error = None

    for line in raw_body.split("\n"):
        line = line.strip()
        if not line.startswith("data:"):
            continue

        data_str = line[5:].strip()
        if not data_str or data_str == "[DONE]":
            continue

        try:
            chunk = json.loads(data_str)
        except json.JSONDecodeError:
            continue
        chunk_count += 1
        ctype = chunk.get("type")

        if not metadata and ctype == "message_start":
            msg = chunk.get("message", {})
            metadata = {
                "id": msg.get("id"),
                "type": "message",
                "role": msg.get("role"),
                "model": msg.get("model"),
                "stop_reason": msg.get("stop_reason"),
                "stop_sequence": msg.get("stop_sequence"),
            }
            if msg.get("usage"):
                usage = msg.get("usage", {})

        if ctype == "error":
            stream_error = chunk.get("error") or {"type": "unknown", "message": ""}

        if ctype == "content_block_start":
            idx = chunk.get("index", len(blocks))
            blocks[idx] = {
                "block": dict(chunk.get("content_block") or {}),
                "text": [],
                "json": [],
            }

        if ctype == "content_block_delta":
            idx = chunk.get("index", 0)
            entry = blocks.setdefault(idx, {"block": {}, "text": [], "json": []})
            delta = chunk.get("delta", {})
            dtype = delta.get("type")
            if dtype == "text_delta":
                entry["text"].append(delta.get("text", ""))
            elif dtype == "thinking_delta":
                entry["text"].append(delta.get("thinking", ""))
            elif dtype == "input_json_delta":
                entry["json"].append(delta.get("partial_json", ""))

        if ctype == "message_delta":
            delta = chunk.get("delta", {})
            if delta.get("stop_reason"):
                metadata["stop_reason"] = delta.get("stop_reason")
            if chunk.get("usage"):
                usage.update(chunk.get("usage", {}))

    if not chunk_count:
        return raw_body

    content = []
    for idx in sorted(blocks):
        entry = blocks[idx]
        block = entry["block"]
        btype = block.get("type") or ("thinking" if entry["text"] else "text")
        joined = "".join(entry["text"])
        if btype == "thinking":
            block["thinking"] = joined
            block.pop("signature", None)
        elif btype == "text":
            block["text"] = joined
        elif btype == "tool_use":
            raw_input = "".join(entry["json"])
            try:
                block["input"] = json.loads(raw_input) if raw_input else {}
            except json.JSONDecodeError:
                block["input_json"] = raw_input
        content.append(block)
    if not content:
        content = [{"type": "text", "text": ""}]

    compacted = {
        **metadata,
        "content": content,
        "usage": usage,
        "_compacted": {
            "original_chunks": chunk_count,
            "compacted_at": datetime.utcnow().isoformat(),
        },
    }
    if stream_error:
        compacted["error"] = stream_error
        if not metadata:
            compacted["type"] = "error"
    return json.dumps(compacted)


class ProjectLogger:
    """Per-project SQLite logger. Migrations run lazily on first write."""

    def __init__(self, data_dir: pathlib.Path):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._initialized: set[str] = set()
        self._init_lock = asyncio.Lock()

    def db_path_for(self, project: str) -> pathlib.Path:
        return self.data_dir / f"{project}.db"

    async def ensure_initialized(self, project: str):
        if project in self._initialized:
            return
        async with self._init_lock:
            if project in self._initialized:
                return
            db_path = self.db_path_for(project)
            async with aiosqlite.connect(db_path) as db:
                await self._run_migrations(db)
            self._initialized.add(project)
            print(f"  ✓ Initialized DB for project '{project}' at {db_path}")

    async def _run_migrations(self, db):
        import importlib.util

        if not MIGRATIONS_DIR.exists():
            print(f"  ! No migrations directory at {MIGRATIONS_DIR}")
            return

        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename TEXT PRIMARY KEY,
                applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        await db.commit()

        cursor = await db.execute("SELECT filename FROM schema_migrations")
        applied = {row[0] for row in await cursor.fetchall()}

        sql_files = list(MIGRATIONS_DIR.glob("*.sql"))
        py_files = list(MIGRATIONS_DIR.glob("*.py"))
        for migration in sorted(sql_files + py_files, key=lambda f: f.name):
            if migration.name in applied:
                continue
            try:
                if migration.suffix == ".sql":
                    await db.executescript(migration.read_text())
                else:
                    spec = importlib.util.spec_from_file_location(
                        migration.stem, migration
                    )
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    if hasattr(module, "migrate"):
                        await module.migrate(db)
                await db.execute(
                    "INSERT INTO schema_migrations (filename) VALUES (?)",
                    (migration.name,),
                )
                await db.commit()
            except Exception as e:
                print(f"  ✗ Migration {migration.name} failed: {e}")
                raise

    async def log_request(
        self,
        project: str,
        method: str,
        path: str,
        target_url: str,
        request_headers: dict,
        request_body: Optional[str],
        response_status: int,
        response_headers: dict,
        response_body: Optional[str],
        duration_ms: int,
        session_id: Optional[str] = None,
    ):
        await self.ensure_initialized(project)

        timestamp = datetime.utcnow().isoformat()
        request_headers_json = json.dumps(dict(request_headers))
        response_headers_json = json.dumps(dict(response_headers))

        request_body_json = None
        prompt_text = None
        if request_body:
            try:
                parsed = json.loads(request_body)
                request_body_json = json.dumps(parsed)
                prompt_text = extract_user_prompt(parsed)
            except json.JSONDecodeError:
                request_body_json = json.dumps({"raw": request_body})

        db_path = self.db_path_for(project)
        try:
            async with aiosqlite.connect(db_path) as db:
                cursor = await db.execute(
                    """
                    INSERT INTO request_logs
                    (timestamp, method, path, target_url, request_headers, request_body,
                     response_status, response_headers, response_body, duration_ms, session_id)
                    VALUES (?, ?, ?, ?, json(?), json(?), ?, json(?), ?, ?, ?)
                    """,
                    (
                        timestamp,
                        method,
                        path,
                        target_url,
                        request_headers_json,
                        request_body_json,
                        response_status,
                        response_headers_json,
                        response_body,
                        duration_ms,
                        session_id,
                    ),
                )
                # Human-typed prompts get their own row so the viewer can list
                # them without re-parsing bodies (see prompt_extract.py).
                if prompt_text is not None:
                    await db.execute(
                        "INSERT OR IGNORE INTO user_prompts"
                        " (log_id, session_id, timestamp, prompt_text) VALUES (?, ?, ?, ?)",
                        (cursor.lastrowid, session_id, timestamp, prompt_text),
                    )
                await db.commit()
        except Exception as e:
            print(f"✗ Failed to write log for project '{project}' ({db_path}): {e}")
            raise


# Anthropic's own error envelope, so the CLI prints the message instead of a
# bare "Proxy error" body.
def error_response(status: int, err_type: str, message: str) -> web.Response:
    return web.json_response(
        {"type": "error", "error": {"type": err_type, "message": message}},
        status=status,
    )


async def proxy_handler(request: web.Request) -> web.Response:
    logger: ProjectLogger = request.app["logger"]
    target_api_url: str = request.app["target_api_url"]
    start_time = asyncio.get_event_loop().time()

    target_url = f"{target_api_url}{request.path_qs}"

    request_body = await request.text() if request.body_exists else None

    forward_headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower()
        not in ("host", "connection", "keep-alive", "transfer-encoding", "accept-encoding")
    }
    forward_headers["Accept-Encoding"] = ACCEPT_ENCODING

    project = extract_project_name(request_body)
    session_id = request.headers.get("x-claude-code-session-id")

    try:
        async with aiohttp.ClientSession() as session:
            async with session.request(
                method=request.method,
                url=target_url,
                headers=forward_headers,
                data=request_body,
                allow_redirects=False,
            ) as response:
                response_body = await response.read()
                duration_ms = int((asyncio.get_event_loop().time() - start_time) * 1000)

                response_headers = {
                    k: v
                    for k, v in response.headers.items()
                    if k.lower()
                    not in (
                        "connection",
                        "keep-alive",
                        "transfer-encoding",
                        "upgrade",
                        "proxy-authenticate",
                        "proxy-authorization",
                        "te",
                        "trailers",
                        "content-encoding",
                        "content-length",
                    )
                }

                try:
                    response_body_text = response_body.decode("utf-8")
                    if response_body_text.strip().startswith("event:"):
                        response_body_text = compact_streaming_response(response_body_text)
                except UnicodeDecodeError:
                    response_body_text = f"<binary data, {len(response_body)} bytes>"

                await logger.log_request(
                    project=project,
                    method=request.method,
                    path=request.path_qs,
                    target_url=target_url,
                    request_headers=redact_headers(dict(request.headers)),
                    request_body=request_body,
                    response_status=response.status,
                    response_headers=redact_headers(response_headers),
                    response_body=response_body_text,
                    duration_ms=duration_ms,
                    session_id=session_id,
                )

                print(
                    f"[{project}] {request.method} {request.path} -> "
                    f"{response.status} ({duration_ms}ms)"
                )

                return web.Response(
                    status=response.status,
                    headers=response_headers,
                    body=response_body,
                )
    except (aiohttp.ClientConnectionError, asyncio.TimeoutError) as e:
        # Genuinely transient: upstream unreachable / dropped. 5xx so the client
        # retries.
        print(f"Upstream connection error: {e}")
        return error_response(
            502, "api_error", f"tmt-ai-proxy could not reach {target_api_url}: {e}"
        )
    except Exception as e:
        # A fault in the proxy itself. Retrying re-runs the same broken path and
        # burns tokens, so answer with a non-retryable 4xx to surface it at once.
        print(f"Error proxying request: {e}")
        import traceback

        traceback.print_exc()
        return error_response(
            400,
            "invalid_request_error",
            f"tmt-ai-proxy failed to handle this request: {e} "
            "(proxy-side fault, not retryable -- check `docker logs tmt-ai-proxy`)",
        )


async def health_check(request: web.Request) -> web.Response:
    return web.Response(text="OK")


async def init_app() -> web.Application:
    app = web.Application()
    logger = ProjectLogger(DATA_DIR)
    # Pre-init the default DB so Datasette has something to mount at startup,
    # and migrate every existing project DB so new migrations (e.g. the
    # user_prompts backfill) apply without waiting for fresh traffic.
    await logger.ensure_initialized(DEFAULT_PROJECT)
    for db_file in sorted(DATA_DIR.glob("*.db")):
        if db_file.name.startswith("."):  # skip .viewer-state.db etc.
            continue
        try:
            await logger.ensure_initialized(db_file.stem)
        except Exception as e:
            print(f"  ! Failed to initialize '{db_file.stem}': {e}")
    app["logger"] = logger
    app["target_api_url"] = TARGET_API_URL

    app.router.add_route("*", "/health", health_check)
    app.router.add_route("*", "/{path:.*}", proxy_handler)
    return app


def main():
    print(f"Starting project-aware logging proxy on port {PROXY_PORT}")
    print(f"Forwarding to: {TARGET_API_URL}")
    print(f"Data directory: {DATA_DIR}")
    print(f"Project root inside container: {PROJECT_ROOT}")
    print(f"Fallback project: {DEFAULT_PROJECT}")
    web.run_app(init_app(), host="0.0.0.0", port=PROXY_PORT)


if __name__ == "__main__":
    main()
