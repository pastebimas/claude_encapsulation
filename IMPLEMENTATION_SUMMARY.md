# Implementation Summary: Hide/Delete Requests Feature

## Overview
This implementation adds a complete system for hiding and deleting API request logs in tmt-ai. Users can now clean up their request logs by hiding (soft delete) or permanently deleting requests they no longer need.

## Changes Made

### 1. Database Schema (Migrations)

**Migration 009: `009_hidden_requests.sql`**
- Adds `hidden` INTEGER column to `request_logs` table (default: 0)
- Creates index on `hidden` column for efficient filtering
- Preserves all existing data during migration

**Migration 010: `010_request_views_with_hidden.sql`**
- Updates existing views to exclude hidden requests by default:
  - `v_flatten_request_headers`
  - `v_flatten_response_headers`
  - `v_flatten_request_body`
  - `v_full_request_data`
- Creates `_all` variants that include hidden requests for direct database access:
  - `v_flatten_request_headers_all`
  - `v_flatten_response_headers_all`
  - `v_flatten_request_body_all`
  - `v_full_request_data_all`

### 2. Backend Implementation

**New Module: `tmt-ai-viewer/server/requestLogs.js`**

Exports the following functions:
- `hideRequest(project, requestId)` — Mark a request as hidden
- `unhideRequest(project, requestId)` — Restore a hidden request to visible
- `deleteRequest(project, requestId)` — Permanently delete a request
- `toggleHidden(project, requestId)` — Toggle between hidden/visible
- `getRequest(project, requestId)` — Retrieve a request (if exists)
- `hideRequestsByFilter(project, filter)` — Bulk hide by filter criteria
- `deleteRequestsByFilter(project, filter)` — Bulk delete by filter criteria
- `getProjectDb(project)` — Get a database connection for a project

### 3. API Routes

**New Routes in `tmt-ai-viewer/server/routes.js`:**

Single Request Operations:
- `POST /api/request/:id/hide` — Hide a specific request
- `POST /api/request/:id/unhide` — Unhide a specific request
- `POST /api/request/:id/toggle` — Toggle hidden status
- `DELETE /api/request/:id` — Permanently delete a request

Bulk Operations:
- `POST /api/requests/hide` — Hide multiple requests by filter
- `POST /api/requests/delete` — Delete multiple requests by filter

All endpoints require `project` in request body.

### 4. Frontend API Client

**New Methods in `tmt-ai-viewer/src/api.ts`:**
- `hideRequest(project, id)` — Hide a request via API
- `unhideRequest(project, id)` — Unhide a request via API
- `toggleRequestHidden(project, id)` — Toggle hidden status via API
- `deleteRequest(project, id)` — Delete a request via API
- `hideRequestsByFilter(project, filter)` — Bulk hide via API
- `deleteRequestsByFilter(project, filter)` — Bulk delete via API

### 5. Documentation

**New Files:**
- `MANAGING_REQUESTS.md` — Comprehensive guide covering:
  - API endpoint documentation with curl examples
  - How hidden requests work and viewing them
  - JavaScript API usage examples
  - Direct SQL examples for power users
  - Migration notes for upgrading

**Updated Files:**
- `README.md` — Added section on managing request logs with quick reference

### 6. Testing

**New File: `test-request-logs.js`**
- Comprehensive test script verifying:
  - Individual operations (hide, unhide, delete, toggle)
  - Bulk operations (hideRequestsByFilter, deleteRequestsByFilter)
  - Proper hidden flag management in database
- Can be run with: `node test-request-logs.js`

## Feature Capabilities

### Single Request Operations
Users can manage individual requests through simple API calls:
```javascript
// Hide a request
await api.hideRequest('my-project', '123');

// Unhide a request
await api.unhideRequest('my-project', '123');

// Permanently delete
await api.deleteRequest('my-project', '123');
```

### Bulk Operations
Hide or delete multiple requests matching criteria:
```javascript
// Hide all POST requests
await api.hideRequestsByFilter('my-project', { method: 'POST' });

// Delete all requests from a session older than a date
await api.deleteRequestsByFilter('my-project', {
  session_id: 'old-session',
  timestamp_before: '2024-01-01T00:00:00'
});
```

### Filter Criteria
Bulk operations support filtering by:
- `session_id` — Claude session ID
- `method` — HTTP method (POST, GET, etc.)
- `timestamp_after` — ISO 8601 timestamp
- `timestamp_before` — ISO 8601 timestamp

Filters are combined with AND logic.

### Data Safety
- **Soft Delete (Hide)** — Data preserved, can be unhidden
- **Hard Delete** — Permanently removed from database
- All operations are logged at the database level
- Cascading deletes on related tables (e.g., user_prompts)

## Integration with Existing Systems

### Datasette Integration
- Hidden requests excluded from default views
- `_all` variants available for viewing all data including hidden
- Query with `WHERE hidden = 1` to see hidden requests
- Query with `WHERE hidden = 0` (or omit) for visible requests

### Backward Compatibility
- Migration adds column with default value 0 (visible)
- Existing requests immediately visible (not hidden)
- No data loss during migration
- Can be safely applied to existing databases

## Technical Details

### Database Constraints
- `hidden` column is INTEGER (0 or 1)
- Indexed for efficient filtering on large result sets
- Cascades through views (filtering happens in view definitions)

### API Design
- All endpoints require `project` parameter for security/routing
- Filter-based bulk operations prevent accidental mass deletion
- Idempotent operations (hide an already-hidden request is safe)
- Clear error messages for invalid requests/projects

### Performance Considerations
- Index on `hidden` column ensures fast filtering
- Views use WHERE clauses for efficient exclusion
- Bulk operations use single SQL statement
- No N+1 queries for bulk operations

## Migration Path

When deployed:
1. Migration 009 creates `hidden` column (default 0)
2. Migration 010 updates views to filter by hidden status
3. Existing requests become visible by default
4. New API endpoints become available
5. No user action required for existing logs

## Future Enhancements

Potential improvements for future versions:
- UI controls in dashboard for hide/delete/restore
- Batch operations in Datasette UI
- Archiving feature (collection of requests to export)
- Retention policies (auto-delete after X days)
- Audit log of hidden/deleted requests
