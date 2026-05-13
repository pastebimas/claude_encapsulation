-- Migration 001: Create views for flattened data (used by Datasette facets).

CREATE VIEW IF NOT EXISTS v_flatten_request_headers AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    json_each.key   AS header_name,
    json_each.value AS header_value
FROM request_logs, json_each(request_logs.request_headers);

CREATE VIEW IF NOT EXISTS v_flatten_response_headers AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    request_logs.response_status,
    json_each.key   AS header_name,
    json_each.value AS header_value
FROM request_logs, json_each(request_logs.response_headers);

CREATE VIEW IF NOT EXISTS v_flatten_request_body AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
    json_each.key   AS field_name,
    json_each.value AS field_value
FROM request_logs, json_each(request_logs.request_body);

CREATE VIEW IF NOT EXISTS v_full_request_data AS
SELECT
    request_logs.id,
    request_logs.timestamp,
    request_logs.method,
    request_logs.path,
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
    'body' AS data_type,
    b.key   AS key_name,
    b.value AS value_data
FROM request_logs, json_each(request_logs.request_body) AS b;
