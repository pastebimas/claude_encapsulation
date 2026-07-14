-- Migration 004: Tasks with request/response relations and comments.
-- The proxy auto-links each new request_logs row to the task currently
-- in 'doing' status; the viewer manages tasks, manual links and comments.

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

CREATE TABLE IF NOT EXISTS task_requests (
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    request_log_id INTEGER NOT NULL REFERENCES request_logs(id),
    linked_by TEXT NOT NULL DEFAULT 'auto',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    PRIMARY KEY (task_id, request_log_id)
);

CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    author TEXT NOT NULL DEFAULT 'user',
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_task_requests_request ON task_requests(request_log_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_task    ON task_comments(task_id);

CREATE VIEW IF NOT EXISTS v_task_activity AS
SELECT
    tasks.id            AS task_id,
    tasks.title,
    tasks.status,
    task_requests.request_log_id,
    task_requests.linked_by,
    request_logs.timestamp,
    request_logs.response_status,
    request_logs.duration_ms
FROM tasks
JOIN task_requests ON task_requests.task_id = tasks.id
JOIN request_logs  ON request_logs.id = task_requests.request_log_id;
