ALTER TABLE request_logs ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_request_logs_session ON request_logs(session_id);

ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';

CREATE TABLE IF NOT EXISTS session_task_map (
    session_id TEXT NOT NULL,
    claude_task_id TEXT NOT NULL,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (session_id, claude_task_id)
);

-- Dedupe: TaskCreate/TaskUpdate tool_use blocks reappear in every subsequent
-- request of a session; each is processed once, keyed by its tool_use id.
CREATE TABLE IF NOT EXISTS agent_tool_calls (
    tool_use_id TEXT PRIMARY KEY,
    task_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);
