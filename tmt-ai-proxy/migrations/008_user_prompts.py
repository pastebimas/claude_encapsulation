# Migration 008: capture human-typed prompts at ingest.
#
# The proxy writes one row here per new user turn (see proxy.log_request); the
# viewer's "My prompts" view reads this table directly instead of re-parsing
# request bodies. This migration creates the table and backfills it from any
# request_logs rows that predate the proxy change.

from prompt_extract import extract_user_prompt
import json

DDL = """
CREATE TABLE IF NOT EXISTS user_prompts (
    log_id      INTEGER PRIMARY KEY REFERENCES request_logs(id) ON DELETE CASCADE,
    session_id  TEXT,
    timestamp   TEXT,
    prompt_text TEXT NOT NULL
)
"""


async def migrate(db):
    await db.execute(DDL)

    cursor = await db.execute(
        """
        SELECT r.id, r.session_id, r.timestamp, r.request_body
        FROM request_logs r
        LEFT JOIN user_prompts up ON up.log_id = r.id
        WHERE up.log_id IS NULL AND r.request_body IS NOT NULL
        """
    )
    rows = await cursor.fetchall()
    for log_id, session_id, timestamp, request_body in rows:
        try:
            text = extract_user_prompt(json.loads(request_body))
        except (json.JSONDecodeError, TypeError):
            continue
        if text is None:
            continue
        await db.execute(
            "INSERT OR IGNORE INTO user_prompts"
            " (log_id, session_id, timestamp, prompt_text) VALUES (?, ?, ?, ?)",
            (log_id, session_id, timestamp, text),
        )
    await db.commit()
