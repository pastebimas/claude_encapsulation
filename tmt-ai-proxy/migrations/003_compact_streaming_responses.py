"""
Migration 003: Compact any historical SSE responses already in the DB.

New responses are compacted on insert by proxy.py; this only matters when
upgrading a database that was populated by an older version of the proxy.
"""
import json
from datetime import datetime


def _compact(raw_body: str) -> str:
    if not raw_body or not raw_body.strip().startswith("event:"):
        return raw_body

    chunks = []
    content_parts = []
    metadata = {}
    usage = {}

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
        chunks.append(chunk)

        if not metadata and chunk.get("type") == "message_start":
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

        if chunk.get("type") == "content_block_delta":
            delta = chunk.get("delta", {})
            if delta.get("type") == "text_delta":
                content_parts.append(delta.get("text", ""))
            elif delta.get("type") == "thinking_delta":
                content_parts.append(delta.get("thinking", ""))

        if chunk.get("type") == "message_delta":
            delta = chunk.get("delta", {})
            if delta.get("stop_reason"):
                metadata["stop_reason"] = delta.get("stop_reason")
            if chunk.get("usage"):
                usage.update(chunk.get("usage", {}))

    if not chunks:
        return raw_body

    return json.dumps(
        {
            **metadata,
            "content": [{"type": "text", "text": "".join(content_parts)}],
            "usage": usage,
            "_compacted": {
                "original_chunks": len(chunks),
                "compacted_at": datetime.utcnow().isoformat(),
            },
        }
    )


async def migrate(db):
    cursor = await db.execute(
        "SELECT id, response_body FROM request_logs WHERE response_body LIKE 'event:%'"
    )
    rows = await cursor.fetchall()
    if not rows:
        return

    migrated = 0
    for row_id, body in rows:
        if not body:
            continue
        compacted = _compact(body)
        if compacted != body:
            await db.execute(
                "UPDATE request_logs SET response_body = ? WHERE id = ?",
                (compacted, row_id),
            )
            migrated += 1

    await db.commit()
    if migrated:
        await db.execute("VACUUM")
