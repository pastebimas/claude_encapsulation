-- Migration 002: Add performance indexes for common queries.

CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp        ON request_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_status           ON request_logs(response_status);
CREATE INDEX IF NOT EXISTS idx_request_logs_path             ON request_logs(path);
CREATE INDEX IF NOT EXISTS idx_request_logs_method           ON request_logs(method);
CREATE INDEX IF NOT EXISTS idx_request_logs_status_timestamp ON request_logs(response_status, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_path_timestamp   ON request_logs(path, timestamp DESC);
