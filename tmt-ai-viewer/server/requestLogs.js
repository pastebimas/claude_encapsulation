// Management of request logs: hide/unhide/delete from project databases.
import Database from "better-sqlite3";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";

export function getProjectDb(project) {
  const dbPath = path.join(DATA_DIR, `${project}.db`);
  try {
    return new Database(dbPath);
  } catch (e) {
    throw new Error(`Cannot open database for project '${project}': ${e.message}`);
  }
}

export function hideRequest(project, requestId) {
  const db = getProjectDb(project);
  try {
    const stmt = db.prepare("UPDATE request_logs SET hidden = 1 WHERE id = ?");
    const result = stmt.run(requestId);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function unhideRequest(project, requestId) {
  const db = getProjectDb(project);
  try {
    const stmt = db.prepare("UPDATE request_logs SET hidden = 0 WHERE id = ?");
    const result = stmt.run(requestId);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function deleteRequest(project, requestId) {
  const db = getProjectDb(project);
  try {
    const stmt = db.prepare("DELETE FROM request_logs WHERE id = ?");
    const result = stmt.run(requestId);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function toggleHidden(project, requestId) {
  const db = getProjectDb(project);
  try {
    const stmt = db.prepare("UPDATE request_logs SET hidden = NOT hidden WHERE id = ?");
    const result = stmt.run(requestId);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function getRequest(project, requestId) {
  const db = getProjectDb(project);
  try {
    const stmt = db.prepare("SELECT * FROM request_logs WHERE id = ?");
    return stmt.get(requestId);
  } finally {
    db.close();
  }
}

export function hideRequestsByFilter(project, filter) {
  const db = getProjectDb(project);
  try {
    // filter is an object with optional properties: session_id, method, timestamp_after, timestamp_before
    let query = "UPDATE request_logs SET hidden = 1 WHERE 1=1";
    const params = [];

    if (filter.session_id) {
      query += " AND session_id = ?";
      params.push(filter.session_id);
    }
    if (filter.method) {
      query += " AND method = ?";
      params.push(filter.method);
    }
    if (filter.timestamp_after) {
      query += " AND timestamp > ?";
      params.push(filter.timestamp_after);
    }
    if (filter.timestamp_before) {
      query += " AND timestamp < ?";
      params.push(filter.timestamp_before);
    }

    const stmt = db.prepare(query);
    const result = stmt.run(...params);
    return result.changes;
  } finally {
    db.close();
  }
}

export function deleteRequestsByFilter(project, filter) {
  const db = getProjectDb(project);
  try {
    // filter is an object with optional properties: session_id, method, timestamp_after, timestamp_before
    let query = "DELETE FROM request_logs WHERE 1=1";
    const params = [];

    if (filter.session_id) {
      query += " AND session_id = ?";
      params.push(filter.session_id);
    }
    if (filter.method) {
      query += " AND method = ?";
      params.push(filter.method);
    }
    if (filter.timestamp_after) {
      query += " AND timestamp > ?";
      params.push(filter.timestamp_after);
    }
    if (filter.timestamp_before) {
      query += " AND timestamp < ?";
      params.push(filter.timestamp_before);
    }

    const stmt = db.prepare(query);
    const result = stmt.run(...params);
    return result.changes;
  } finally {
    db.close();
  }
}
