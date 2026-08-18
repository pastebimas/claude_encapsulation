// State DB for the new viewer. Dot-prefixed so the proxy's migration loop
// skips it. This is the ONLY source of truth for thread conversations — we
// store Claude Code's own stream-json events, never reconstruct from API logs.
import Database from "better-sqlite3";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_DB = path.join(DATA_DIR, ".viewer2-state.db");

export const db = new Database(STATE_DB);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 10000");

db.exec(`
CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'idle',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  read_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project, updated_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  user_text  TEXT NOT NULL,
  sent_text  TEXT NOT NULL,
  run_id     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id, seq);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'new',
  status      TEXT NOT NULL DEFAULT 'running',
  exit_code   INTEGER,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  error       TEXT,
  stream_note TEXT,
  result_json TEXT,
  limit_hit   INTEGER NOT NULL DEFAULT 0,
  resume_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);

CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id      TEXT NOT NULL,
  turn_id        TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  ts             TEXT NOT NULL,
  type           TEXT NOT NULL,
  name           TEXT,
  text           TEXT,
  data_json      TEXT,
  in_tokens      INTEGER NOT NULL DEFAULT 0,
  out_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, seq);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

// Additive migration: the pending clarifying question a run paused on, as JSON
// { question, options[] }. Present only while thread.status = 'awaiting'.
try {
  db.exec("ALTER TABLE threads ADD COLUMN awaiting_json TEXT");
} catch {
  /* column already exists */
}

export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();

// On boot, threads left 'running' can't survive a restart (the ingest thread
// is gone) — mark them and their runs stale so nothing appears stuck.
export function markStaleOnBoot() {
  const ts = now();
  db.prepare(
    "UPDATE runs SET status='stale', finished_at=? WHERE status='running'"
  ).run(ts);
  db.prepare(
    "UPDATE threads SET status='stale', updated_at=? WHERE status='running'"
  ).run(ts);
}

// -- threads / turns ---------------------------------------------------------

export function createThread(project, title) {
  const ts = now();
  const id = uuid();
  const sessionId = uuid();
  db.prepare(
    `INSERT INTO threads (id, project, session_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`
  ).run(id, project, sessionId, title, ts, ts);
  return getThread(id);
}

export function getThread(id) {
  return db.prepare("SELECT * FROM threads WHERE id=?").get(id);
}

export function listThreads(project) {
  return db
    .prepare(
      `SELECT id, project, session_id, title, status, created_at, updated_at, read_at,
              (read_at IS NULL OR updated_at > read_at) AS unread
       FROM threads WHERE project=? ORDER BY updated_at DESC`
    )
    .all(project);
}

export function projectSummaries() {
  return db
    .prepare(
      `SELECT project,
              COUNT(*) AS total,
              SUM(status='running') AS running,
              SUM(read_at IS NULL OR updated_at > read_at) AS unread,
              MAX(updated_at) AS last_ts
       FROM threads GROUP BY project`
    )
    .all();
}

export function setThreadStatus(id, status) {
  // Any status other than 'awaiting' clears a stored question.
  if (status === "awaiting") {
    db.prepare("UPDATE threads SET status=?, updated_at=? WHERE id=?").run(status, now(), id);
  } else {
    db.prepare(
      "UPDATE threads SET status=?, awaiting_json=NULL, updated_at=? WHERE id=?"
    ).run(status, now(), id);
  }
}

export function setThreadAwaiting(id, awaiting) {
  db.prepare(
    "UPDATE threads SET status='awaiting', awaiting_json=?, updated_at=? WHERE id=?"
  ).run(JSON.stringify(awaiting), now(), id);
}

export function touchThread(id) {
  db.prepare("UPDATE threads SET updated_at=? WHERE id=?").run(now(), id);
}

export function markThreadRead(id) {
  db.prepare("UPDATE threads SET read_at=? WHERE id=?").run(now(), id);
}

export function nextTurnSeq(threadId) {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM turns WHERE thread_id=?")
    .get(threadId);
  return (row.m || 0) + 1;
}

export function addTurn(threadId, userText, sentText, runId) {
  const id = uuid();
  const seq = nextTurnSeq(threadId);
  db.prepare(
    `INSERT INTO turns (id, thread_id, seq, user_text, sent_text, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, threadId, seq, userText, sentText, runId, now());
  return getTurn(id);
}

export function setTurnRun(turnId, runId) {
  db.prepare("UPDATE turns SET run_id=? WHERE id=?").run(runId, turnId);
}

export function getTurn(id) {
  return db.prepare("SELECT * FROM turns WHERE id=?").get(id);
}

export function listTurns(threadId) {
  return db
    .prepare("SELECT * FROM turns WHERE thread_id=? ORDER BY seq")
    .all(threadId);
}

// -- runs --------------------------------------------------------------------

export function createRun(threadId, turnId, kind) {
  const id = uuid();
  db.prepare(
    `INSERT INTO runs (id, thread_id, turn_id, kind, status, started_at)
     VALUES (?, ?, ?, ?, 'running', ?)`
  ).run(id, threadId, turnId, kind, now());
  return id;
}

export function updateRun(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k}=?`).join(", ");
  db.prepare(`UPDATE runs SET ${sets} WHERE id=?`).run(
    ...keys.map((k) => fields[k]),
    id
  );
}

export function getRun(id) {
  return db.prepare("SELECT * FROM runs WHERE id=?").get(id);
}

// -- events ------------------------------------------------------------------

export function nextEventSeq(threadId) {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE thread_id=?")
    .get(threadId);
  return (row.m || 0) + 1;
}

export function insertEvent(ev) {
  const seq = nextEventSeq(ev.thread_id);
  const info = db
    .prepare(
      `INSERT INTO events
        (thread_id, turn_id, run_id, seq, ts, type, name, text, data_json,
         in_tokens, out_tokens, cache_read, cache_creation)
       VALUES (@thread_id, @turn_id, @run_id, @seq, @ts, @type, @name, @text,
               @data_json, @in_tokens, @out_tokens, @cache_read, @cache_creation)`
    )
    .run({
      thread_id: ev.thread_id,
      turn_id: ev.turn_id,
      run_id: ev.run_id,
      seq,
      ts: ev.ts || now(),
      type: ev.type,
      name: ev.name || null,
      text: ev.text || null,
      data_json: ev.data_json || null,
      in_tokens: ev.in_tokens || 0,
      out_tokens: ev.out_tokens || 0,
      cache_read: ev.cache_read || 0,
      cache_creation: ev.cache_creation || 0,
    });
  return { id: info.lastInsertRowid, seq };
}

export function listEvents(threadId, since = 0) {
  return db
    .prepare(
      "SELECT * FROM events WHERE thread_id=? AND seq>? ORDER BY seq"
    )
    .all(threadId, since);
}

// -- auth --------------------------------------------------------------------

export function createAuthSession(tokenHash, expiresAt) {
  db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(
    Math.floor(Date.now() / 1000)
  );
  db.prepare(
    "INSERT INTO auth_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)"
  ).run(tokenHash, now(), expiresAt);
}

export function authSessionValid(tokenHash) {
  const row = db
    .prepare("SELECT expires_at FROM auth_sessions WHERE token_hash=?")
    .get(tokenHash);
  return !!row && row.expires_at >= Math.floor(Date.now() / 1000);
}

export function destroyAuthSession(tokenHash) {
  db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(tokenHash);
}
