// Read-only-ish access to the proxy's per-project data/<name>.db files. Used
// only for the token-usage header and the notes table (shared with the proxy).
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = process.env.DATA_DIR || "/data";

export function projectDbPath(project) {
  return path.join(DATA_DIR, `${project}.db`);
}

function openProject(project, { readonly = false } = {}) {
  const p = projectDbPath(project);
  if (!fs.existsSync(p)) return null;
  return new Database(p, { readonly, timeout: 10000 });
}

const NOTES_DDL = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'user',
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
);`;

export function listNotes(project) {
  const db = openProject(project);
  if (!db) return [];
  try {
    db.exec(NOTES_DDL);
    return db.prepare("SELECT * FROM notes ORDER BY created_at DESC").all();
  } catch (e) {
    return [];
  } finally {
    db.close();
  }
}

export function addNote(project, { title = "", body = "", origin = "user", session_id = null }) {
  const db = openProject(project);
  if (!db) return null;
  try {
    db.exec(NOTES_DDL);
    const info = db
      .prepare(
        "INSERT INTO notes (title, body, origin, session_id) VALUES (?, ?, ?, ?)"
      )
      .run(title, body, origin, session_id);
    return info.lastInsertRowid;
  } finally {
    db.close();
  }
}

// Rewrite an existing note's body/title (checkbox toggles rewrite the whole
// body string, same as the old viewer). Only the fields provided are changed.
export function updateNote(project, id, { body = null, title = null }) {
  const db = openProject(project);
  if (!db) return false;
  try {
    db.exec(NOTES_DDL);
    const info = db
      .prepare(
        `UPDATE notes
           SET body = COALESCE(?, body),
               title = COALESCE(?, title),
               updated_at = strftime('%Y-%m-%dT%H:%M:%f','now')
         WHERE id = ?`
      )
      .run(body, title, id);
    return info.changes > 0;
  } finally {
    db.close();
  }
}

// token usage expression, mirroring the old viewer's json_extract approach.
const TOK_FIELDS = [
  ["input_tokens", "input_tokens"],
  ["output_tokens", "output_tokens"],
  ["cache_creation_input_tokens", "cache_creation_tokens"],
  ["cache_read_input_tokens", "cache_read_tokens"],
];
const tok = (f) =>
  `CASE WHEN r.response_body IS NOT NULL AND json_valid(r.response_body)` +
  ` THEN COALESCE(json_extract(r.response_body,'$.usage.${f}'),0) ELSE 0 END`;
const TOKEN_SUMS = TOK_FIELDS.map(([f, a]) => `COALESCE(SUM(${tok(f)}),0) AS ${a}`).join(", ");
export const TOKEN_KEYS = TOK_FIELDS.map(([, a]) => a);

export function projectTokensSince(project, cutoffIso) {
  const db = openProject(project, { readonly: true });
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n, ${TOKEN_SUMS} FROM request_logs r WHERE r.timestamp >= ?`
      )
      .get(cutoffIso);
    return row && row.n ? row : null;
  } catch (e) {
    return null;
  } finally {
    db.close();
  }
}
