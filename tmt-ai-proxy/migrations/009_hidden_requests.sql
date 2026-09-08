-- Migration 009: Add ability to hide/delete requests.
-- Adds a 'hidden' column to request_logs to support soft-delete (hiding) of requests.

ALTER TABLE request_logs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_request_logs_hidden ON request_logs(hidden);
