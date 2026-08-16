#!/usr/bin/env python3
"""
Web viewer for the request/response logs written by tmt-ai-proxy.

Serves a single-page UI plus a small JSON API over the per-project SQLite
databases in /data. Read/unread state lives in /data/.viewer-state.db (the
dot prefix keeps it out of Datasette's /data/*.db glob); deletes remove rows
from the project DB itself.

Stdlib only — no pip dependencies.
"""
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import sqlite3
import threading
import time
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.getenv("VIEWER_PORT", "8034"))
DATA_DIR = pathlib.Path(os.getenv("DATA_DIR", "/data"))
STATE_DB = DATA_DIR / ".viewer-state.db"
STATIC_DIR = pathlib.Path(__file__).parent / "static"
DOCKER_API = os.getenv("DOCKER_API", "http://tmt-ai-docker-proxy:2375").rstrip("/")
CODE_CONTAINER = os.getenv("CODE_CONTAINER", "tmt-ai-code")
OWN_COMPOSE_PROJECT = os.getenv("OWN_COMPOSE_PROJECT", "tmt-ai")

AUTH_PASSWORD = os.getenv("VIEWER_PASSWORD", "")
MAX_LOGIN_ATTEMPTS = int(os.getenv("VIEWER_MAX_ATTEMPTS", "5"))
LOCKOUT_SECONDS = int(os.getenv("VIEWER_LOCKOUT_SECONDS", "300"))
SESSION_TTL_SECONDS = int(os.getenv("VIEWER_SESSION_TTL", str(30 * 86400)))
SESSION_COOKIE = "viewer_session"

PROJECT_RE = re.compile(r"^[A-Za-z0-9._-]+$")
SNIPPET_LEN = 240

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")


def valid_project(name: str) -> bool:
    return (
        bool(name)
        and not name.startswith(".")
        and PROJECT_RE.match(name) is not None
        and (DATA_DIR / f"{name}.db").is_file()
    )


def connect(db_path: pathlib.Path, attach_state: bool = False) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    if attach_state:
        ensure_state_db()
        conn.execute("ATTACH DATABASE ? AS state", (str(STATE_DB),))
    return conn


_state_ready = False


def ensure_state_db():
    global _state_ready
    if _state_ready:
        return
    with sqlite3.connect(STATE_DB, timeout=10) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS read_state (
                project TEXT NOT NULL,
                log_id  INTEGER NOT NULL,
                read_at TEXT NOT NULL,
                PRIMARY KEY (project, log_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                expires_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                project TEXT NOT NULL,
                prompt TEXT NOT NULL,
                session_id TEXT,
                resume_session_id TEXT,
                status TEXT NOT NULL DEFAULT 'running',
                exit_code INTEGER,
                output TEXT,
                error TEXT,
                started_at TEXT NOT NULL,
                finished_at TEXT
            )
            """
        )
        existing = {
            row[1] for row in conn.execute("PRAGMA table_info(runs)").fetchall()
        }
        for col, ddl in (
            ("error_detail", "error_detail TEXT"),
            ("limit_hit", "limit_hit INTEGER NOT NULL DEFAULT 0"),
            ("resume_at", "resume_at TEXT"),
            ("auto_resumed", "auto_resumed INTEGER NOT NULL DEFAULT 0"),
        ):
            if col not in existing:
                conn.execute(f"ALTER TABLE runs ADD COLUMN {ddl}")
    _state_ready = True


# -- auth (password gate + login lockout) ------------------------------------

_auth_lock = threading.Lock()
_session_cache: set = set()
_login_attempts: dict = {}  # ip -> {"count": int, "locked_until": float}


def auth_enabled() -> bool:
    return bool(AUTH_PASSWORD)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session() -> str:
    token = secrets.token_hex(32)
    ensure_state_db()
    now = time.time()
    with sqlite3.connect(STATE_DB, timeout=10) as conn:
        conn.execute("PRAGMA busy_timeout = 10000")
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        conn.execute(
            "INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
            (_token_hash(token), utcnow(), now + SESSION_TTL_SECONDS),
        )
    with _auth_lock:
        _session_cache.add(_token_hash(token))
    return token


def session_valid(token: str) -> bool:
    if not token:
        return False
    h = _token_hash(token)
    with _auth_lock:
        if h in _session_cache:
            return True
    ensure_state_db()
    with sqlite3.connect(STATE_DB, timeout=10) as conn:
        row = conn.execute(
            "SELECT expires_at FROM sessions WHERE token_hash = ?", (h,)
        ).fetchone()
    if row is None or row[0] < time.time():
        return False
    with _auth_lock:
        _session_cache.add(h)
    return True


def destroy_session(token: str):
    if not token:
        return
    h = _token_hash(token)
    with _auth_lock:
        _session_cache.discard(h)
    ensure_state_db()
    with sqlite3.connect(STATE_DB, timeout=10) as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (h,))


def lockout_remaining(ip: str) -> int:
    with _auth_lock:
        entry = _login_attempts.get(ip)
        if entry and entry["locked_until"] > time.time():
            return int(entry["locked_until"] - time.time()) + 1
        return 0


def register_failed_login(ip: str) -> tuple[int, int]:
    """Record a bad password. Returns (attempts_left, lockout_seconds)."""
    with _auth_lock:
        entry = _login_attempts.setdefault(ip, {"count": 0, "locked_until": 0})
        entry["count"] += 1
        if entry["count"] >= MAX_LOGIN_ATTEMPTS:
            entry["count"] = 0
            entry["locked_until"] = time.time() + LOCKOUT_SECONDS
            return 0, LOCKOUT_SECONDS
        return MAX_LOGIN_ATTEMPTS - entry["count"], 0


def clear_failed_logins(ip: str):
    with _auth_lock:
        _login_attempts.pop(ip, None)


def list_projects() -> list:
    projects = []
    for db_file in sorted(DATA_DIR.glob("*.db")):
        name = db_file.stem
        if not valid_project(name):
            continue
        try:
            with connect(db_file, attach_state=True) as conn:
                row = conn.execute(
                    """
                    SELECT COUNT(*) AS total,
                           SUM(CASE WHEN s.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
                           MAX(r.timestamp) AS last_ts
                    FROM request_logs r
                    LEFT JOIN state.read_state s
                      ON s.project = ? AND s.log_id = r.id
                    """,
                    (name,),
                ).fetchone()
        except sqlite3.Error:
            continue
        projects.append(
            {
                "name": name,
                "total": row["total"] or 0,
                "unread": row["unread"] or 0,
                "last_ts": row["last_ts"],
            }
        )
    projects.sort(key=lambda p: p["last_ts"] or "", reverse=True)
    return projects


def extract_text_blocks(content) -> str:
    """Flatten a message content field (string or block list) into plain text."""
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                parts.append(block.get("text", ""))
            elif btype == "tool_use":
                parts.append(f"[tool: {block.get('name', '?')}]")
            elif btype == "tool_result":
                parts.append("[tool result]")
            elif btype == "thinking":
                parts.append("[thinking]")
            elif btype == "image":
                parts.append("[image]")
    return " ".join(p for p in parts if p)


def squash(text: str, limit: int = SNIPPET_LEN) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text[:limit]


REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)


def user_ask_text(content) -> str:
    """Plain text a human actually typed: text blocks only, reminders stripped."""
    if isinstance(content, str):
        texts = [content]
    elif isinstance(content, list):
        texts = [
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        ]
    else:
        return ""
    return REMINDER_RE.sub("", "\n".join(texts)).strip()


def summarize_row(row: sqlite3.Row) -> dict:
    model = None
    request_snippet = ""
    num_messages = None
    try:
        body = json.loads(row["request_body"]) if row["request_body"] else {}
        model = body.get("model")
        messages = body.get("messages") or []
        num_messages = len(messages) if isinstance(messages, list) else None
        for msg in reversed(messages if isinstance(messages, list) else []):
            if isinstance(msg, dict) and msg.get("role") == "user":
                request_snippet = squash(user_ask_text(msg.get("content")))
                if request_snippet:
                    break
    except (json.JSONDecodeError, TypeError):
        pass

    response_snippet = ""
    stop_reason = None
    usage = {}
    raw_resp = row["response_body"]
    if raw_resp:
        try:
            resp = json.loads(raw_resp)
            if isinstance(resp, dict):
                stop_reason = resp.get("stop_reason")
                usage = resp.get("usage") or {}
                if resp.get("type") == "error":
                    err = resp.get("error") or {}
                    response_snippet = squash(
                        f"ERROR {err.get('type', '')}: {err.get('message', '')}"
                    )
                else:
                    blocks = resp.get("content") or []
                    texts = [
                        b.get("text", "")
                        for b in blocks
                        if isinstance(b, dict) and b.get("type") == "text"
                    ]
                    response_snippet = squash(
                        " ".join(t for t in texts if t)
                    ) or squash(extract_text_blocks(blocks))
        except (json.JSONDecodeError, TypeError):
            response_snippet = squash(raw_resp)

    summary = {
        "id": row["id"],
        "timestamp": row["timestamp"],
        "method": row["method"],
        "path": row["path"],
        "response_status": row["response_status"],
        "duration_ms": row["duration_ms"],
        "read_at": row["read_at"],
        "model": model,
        "num_messages": num_messages,
        "request_snippet": request_snippet,
        "response_snippet": response_snippet,
        "stop_reason": stop_reason,
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "cache_read_tokens": usage.get("cache_read_input_tokens"),
    }
    keys = row.keys()
    for k in ("session_id", "session_count", "session_unread", "session_first_ts"):
        if k in keys:
            summary[k] = row[k]
    return summary


def _tok(field: str) -> str:
    return (
        "CASE WHEN r.response_body IS NOT NULL AND json_valid(r.response_body)"
        f" THEN COALESCE(json_extract(r.response_body, '$.usage.{field}'), 0)"
        " ELSE 0 END"
    )


TOKEN_SUMS = ", ".join(
    f"COALESCE(SUM({_tok(field)}), 0) AS {alias}"
    for field, alias in (
        ("input_tokens", "input_tokens"),
        ("output_tokens", "output_tokens"),
        ("cache_creation_input_tokens", "cache_creation_tokens"),
        ("cache_read_input_tokens", "cache_read_tokens"),
    )
)
TOKEN_KEYS = ("input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens")


def usage_recent(minutes: int = 5) -> dict:
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).strftime(
        "%Y-%m-%dT%H:%M:%S.%f"
    )
    totals = {k: 0 for k in TOKEN_KEYS}
    request_count = 0
    consumers = []
    for db_file in sorted(DATA_DIR.glob("*.db")):
        name = db_file.stem
        if not valid_project(name):
            continue
        try:
            with note_conn(name) as conn:
                total_row = conn.execute(
                    f"SELECT COUNT(*) AS n, {TOKEN_SUMS} FROM request_logs r"
                    " WHERE r.timestamp >= ?",
                    (cutoff,),
                ).fetchone()
                if not total_row["n"]:
                    continue
                request_count += total_row["n"]
                for k in TOKEN_KEYS:
                    totals[k] += total_row[k] or 0
                rows = conn.execute(
                    f"""
                    SELECT r.session_id AS session_id,
                           COUNT(*) AS requests, {TOKEN_SUMS}
                    FROM request_logs r
                    WHERE r.timestamp >= ?
                    GROUP BY r.session_id
                    """,
                    (cutoff,),
                ).fetchall()
        except sqlite3.Error:
            continue
        for row in rows:
            entry = {k: row[k] or 0 for k in TOKEN_KEYS}
            entry.update(
                {
                    "project": name,
                    "session_id": row["session_id"],
                    "requests": row["requests"],
                    "tokens": (row["input_tokens"] or 0) + (row["output_tokens"] or 0),
                }
            )
            consumers.append(entry)
    consumers.sort(key=lambda c: c["tokens"], reverse=True)
    return {
        "minutes": minutes,
        "requests": request_count,
        "tokens": totals["input_tokens"] + totals["output_tokens"],
        **totals,
        "top": consumers[:5],
    }


def has_session_column(conn: sqlite3.Connection) -> bool:
    return any(
        r[1] == "session_id"
        for r in conn.execute("PRAGMA table_info(request_logs)").fetchall()
    )


def query_requests(project: str, params: dict) -> dict:
    limit = min(int(params.get("limit", 50)), 200)
    offset = max(int(params.get("offset", 0)), 0)

    where = []
    args = [project]
    q = (params.get("q") or "").strip()
    if q:
        like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        where.append(
            "(r.request_body LIKE ? ESCAPE '\\' OR r.response_body LIKE ? ESCAPE '\\'"
            " OR r.path LIKE ? ESCAPE '\\')"
        )
        args += [like, like, like]

    model = (params.get("model") or "").strip()
    if model:
        where.append("json_extract(r.request_body, '$.model') = ?")
        args.append(model)

    status = (params.get("status") or "").strip()
    if re.fullmatch(r"[1-5]xx", status):
        lo = int(status[0]) * 100
        where.append("r.response_status BETWEEN ? AND ?")
        args += [lo, lo + 99]
    elif status.isdigit():
        where.append("r.response_status = ?")
        args.append(int(status))

    if params.get("unread") == "1":
        where.append("s.read_at IS NULL")

    with connect(DATA_DIR / f"{project}.db", attach_state=True) as conn:
        has_session = has_session_column(conn)
        session_col = "r.session_id" if has_session else "NULL AS session_id"

        sid = (params.get("session_id") or "").strip()
        if sid and has_session:
            where.append("r.session_id = ?")
            args.append(sid)

        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        base = f"""
            FROM request_logs r
            LEFT JOIN state.read_state s ON s.project = ? AND s.log_id = r.id
            {where_sql}
        """
        if params.get("view") == "sessions" and has_session and not sid:
            group_expr = "COALESCE(r.session_id, 'solo:' || r.id)"
            total = conn.execute(
                f"SELECT COUNT(DISTINCT {group_expr}) {base}", args
            ).fetchone()[0]
            rows = conn.execute(
                f"""
                WITH g AS (
                    SELECT MAX(r.id) AS mid,
                           COUNT(*) AS session_count,
                           SUM(CASE WHEN s.read_at IS NULL THEN 1 ELSE 0 END) AS session_unread,
                           MIN(r.timestamp) AS session_first_ts
                    {base}
                    GROUP BY {group_expr}
                )
                SELECT r.id, r.timestamp, r.method, r.path, r.response_status,
                       r.duration_ms, r.request_body, r.response_body, r.session_id,
                       s.read_at, g.session_count, g.session_unread, g.session_first_ts
                FROM g
                JOIN request_logs r ON r.id = g.mid
                LEFT JOIN state.read_state s ON s.project = ? AND s.log_id = r.id
                ORDER BY r.id DESC LIMIT ? OFFSET ?
                """,
                args + [project, limit, offset],
            ).fetchall()
        else:
            total = conn.execute(f"SELECT COUNT(*) {base}", args).fetchone()[0]
            rows = conn.execute(
                f"""
                SELECT r.id, r.timestamp, r.method, r.path, r.response_status,
                       r.duration_ms, r.request_body, r.response_body, {session_col},
                       s.read_at
                {base}
                ORDER BY r.id DESC LIMIT ? OFFSET ?
                """,
                args + [limit, offset],
            ).fetchall()
        models = [
            m[0]
            for m in conn.execute(
                "SELECT DISTINCT json_extract(request_body, '$.model') FROM request_logs"
                " WHERE json_extract(request_body, '$.model') IS NOT NULL ORDER BY 1"
            ).fetchall()
        ]

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "models": models,
        "requests": [summarize_row(r) for r in rows],
    }


def get_request_detail(project: str, log_id: int) -> dict | None:
    with note_conn(project, attach_state=True) as conn:
        row = conn.execute(
            """
            SELECT r.*, s.read_at
            FROM request_logs r
            LEFT JOIN state.read_state s ON s.project = ? AND s.log_id = r.id
            WHERE r.id = ?
            """,
            (project, log_id),
        ).fetchone()
        if row is None:
            return None
    return {key: row[key] for key in row.keys()}


def mark_read(project: str, ids: list, read: bool):
    ensure_state_db()
    now = utcnow()
    with sqlite3.connect(STATE_DB, timeout=10) as conn:
        conn.execute("PRAGMA busy_timeout = 10000")
        if read:
            conn.executemany(
                "INSERT OR REPLACE INTO read_state (project, log_id, read_at) VALUES (?, ?, ?)",
                [(project, i, now) for i in ids],
            )
        else:
            conn.executemany(
                "DELETE FROM read_state WHERE project = ? AND log_id = ?",
                [(project, i) for i in ids],
            )


def mark_session_read(project: str, session_id: str, read: bool):
    ensure_state_db()
    now = utcnow()
    try:
        with connect(DATA_DIR / f"{project}.db", attach_state=True) as conn:
            if read:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO state.read_state (project, log_id, read_at)
                    SELECT ?, id, ? FROM request_logs WHERE session_id = ?
                    """,
                    (project, now, session_id),
                )
            else:
                conn.execute(
                    """
                    DELETE FROM state.read_state WHERE project = ?
                    AND log_id IN (SELECT id FROM request_logs WHERE session_id = ?)
                    """,
                    (project, session_id),
                )
            conn.commit()
    except sqlite3.OperationalError:
        pass  # request_logs.session_id column not migrated yet


def mark_all_read(project: str):
    ensure_state_db()
    now = utcnow()
    with connect(DATA_DIR / f"{project}.db", attach_state=True) as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO state.read_state (project, log_id, read_at)
            SELECT ?, id, ? FROM request_logs
            """,
            (project, now),
        )
        conn.commit()


def mark_all_read_everywhere() -> int:
    count = 0
    for db_file in sorted(DATA_DIR.glob("*.db")):
        name = db_file.stem
        if not valid_project(name):
            continue
        try:
            mark_all_read(name)
            count += 1
        except sqlite3.Error:
            continue
    return count


def delete_requests(project: str, ids: list) -> int:
    placeholders = ",".join("?" for _ in ids)
    with note_conn(project) as conn:
        cur = conn.execute(
            f"DELETE FROM request_logs WHERE id IN ({placeholders})", ids
        )
        conn.commit()
        deleted = cur.rowcount
    ensure_state_db()
    with sqlite3.connect(STATE_DB, timeout=10) as conn:
        conn.executemany(
            "DELETE FROM read_state WHERE project = ? AND log_id = ?",
            [(project, i) for i in ids],
        )
    return deleted


# -- docker integration (via tmt-ai-docker-proxy) -------------------------

def docker_request(path: str, payload: dict | None = None, timeout: int = 10) -> bytes:
    import urllib.request

    url = f"{DOCKER_API}{path}"
    if payload is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def docker_json(path: str, payload: dict | None = None):
    raw = docker_request(path, payload)
    return json.loads(raw) if raw else None


def demux_docker_stream(raw: bytes) -> tuple[str, str]:
    """Split docker's multiplexed exec stream into (stdout, stderr)."""
    out, err = [], []
    i = 0
    while i + 8 <= len(raw):
        stream_type = raw[i]
        length = int.from_bytes(raw[i + 4 : i + 8], "big")
        if stream_type not in (0, 1, 2) or i + 8 + length > len(raw):
            # Not a framed stream (tty mode) — treat everything as stdout.
            return raw.decode("utf-8", "replace"), ""
        chunk = raw[i + 8 : i + 8 + length].decode("utf-8", "replace")
        (err if stream_type == 2 else out).append(chunk)
        i += 8 + length
    return "".join(out), "".join(err)


def docker_exec(container: str, cmd: list) -> tuple[str, str]:
    created = docker_json(
        f"/containers/{container}/exec",
        {"AttachStdout": True, "AttachStderr": True, "Cmd": cmd},
    )
    raw = docker_request(
        f"/exec/{created['Id']}/start", {"Detach": False, "Tty": False}, timeout=15
    )
    return demux_docker_stream(raw)


def compose_project_name(directory: str) -> str:
    """Mimic docker compose's default project naming (dir basename, normalized)."""
    base = os.path.basename(directory.rstrip("/")).lower()
    return re.sub(r"[^a-z0-9_-]", "", base)


def project_docker_status(project: str) -> dict:
    try:
        code_info = docker_json(f"/containers/{CODE_CONTAINER}/json")
        host_dir = None
        for mount in code_info.get("Mounts", []):
            if mount.get("Destination") == f"/workspace/{project}":
                host_dir = mount.get("Source")
                break

        containers = docker_json("/containers/json?all=1") or []
        matches = []
        for c in containers:
            labels = c.get("Labels") or {}
            compose_proj = labels.get("com.docker.compose.project", "")
            if compose_proj == OWN_COMPOSE_PROJECT:
                continue
            working_dir = labels.get("com.docker.compose.project.working_dir", "")
            name = (c.get("Names") or ["/?"])[0].lstrip("/")
            matched = False
            if host_dir and working_dir and working_dir.startswith(host_dir.rstrip("/")):
                matched = True
            elif host_dir and compose_proj == compose_project_name(host_dir):
                matched = True
            elif project.lower() in name.lower():
                matched = True
            if matched:
                matches.append(
                    {
                        "name": name,
                        "service": labels.get("com.docker.compose.service"),
                        "compose_project": compose_proj or None,
                        "image": c.get("Image"),
                        "state": c.get("State"),
                        "status": c.get("Status"),
                    }
                )
        matches.sort(key=lambda c: (c["state"] != "running", c["name"]))
        return {
            "available": True,
            "host_dir": host_dir,
            "mounted": host_dir is not None,
            "containers": matches,
        }
    except Exception as e:
        return {"available": False, "reason": str(e), "containers": []}


CONTEXT_FILE_CANDIDATES = [
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".claude/CLAUDE.md",
    ".claude/settings.json",
    ".claude/settings.local.json",
]
CONTEXT_MARKER = "-----TMT-AI-VIEWER-FILE-----"


def project_context(project: str) -> dict:
    """Read CLAUDE.md / .claude context files by exec'ing cat inside tmt-ai-code,
    which already has every project bind-mounted under /workspace."""
    candidates = " ".join(f'"{f}"' for f in CONTEXT_FILE_CANDIDATES)
    script = (
        f'cd "/workspace/{project}" 2>/dev/null || exit 3; '
        f"for f in {candidates} .claude/rules/*.md .claude/agents/*.md; do "
        f'[ -f "$f" ] && {{ echo "{CONTEXT_MARKER}$f"; cat "$f"; echo; }}; '
        "done; true"
    )
    try:
        stdout, stderr = docker_exec(CODE_CONTAINER, ["sh", "-c", script])
    except Exception as e:
        return {"available": False, "reason": str(e), "files": []}

    files = []
    for section in stdout.split(CONTEXT_MARKER):
        if not section.strip():
            continue
        first_nl = section.find("\n")
        if first_nl == -1:
            continue
        files.append(
            {"path": section[:first_nl].strip(), "content": section[first_nl + 1 :]}
        )
    return {"available": True, "files": files, "stderr": stderr.strip() or None}


# -- prompt runs (claude -p inside tmt-ai-code) ------------------------------

RUN_TIMEOUT = int(os.getenv("RUN_TIMEOUT", "3600"))
RUN_PROMPT_SUFFIX = os.getenv(
    "RUN_PROMPT_SUFFIX",
    "If something extra pops up that is worth returning to later (follow-up"
    " work, proposals, ideas), do not do it now — end your final reply with a"
    " 'NOTES:' section listing each item as a '- [ ] item' line; it is saved"
    " to the project notes.",
)
RUN_NO_QUESTIONS = os.getenv(
    "RUN_NO_QUESTIONS",
    "This task was dispatched from the web dashboard and runs"
    " non-interactively: no one can see or answer clarifying questions. Do not"
    " ask any — make the most reasonable assumptions, state them briefly, and"
    " carry the task through to completion. If a decision is genuinely"
    " blocking, pick the safest sensible default, note it in your final reply,"
    " and keep going rather than stopping to ask.",
)
NOTES_MARKER_RE = re.compile(r"^NOTES:[ \t]*(.*)", re.I | re.M)
RUNS: dict = {}
RUNS_LOCK = threading.Lock()

LIMIT_RETRY_MINUTES = int(os.getenv("RUN_LIMIT_RETRY_MINUTES", "30"))
LIMIT_RE = re.compile(
    r"(?:session|usage|rate)[ _-]?limit|limit reached|hit your .{0,20}limit", re.I
)
RESET_RE = re.compile(
    r"resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*(?:\(?\s*utc\s*\)?)?", re.I
)


def log_run(run_id: str, msg: str):
    print(f"[run {run_id}] {msg}", flush=True)


def parse_limit_reset(text: str) -> str | None:
    """'resets 3am (UTC)' → ISO timestamp of the next 3:00 UTC; None if the
    message names no time."""
    m = RESET_RE.search(text or "")
    if not m or not m.group(1):
        return None
    hour, minute = int(m.group(1)), int(m.group(2) or 0)
    ampm = (m.group(3) or "").lower()
    if ampm == "pm" and hour < 12:
        hour += 12
    if ampm == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None
    now = datetime.now(timezone.utc)
    candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate.strftime("%Y-%m-%dT%H:%M:%S.%f")


def detect_limit(info: dict):
    """If the run died on a usage/rate/session limit, mark it resumable and
    schedule the retry for when the limit resets."""
    haystack = f"{info.get('error') or ''}\n{info.get('output') or ''}"
    if not LIMIT_RE.search(haystack):
        return
    info["limit_hit"] = 1
    info["resume_at"] = parse_limit_reset(haystack) or (
        datetime.now(timezone.utc) + timedelta(minutes=LIMIT_RETRY_MINUTES)
    ).strftime("%Y-%m-%dT%H:%M:%S.%f")
    log_run(
        info["id"],
        f"limit hit ({squash(haystack.strip(), 120)}) — auto-continue at "
        f"{info['resume_at']} UTC",
    )


_exec_user = None


def code_container_user() -> str | None:
    """claude refuses bypassPermissions as root, so exec as the container's
    own uid:gid (from its USER_UID/USER_GID env)."""
    global _exec_user
    if _exec_user is not None:
        return _exec_user or None
    _exec_user = ""
    try:
        info = docker_json(f"/containers/{CODE_CONTAINER}/json")
        env = dict(
            item.split("=", 1) for item in info["Config"].get("Env", []) if "=" in item
        )
        if env.get("USER_UID"):
            _exec_user = f"{env['USER_UID']}:{env.get('USER_GID', env['USER_UID'])}"
    except Exception:
        pass
    return _exec_user or None


def docker_exec_run(
    cmd: list, workdir: str, timeout: int, run_id: str
) -> tuple[str, str, int, str | None]:
    """Run cmd in the code container, returning (stdout, stderr, exit_code,
    stream_note). Output goes to files inside the container and is fetched
    after exit: the docker-socket-proxy (haproxy) drops attach streams that
    stay quiet for ~10 min, and claude -p prints nothing until it finishes,
    so the attach stream alone loses long runs (IncompleteRead). If the
    stream drops we keep polling the exec until it actually exits."""
    import shlex

    out_file = f"/tmp/tmt-run-{run_id}.out"
    err_file = f"/tmp/tmt-run-{run_id}.err"
    shell = f"{shlex.join(cmd)} >{shlex.quote(out_file)} 2>{shlex.quote(err_file)}"
    payload = {
        "AttachStdout": True,
        "AttachStderr": True,
        "Cmd": ["sh", "-c", shell],
        "WorkingDir": workdir,
    }
    user = code_container_user()
    if user:
        payload["User"] = user
    created = docker_json(f"/containers/{CODE_CONTAINER}/exec", payload)
    exec_id = created["Id"]
    deadline = time.time() + timeout
    stream_note = None
    try:
        docker_request(
            f"/exec/{exec_id}/start", {"Detach": False, "Tty": False}, timeout=timeout
        )
    except Exception as e:
        stream_note = (
            f"attach stream lost ({type(e).__name__}: {e}); "
            "polled exec until exit and recovered output from files"
        )
        log_run(run_id, f"WARNING {stream_note}")
        while time.time() < deadline:
            inspect = docker_json(f"/exec/{exec_id}/json") or {}
            if not inspect.get("Running"):
                break
            time.sleep(5)
        else:
            stream_note += f"; still running after {timeout}s, gave up waiting"
            log_run(run_id, f"WARNING exec still running after {timeout}s")
    inspect = docker_json(f"/exec/{exec_id}/json") or {}
    out, _ = docker_exec(CODE_CONTAINER, ["cat", out_file])
    err, _ = docker_exec(CODE_CONTAINER, ["cat", err_file])
    docker_exec(CODE_CONTAINER, ["rm", "-f", out_file, err_file])
    return out, err, inspect.get("ExitCode"), stream_note


def save_run(info: dict):
    ensure_state_db()
    with sqlite3.connect(STATE_DB, timeout=10) as conn:
        conn.execute("PRAGMA busy_timeout = 10000")
        conn.execute(
            """
            INSERT INTO runs (id, project, prompt, session_id,
                resume_session_id, status, exit_code, output, error,
                error_detail, limit_hit, resume_at, auto_resumed,
                started_at, finished_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                session_id = excluded.session_id,
                status = excluded.status,
                exit_code = excluded.exit_code,
                output = excluded.output,
                error = excluded.error,
                error_detail = excluded.error_detail,
                limit_hit = excluded.limit_hit,
                resume_at = excluded.resume_at,
                finished_at = excluded.finished_at
            """,
            (
                info["id"],
                info["project"],
                info["prompt"],
                info.get("session_id"),
                info.get("resume_session_id"),
                info.get("status", "running"),
                info.get("exit_code"),
                info.get("output") or None,
                info.get("error"),
                info.get("error_detail"),
                info.get("limit_hit", 0),
                info.get("resume_at"),
                info.get("auto_resumed", 0),
                info["started_at"],
                info.get("finished_at"),
            ),
        )


def mark_stale_runs():
    ensure_state_db()
    with sqlite3.connect(STATE_DB, timeout=10) as conn:
        conn.execute(
            "UPDATE runs SET status = 'stale', finished_at = ? WHERE status = 'running'",
            (utcnow(),),
        )


def start_run(
    project: str,
    prompt: str,
    continue_session: bool,
    resume_session_id: str | None = None,
) -> str:
    run_id = uuid.uuid4().hex[:12]
    info = {
        "id": run_id,
        "project": project,
        "prompt": prompt,
        "session_id": None,
        "resume_session_id": resume_session_id,
        "status": "running",
        "running": True,
        "started_at": utcnow(),
        "finished_at": None,
        "output": "",
        "error": None,
        "error_detail": None,
        "limit_hit": 0,
        "resume_at": None,
        "auto_resumed": 0,
        "exit_code": None,
    }
    with RUNS_LOCK:
        RUNS[run_id] = info
    save_run(info)
    threading.Thread(
        target=_run_worker, args=(info, continue_session), daemon=True
    ).start()
    return run_id


def parse_claude_json(out: str) -> dict | None:
    """`claude -p --output-format json` prints one JSON object; tolerate noise."""
    text = out.strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    return None


def _run_worker(info: dict, continue_session: bool):
    project, prompt = info["project"], info["prompt"]
    resume_session_id = info.get("resume_session_id")
    try:
        cmd = ["claude", "-p", "--output-format", "json"]
        run_prompt = prompt
        if resume_session_id:
            cmd += ["--resume", resume_session_id]
        elif continue_session:
            cmd.append("--continue")
        elif RUN_PROMPT_SUFFIX:
            run_prompt = f"{prompt}\n\n{RUN_PROMPT_SUFFIX}"
        if RUN_NO_QUESTIONS:
            run_prompt = f"{RUN_NO_QUESTIONS}\n\n{run_prompt}"
        cmd.append(run_prompt)
        log_run(info["id"], f"start project={project}")
        out, err, exit_code, stream_note = docker_exec_run(
            cmd, f"/workspace/{project}", timeout=RUN_TIMEOUT, run_id=info["id"]
        )
        info["exit_code"] = exit_code
        if stream_note:
            info["error_detail"] = stream_note
        parsed = parse_claude_json(out)
        if parsed is not None:
            info["session_id"] = parsed.get("session_id")
            result = parsed.get("result")
            info["output"] = (
                result if isinstance(result, str) else json.dumps(result)
            ) or ""
            if parsed.get("is_error"):
                info["error"] = (info["output"] or "claude reported an error")[:2000]
        else:
            info["output"] = out.strip()
            if out.strip():
                info["error_detail"] = (
                    (info.get("error_detail") or "")
                    + "\nclaude printed no parseable JSON; raw output kept as-is"
                ).strip()
        if not info["output"]:
            info["output"] = err.strip()
        if exit_code not in (0, None) and not info["error"]:
            info["error"] = (
                err.strip() or info["output"] or f"exited with code {exit_code}"
            )[:2000]
        if err.strip() and err.strip() != info["output"]:
            info["error_detail"] = (
                (info.get("error_detail") or "") + "\n── stderr ──\n" + err.strip()
            ).strip()[:8000]
        if not info["error"]:
            marker = NOTES_MARKER_RE.search(info["output"] or "")
            if marker:
                section = (marker.group(1) + info["output"][marker.end():]).strip()
                if section:
                    create_note(
                        project,
                        squash(prompt, 60),
                        section,
                        origin="agent",
                        session_id=info.get("session_id"),
                    )
                    log_run(info["id"], "saved NOTES section to project notes")
    except Exception as e:
        import traceback

        info["error"] = f"{type(e).__name__}: {e}"
        info["error_detail"] = (
            (info.get("error_detail") or "") + "\n" + traceback.format_exc()
        ).strip()[:8000]
    finally:
        info["running"] = False
        info["status"] = "error" if info.get("error") else "done"
        info["finished_at"] = utcnow()
        if info["status"] == "error":
            detect_limit(info)
            log_run(
                info["id"],
                f"ERROR exit={info.get('exit_code')} {squash(info.get('error') or '', 200)}",
            )
        else:
            log_run(info["id"], f"done exit={info.get('exit_code')}")
        try:
            save_run(info)
        except Exception as e:
            print(f"save_run failed for {info['id']}: {e}", flush=True)


RUN_LIST_FIELDS = (
    "id", "project", "session_id", "resume_session_id",
    "status", "exit_code", "started_at", "finished_at",
    "limit_hit", "resume_at", "auto_resumed",
)


def _run_summary(info: dict) -> dict:
    slim = {k: info.get(k) for k in RUN_LIST_FIELDS}
    slim["prompt"] = squash(info.get("prompt") or "", 160)
    slim["has_error"] = bool(info.get("error"))
    slim["error"] = squash(info.get("error") or "", 200)
    return slim


def list_runs(limit: int = 30) -> dict:
    with RUNS_LOCK:
        live = [dict(i) for i in RUNS.values()]
    runs = [_run_summary(i) for i in live]
    seen = {r["id"] for r in runs}
    ensure_state_db()
    with sqlite3.connect(STATE_DB, timeout=10) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 10000")
        rows = conn.execute(
            "SELECT * FROM runs ORDER BY started_at DESC LIMIT ?", (limit,)
        ).fetchall()
    for row in rows:
        if row["id"] in seen:
            continue
        entry = {k: row[k] for k in RUN_LIST_FIELDS}
        entry["prompt"] = squash(row["prompt"] or "", 160)
        entry["has_error"] = row["error"] is not None
        entry["error"] = squash(row["error"] or "", 200)
        runs.append(entry)
    runs.sort(key=lambda r: r["started_at"] or "", reverse=True)
    return {"runs": runs[:limit]}


def run_status(project: str, run_id: str) -> dict | None:
    with RUNS_LOCK:
        info = RUNS.get(run_id)
    if info is not None:
        return dict(info) if info["project"] == project else None
    ensure_state_db()
    with sqlite3.connect(STATE_DB, timeout=10) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM runs WHERE id = ? AND project = ?", (run_id, project)
        ).fetchone()
    if row is None:
        return None
    info = {k: row[k] for k in row.keys()}
    info["running"] = row["status"] == "running"
    info["output"] = row["output"] or ""
    return info


def _claim_for_resume(run_id: str) -> bool:
    """Mark a run as resumed exactly once (guards scheduler vs manual retry)."""
    ensure_state_db()
    with sqlite3.connect(STATE_DB, timeout=10) as conn:
        conn.execute("PRAGMA busy_timeout = 10000")
        cur = conn.execute(
            "UPDATE runs SET auto_resumed = 1 WHERE id = ? AND auto_resumed = 0",
            (run_id,),
        )
    with RUNS_LOCK:
        if run_id in RUNS:
            RUNS[run_id]["auto_resumed"] = 1
    return cur.rowcount > 0


def resume_run(run: dict, reason: str) -> str | None:
    """Start a follow-up run continuing an interrupted one. Resumes the same
    claude session when we captured its id, otherwise reruns the prompt."""
    if run["status"] == "running" or not _claim_for_resume(run["id"]):
        return None
    session_id = run.get("session_id")
    if session_id:
        prompt = (
            f"The previous run was interrupted ({reason}). Continue where you"
            " left off and finish the original task:\n\n" + (run.get("prompt") or "")
        )
    else:
        prompt = run.get("prompt") or ""
    new_id = start_run(run["project"], prompt, False, session_id)
    log_run(
        run["id"],
        f"resumed as run {new_id} ({reason}; "
        f"{'--resume ' + session_id if session_id else 'fresh session, no session_id captured'})",
    )
    return new_id


def _resume_scheduler():
    """Auto-continue limit-hit runs once their reset time passes."""
    while True:
        time.sleep(60)
        try:
            ensure_state_db()
            with sqlite3.connect(STATE_DB, timeout=10) as conn:
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA busy_timeout = 10000")
                rows = conn.execute(
                    "SELECT * FROM runs WHERE status = 'error' AND limit_hit = 1"
                    " AND auto_resumed = 0 AND resume_at IS NOT NULL"
                    " AND resume_at <= ?",
                    (utcnow(),),
                ).fetchall()
            for row in rows:
                resume_run(dict(row), "usage limit reset")
        except Exception:
            import traceback

            traceback.print_exc()


# -- notes (per-project DB) --------------------------------------------------
# Schema matches tmt-ai-proxy/migrations/007_notes.sql; the DDL is repeated
# here so the viewer works on DBs the proxy hasn't migrated yet.

NOTES_DDL = """
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'user',
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);
"""


def note_conn(project: str, attach_state: bool = False) -> sqlite3.Connection:
    conn = connect(DATA_DIR / f"{project}.db", attach_state=attach_state)
    conn.executescript(NOTES_DDL)
    return conn


def list_notes(project: str) -> dict:
    with note_conn(project) as conn:
        rows = conn.execute("SELECT * FROM notes ORDER BY id DESC").fetchall()
    return {"notes": [dict(r) for r in rows]}


def create_note(
    project: str,
    title: str,
    body: str,
    origin: str = "user",
    session_id: str | None = None,
) -> dict:
    with note_conn(project) as conn:
        cur = conn.execute(
            "INSERT INTO notes (title, body, origin, session_id) VALUES (?, ?, ?, ?)",
            (title, body, origin, session_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM notes WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {"ok": True, "note": dict(row)}


def update_note(project: str, note_id: int, fields: dict) -> dict:
    sets, args = [], []
    if isinstance(fields.get("title"), str):
        sets.append("title = ?")
        args.append(fields["title"].strip())
    if isinstance(fields.get("body"), str):
        sets.append("body = ?")
        args.append(fields["body"])
    if not sets:
        return {"ok": False, "reason": "nothing to update"}
    sets.append("updated_at = ?")
    args += [utcnow(), note_id]
    with note_conn(project) as conn:
        cur = conn.execute(f"UPDATE notes SET {', '.join(sets)} WHERE id = ?", args)
        conn.commit()
    return {"ok": cur.rowcount > 0}


def delete_note(project: str, note_id: int) -> dict:
    with note_conn(project) as conn:
        cur = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
        conn.commit()
    return {"ok": cur.rowcount > 0}


class Handler(BaseHTTPRequestHandler):
    server_version = "tmt-ai-viewer"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}")

    # -- helpers ----------------------------------------------------------
    def send_json(self, payload, status: int = 200, cookie: str | None = None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: int, message: str):
        self.send_json({"error": message}, status=status)

    def read_body_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 1_000_000:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def parse_ids(self, payload: dict):
        ids = payload.get("ids")
        if isinstance(ids, list) and ids and all(isinstance(i, int) for i in ids):
            return ids[:1000]
        return None

    # -- auth ---------------------------------------------------------------
    def session_token(self) -> str:
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            name, _, value = part.strip().partition("=")
            if name == SESSION_COOKIE:
                return value
        return ""

    def is_authed(self) -> bool:
        return not auth_enabled() or session_valid(self.session_token())

    def client_ip(self) -> str:
        return self.client_address[0]

    def handle_login(self, payload: dict):
        ip = self.client_ip()
        locked = lockout_remaining(ip)
        if locked:
            return self.send_json(
                {"error": "locked", "locked_for": locked}, status=429
            )
        password = payload.get("password")
        if not isinstance(password, str) or not hmac.compare_digest(
            password.encode("utf-8"), AUTH_PASSWORD.encode("utf-8")
        ):
            attempts_left, lockout = register_failed_login(ip)
            if lockout:
                print(f"auth: {ip} locked out for {lockout}s")
                return self.send_json(
                    {"error": "locked", "locked_for": lockout}, status=429
                )
            return self.send_json(
                {"error": "wrong password", "attempts_left": attempts_left},
                status=401,
            )
        clear_failed_logins(ip)
        token = create_session()
        cookie = (
            f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax;"
            f" Max-Age={SESSION_TTL_SECONDS}"
        )
        return self.send_json({"ok": True}, cookie=cookie)

    def handle_logout(self):
        destroy_session(self.session_token())
        cookie = f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        return self.send_json({"ok": True}, cookie=cookie)

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        route = parsed.path

        try:
            if route == "/health":
                return self.send_json({"ok": True})
            if not self.is_authed():
                if route == "/" or route == "/index.html":
                    return self.serve_static("login.html")
                return self.send_error_json(401, "auth required")
            if route == "/" or route == "/index.html":
                return self.serve_static("index.html")
            if route.startswith("/static/"):
                return self.serve_static(route[len("/static/") :])
            if route == "/api/projects":
                return self.send_json({"projects": list_projects()})
            if route == "/api/runs":
                return self.send_json(list_runs())
            if route == "/api/usage_recent":
                try:
                    minutes = min(max(int(params.get("minutes", 5)), 1), 60)
                except ValueError:
                    minutes = 5
                return self.send_json(usage_recent(minutes))
            if route == "/api/requests":
                project = params.get("project", "")
                if not valid_project(project):
                    return self.send_error_json(404, "unknown project")
                return self.send_json(query_requests(project, params))
            if route == "/api/request":
                project = params.get("project", "")
                if not valid_project(project):
                    return self.send_error_json(404, "unknown project")
                try:
                    log_id = int(params.get("id", ""))
                except ValueError:
                    return self.send_error_json(400, "bad id")
                detail = get_request_detail(project, log_id)
                if detail is None:
                    return self.send_error_json(404, "not found")
                return self.send_json(detail)
            if route == "/api/project_status":
                project = params.get("project", "")
                if not valid_project(project):
                    return self.send_error_json(404, "unknown project")
                return self.send_json(project_docker_status(project))
            if route == "/api/project_context":
                project = params.get("project", "")
                if not valid_project(project):
                    return self.send_error_json(404, "unknown project")
                return self.send_json(project_context(project))
            if route == "/api/run":
                project = params.get("project", "")
                if not valid_project(project):
                    return self.send_error_json(404, "unknown project")
                status = run_status(project, params.get("id", ""))
                if status is None:
                    return self.send_error_json(404, "unknown run")
                return self.send_json(status)
            if route == "/api/notes":
                project = params.get("project", "")
                if not valid_project(project):
                    return self.send_error_json(404, "unknown project")
                return self.send_json(list_notes(project))
            return self.send_error_json(404, "not found")
        except Exception as e:  # keep the viewer up on any single bad request
            import traceback

            traceback.print_exc()
            return self.send_error_json(500, str(e))

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        payload = self.read_body_json()
        project = payload.get("project", "")

        try:
            if route == "/api/login":
                if not auth_enabled():
                    return self.send_json({"ok": True})
                return self.handle_login(payload)
            if route == "/api/logout":
                return self.handle_logout()
            if not self.is_authed():
                return self.send_error_json(401, "auth required")

            if route == "/api/mark_all_global":
                return self.send_json({"ok": True, "projects": mark_all_read_everywhere()})

            if route.startswith("/api/") and not valid_project(project):
                return self.send_error_json(404, "unknown project")

            if route == "/api/run":
                prompt = str(payload.get("prompt", "")).strip()
                if not prompt:
                    return self.send_error_json(400, "prompt required")
                resume = payload.get("resume_session_id")
                if resume is not None and (
                    not isinstance(resume, str)
                    or not re.fullmatch(r"[0-9a-fA-F-]{8,64}", resume)
                ):
                    return self.send_error_json(400, "bad resume_session_id")
                run_id = start_run(
                    project,
                    prompt,
                    bool(payload.get("continue", False)),
                    resume,
                )
                return self.send_json({"ok": True, "run_id": run_id})

            if route == "/api/run_retry":
                run = run_status(project, str(payload.get("run_id", "")))
                if run is None:
                    return self.send_error_json(404, "unknown run")
                new_id = resume_run(run, "manual retry")
                if new_id is None:
                    return self.send_error_json(
                        409, "run is still running or was already resumed"
                    )
                return self.send_json({"ok": True, "run_id": new_id})

            if route == "/api/note_create":
                title = str(payload.get("title", "")).strip()
                body = str(payload.get("body", ""))
                if not (title or body.strip()):
                    return self.send_error_json(400, "title or body required")
                return self.send_json(create_note(project, title, body))

            if route == "/api/note_update":
                note_id = payload.get("id")
                if not isinstance(note_id, int):
                    return self.send_error_json(400, "bad id")
                result = update_note(project, note_id, payload)
                return self.send_json(result, status=200 if result.get("ok") else 400)

            if route == "/api/note_delete":
                note_id = payload.get("id")
                if not isinstance(note_id, int):
                    return self.send_error_json(400, "bad id")
                result = delete_note(project, note_id)
                return self.send_json(result, status=200 if result.get("ok") else 404)

            if route == "/api/mark":
                session_id = payload.get("session_id")
                if isinstance(session_id, str) and session_id:
                    mark_session_read(project, session_id, bool(payload.get("read", True)))
                    return self.send_json({"ok": True})
                ids = self.parse_ids(payload)
                if ids is None:
                    return self.send_error_json(400, "ids must be a list of ints")
                mark_read(project, ids, bool(payload.get("read", True)))
                return self.send_json({"ok": True})

            if route == "/api/mark_all":
                mark_all_read(project)
                return self.send_json({"ok": True})

            if route == "/api/delete":
                ids = self.parse_ids(payload)
                if ids is None:
                    return self.send_error_json(400, "ids must be a list of ints")
                deleted = delete_requests(project, ids)
                return self.send_json({"ok": True, "deleted": deleted})

            return self.send_error_json(404, "not found")
        except Exception as e:
            import traceback

            traceback.print_exc()
            return self.send_error_json(500, str(e))

    def serve_static(self, rel: str):
        target = (STATIC_DIR / rel).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
            return self.send_error_json(404, "not found")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header(
            "Content-Type", MIME_TYPES.get(target.suffix, "application/octet-stream")
        )
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def main():
    ensure_state_db()
    mark_stale_runs()
    threading.Thread(target=_resume_scheduler, daemon=True).start()
    if auth_enabled():
        print(
            f"auth: password gate on ({MAX_LOGIN_ATTEMPTS} attempts,"
            f" {LOCKOUT_SECONDS}s lockout)"
        )
    else:
        print("auth: WARNING — VIEWER_PASSWORD not set, viewer is unprotected")
    print(f"tmt-ai-viewer on port {PORT}, data dir {DATA_DIR}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
