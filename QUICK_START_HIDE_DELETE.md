# Quick Start: Hide or Delete Requests

## Getting Started

The feature is ready to use once the code is deployed. The database migrations run automatically on first use.

## Common Tasks

### Hide a single request
```bash
curl -X POST http://localhost:8035/api/request/42/hide \
  -H "Content-Type: application/json" \
  -d '{"project": "my-project"}'
```

### Show (unhide) a hidden request
```bash
curl -X POST http://localhost:8035/api/request/42/unhide \
  -H "Content-Type: application/json" \
  -d '{"project": "my-project"}'
```

### Delete a request permanently
```bash
curl -X DELETE http://localhost:8035/api/request/42 \
  -H "Content-Type: application/json" \
  -d '{"project": "my-project"}'
```

### Hide all POST requests
```bash
curl -X POST http://localhost:8035/api/requests/hide \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-project",
    "filter": {"method": "POST"}
  }'
```

### Delete all requests from yesterday
```bash
curl -X POST http://localhost:8035/api/requests/delete \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-project",
    "filter": {
      "timestamp_before": "2024-01-01T00:00:00",
      "timestamp_after": "2023-12-31T00:00:00"
    }
  }'
```

### From JavaScript
```javascript
import { api } from './src/api.ts';

// Hide a request
await api.hideRequest('my-project', '42');

// Restore it
await api.unhideRequest('my-project', '42');

// Delete it
await api.deleteRequest('my-project', '42');

// Hide all POST requests
await api.hideRequestsByFilter('my-project', { method: 'POST' });
```

### Using SQL directly
```sql
-- Hide all POST requests
UPDATE request_logs SET hidden = 1 WHERE method = 'POST';

-- Unhide everything
UPDATE request_logs SET hidden = 0;

-- See how many are hidden
SELECT COUNT(*) FROM request_logs WHERE hidden = 1;

-- Permanently delete all hidden
DELETE FROM request_logs WHERE hidden = 1;
```

## Viewing Hidden Requests in Datasette

By default, Datasette excludes hidden requests. To view them:

1. Open http://localhost:8001
2. Select your project database
3. Use the `*_all` tables/views:
   - Query `request_logs` with `WHERE hidden = 1`
   - Or use `v_full_request_data_all` to see all data

## Understanding Hidden vs Deleted

| Operation | Recoverable | Shows in Datasette | SQL |
|-----------|-------------|-------------------|-----|
| Hidden    | Yes (unhide)| No (by default)   | `UPDATE ... SET hidden = 1` |
| Deleted   | No          | No (ever)         | `DELETE ...` |

**Use Hidden for**: Temporary cleanup, requests you might want to restore

**Use Delete for**: Truly unwanted data that should be removed permanently

## Safety Notes

- Hidden requests still count in your database size (use delete for cleanup)
- Deleted requests cannot be recovered (no backup is kept)
- Bulk operations with filters apply to ALL matching requests
- Always test filter criteria before running on production databases
