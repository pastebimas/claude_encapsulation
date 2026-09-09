-- Migration 010: Update views to support hidden requests.
-- Creates new views that exclude hidden requests by default, so Datasette
-- and other tools see only non-hidden requests. Also creates _all variants
-- for viewing everything including hidden requests.

-- Update existing views to exclude hidden requests by default
DROP VIEW IF EXISTS v_flatten_request_headers;
CREATE VIEW v_flatten_request_headers AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    json_each.key   AS header_name,
    json_each.value AS header_value
FROM request_logs, json_each(request_logs.request_headers)
WHERE request_logs.hidden = 0;

DROP VIEW IF EXISTS v_flatten_response_headers;
CREATE VIEW v_flatten_response_headers AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    request_logs.response_status,
    json_each.key   AS header_name,
    json_each.value AS header_value
FROM request_logs, json_each(request_logs.response_headers)
WHERE request_logs.hidden = 0;

DROP VIEW IF EXISTS v_flatten_request_body;
CREATE VIEW v_flatten_request_body AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    json_each.key   AS field_name,
    json_each.value AS field_value
FROM request_logs, json_each(request_logs.request_body)
WHERE request_logs.hidden = 0;

DROP VIEW IF EXISTS v_full_request_data;
CREATE VIEW v_full_request_data AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    'header' AS data_type,
    h.key   AS key_name,
    h.value AS value_data
FROM request_logs, json_each(request_logs.request_headers) AS h
WHERE request_logs.hidden = 0
UNION ALL
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    'body' AS data_type,
    b.key   AS key_name,
    b.value AS value_data
FROM request_logs, json_each(request_logs.request_body) AS b
WHERE request_logs.hidden = 0;

-- Create _all variants that show everything including hidden requests
CREATE VIEW IF NOT EXISTS v_flatten_request_headers_all AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    request_logs.hidden,
    json_each.key   AS header_name,
    json_each.value AS header_value
FROM request_logs, json_each(request_logs.request_headers);

CREATE VIEW IF NOT EXISTS v_flatten_response_headers_all AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    request_logs.response_status,
    request_logs.hidden,
    json_each.key   AS header_name,
    json_each.value AS header_value
FROM request_logs, json_each(request_logs.response_headers);

CREATE VIEW IF NOT EXISTS v_flatten_request_body_all AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    request_logs.hidden,
    json_each.key   AS field_name,
    json_each.value AS field_value
FROM request_logs, json_each(request_logs.request_body);

CREATE VIEW IF NOT EXISTS v_full_request_data_all AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    request_logs.hidden,
    'header' AS data_type,
    h.key   AS key_name,
    h.value AS value_data
FROM request_logs, json_each(request_logs.request_headers) AS h
UNION ALL
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    request_logs.hidden,
    'body' AS data_type,
    b.key   AS key_name,
    b.value AS value_data
FROM request_logs, json_each(request_logs.request_body) AS b;
