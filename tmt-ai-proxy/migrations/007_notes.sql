CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'user',
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

DROP VIEW IF EXISTS v_task_activity;
DROP TABLE IF EXISTS task_requests;
DROP TABLE IF EXISTS task_comments;
DROP TABLE IF EXISTS session_task_map;
DROP TABLE IF EXISTS agent_tool_calls;
DROP TABLE IF EXISTS tasks;
