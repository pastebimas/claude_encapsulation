# Migration 006: undo the tasks-table takeover left behind by the removed
# 004_derived_schema.py. That migration renamed the title-based tasks table
# (004_tasks.sql) to tasks_legacy and created a subject-based tasks table
# the proxy/viewer no longer use. Restore the title-based table and make
# sure the origin column from 005 exists on it.

TASKS_DDL = """
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
)
"""


async def _columns(db, table):
    cursor = await db.execute(f"PRAGMA table_info({table})")
    return {row[1] for row in await cursor.fetchall()}


async def _table_exists(db, table):
    cursor = await db.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    )
    return await cursor.fetchone() is not None


async def migrate(db):
    if await _table_exists(db, "tasks") and "subject" in await _columns(db, "tasks"):
        await db.execute("DROP TABLE tasks")
        if await _table_exists(db, "tasks_legacy"):
            await db.execute("ALTER TABLE tasks_legacy RENAME TO tasks")
        else:
            await db.execute(TASKS_DDL)
    elif not await _table_exists(db, "tasks"):
        await db.execute(TASKS_DDL)

    if "origin" not in await _columns(db, "tasks"):
        await db.execute(
            "ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'"
        )
    await db.commit()
