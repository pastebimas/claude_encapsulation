# Managing Request Logs

The tmt-ai system logs every API request to a per-project SQLite database. Over time, these logs can accumulate and become cluttered. You can now hide or permanently delete requests you no longer need.

## Overview

Every request log entry can be:
- **Hidden** — marked as hidden (soft delete) but not removed from the database
- **Unhidden** — restored to visible
- **Deleted** — permanently removed (hard delete)
- **Toggled** — quickly switch between hidden and visible

## API Endpoints

All endpoints require a `project` parameter (the project name) in the request body.

### Single Request Operations

**Hide a request:**
```bash
curl -X POST http://localhost:8035/api/request/{id}/hide \
  -H "Content-Type: application/json" \
  -d '{"project": "my-project"}'
```

**Unhide a request:**
```bash
curl -X POST http://localhost:8035/api/request/{id}/unhide \
  -H "Content-Type: application/json" \
  -d '{"project": "my-project"}'
```

**Toggle hidden status:**
```bash
curl -X POST http://localhost:8035/api/request/{id}/toggle \
  -H "Content-Type: application/json" \
  -d '{"project": "my-project"}'
```

**Delete a request permanently:**
```bash
curl -X DELETE http://localhost:8035/api/request/{id} \
  -H "Content-Type: application/json" \
  -d '{"project": "my-project"}'
```

### Bulk Operations

**Hide multiple requests by filter:**
```bash
curl -X POST http://localhost:8035/api/requests/hide \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-project",
    "filter": {
      "session_id": "some-session-id",
      "method": "POST"
    }
  }'
```

**Delete multiple requests by filter:**
```bash
curl -X POST http://localhost:8035/api/requests/delete \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-project",
    "filter": {
      "method": "POST",
      "timestamp_after": "2024-01-01T00:00:00"
    }
  }'
```

Filter supports these optional fields:
- `session_id` — filter by Claude session ID
- `method` — filter by HTTP method (e.g., "POST", "GET")
- `timestamp_after` — ISO 8601 timestamp, include requests after this time
- `timestamp_before` — ISO 8601 timestamp, include requests before this time

## How Hidden Requests Work

When you hide a request:
1. The request is marked with `hidden = 1` in the database
2. Views in Datasette automatically exclude hidden requests
3. Raw SQL queries can still access hidden requests using views like `v_full_request_data_all`
4. The data is not deleted, so you can unhide it later if needed

## Viewing Hidden Requests

By default, Datasette only shows non-hidden requests. To view hidden requests:
1. Open Datasette at http://localhost:8001
2. Browse to your project's database
3. Query the `request_logs` table directly with `WHERE hidden = 1`
4. Or use the `*_all` views which include hidden requests:
   - `v_flatten_request_headers_all`
   - `v_flatten_response_headers_all`
   - `v_flatten_request_body_all`
   - `v_full_request_data_all`

## JavaScript API

If you're building a frontend or tool:

```javascript
import { api } from './src/api.ts';

// Hide a request
await api.hideRequest('my-project', '123');

// Unhide a request
await api.unhideRequest('my-project', '123');

// Toggle hidden status
await api.toggleRequestHidden('my-project', '123');

// Delete a request
await api.deleteRequest('my-project', '123');

// Hide by filter
await api.hideRequestsByFilter('my-project', {
  method: 'POST'
});

// Delete by filter
await api.deleteRequestsByFilter('my-project', {
  session_id: 'some-id',
  timestamp_before: '2024-01-01T00:00:00'
});
```

## Database Schema

The `request_logs` table now includes:
- `hidden` (INTEGER) — 0 = visible (default), 1 = hidden

To manually manage hidden requests in SQL:

```sql
-- Hide all POST requests
UPDATE request_logs SET hidden = 1 WHERE method = 'POST';

-- Show all requests again
UPDATE request_logs SET hidden = 0;

-- Delete all hidden requests
DELETE FROM request_logs WHERE hidden = 1;

-- Count hidden requests
SELECT COUNT(*) FROM request_logs WHERE hidden = 1;
```

## Migration Notes

If you're upgrading from an older version:
1. Run the migration automatically (happens on first request after update)
2. The migration adds the `hidden` column with default value `0` (visible)
3. All existing requests become visible by default
4. No data loss — requests are not modified during migration
