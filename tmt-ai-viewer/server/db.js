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

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  agents      INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'queued',
  position    INTEGER NOT NULL DEFAULT 0,
  thread_id   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sched_status ON scheduled_tasks(status, position);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Additive migrations (guarded — the columns may already exist).
// awaiting_json: the pending question/plan a run paused on, as JSON. Present
//   only while thread.status = 'awaiting'.
// plan_mode: 1 → dispatch this thread's runs with --permission-mode plan.
// model: CLI --model value (alias or id) applied to every run; NULL → default.
// ext_task_id / ext_task_source / branch: set when a thread was created by the
//   external task-dispatch API (taskApi.js) — the caller's task id, where it
//   came from, and the git branch the work is scoped to.
// unattended: 1 → nobody is watching (night scheduler). Such runs auto-save
//   their NOTES: trailer to notes instead of parking as an awaiting suggestions
//   picker (there's no one to pick).
// scheduled_tasks.kind: 'prompt' = fresh night task run as its own thread;
//   'approval' = resume the awaiting thread in thread_id with its plan approved.
// runs.tokens_new / tokens_total: what the run used. tokens_new is
//   input+output+cache-write (the ceilings count this); tokens_total adds
//   cache-read, which is shown but never capped.
// threads.budget_tokens / budget_total_tokens: per-run and whole-thread
//   ceilings in new tokens. NULL = use the server default, 0 = no ceiling.
for (const ddl of [
  "ALTER TABLE threads ADD COLUMN awaiting_json TEXT",
  "ALTER TABLE threads ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE threads ADD COLUMN model TEXT",
  "ALTER TABLE threads ADD COLUMN ext_task_id TEXT",
  "ALTER TABLE threads ADD COLUMN ext_task_source TEXT",
  "ALTER TABLE threads ADD COLUMN branch TEXT",
  "ALTER TABLE threads ADD COLUMN direct_mode INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE threads ADD COLUMN unattended INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE scheduled_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'prompt'",
  "ALTER TABLE runs ADD COLUMN tokens_new INTEGER",
  "ALTER TABLE runs ADD COLUMN tokens_total INTEGER",
  "ALTER TABLE threads ADD COLUMN budget_tokens INTEGER",
  "ALTER TABLE threads ADD COLUMN budget_total_tokens INTEGER",
]) {
  try {
    db.exec(ddl);
  } catch {
    /* already applied */
  }
}
try {
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_threads_ext_task ON threads(project, ext_task_id)"
  );
} catch {
  /* column not present yet on a very old db — the ALTERs above create it first */
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
  // A scheduled task whose dispatched thread can't survive the restart goes back
  // in the queue so the scheduler can pick it up again. Approval tasks keep
  // their thread_id — it IS the session they are meant to resume.
  db.prepare(
    `UPDATE scheduled_tasks
     SET status='queued',
         thread_id=CASE WHEN kind='approval' THEN thread_id ELSE NULL END,
         updated_at=?
     WHERE status='running'`
  ).run(ts);
}

// -- scheduled tasks ---------------------------------------------------------

export function listScheduled() {
  return db
    .prepare(
      `SELECT s.*, t.title AS thread_title
       FROM scheduled_tasks s LEFT JOIN threads t ON t.id = s.thread_id
       ORDER BY s.position, s.created_at`
    )
    .all();
}

export function getScheduled(id) {
  return db.prepare("SELECT * FROM scheduled_tasks WHERE id=?").get(id);
}

export function addScheduled(project, prompt, agents = 1, { kind = "prompt", thread_id = null } = {}) {
  const ts = now();
  const id = uuid();
  const row = db
    .prepare("SELECT COALESCE(MAX(position), 0) AS m FROM scheduled_tasks")
    .get();
  db.prepare(
    `INSERT INTO scheduled_tasks (id, project, prompt, agents, status, position, kind, thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
  ).run(id, project, prompt, Math.max(1, agents | 0), (row.m || 0) + 1, kind, thread_id, ts, ts);
  return getScheduled(id);
}

export function updateScheduled(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k}=?`).join(", ");
  db.prepare(`UPDATE scheduled_tasks SET ${sets}, updated_at=? WHERE id=?`).run(
    ...keys.map((k) => fields[k]),
    now(),
    id
  );
}

export function deleteScheduled(id) {
  db.prepare("DELETE FROM scheduled_tasks WHERE id=?").run(id);
}

export function reorderScheduled(ids) {
  const stmt = db.prepare("UPDATE scheduled_tasks SET position=?, updated_at=? WHERE id=?");
  const ts = now();
  const tx = db.transaction((list) => {
    list.forEach((id, i) => stmt.run(i + 1, ts, id));
  });
  tx(ids);
}

export function listQueued() {
  return db
    .prepare("SELECT * FROM scheduled_tasks WHERE status='queued' ORDER BY position, created_at")
    .all();
}

// The live (queued or dispatched) night approval for a thread, if any.
export function approvalTaskForThread(threadId) {
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE kind='approval' AND thread_id=? AND status IN ('queued','running')
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(threadId);
}

// Acting on the thread manually supersedes its night-scheduled approval.
export function cancelQueuedApprovals(threadId) {
  db.prepare(
    "DELETE FROM scheduled_tasks WHERE kind='approval' AND thread_id=? AND status='queued'"
  ).run(threadId);
}

export function runningScheduledCount() {
  return db
    .prepare("SELECT COUNT(*) AS n FROM scheduled_tasks WHERE status='running'")
    .get().n;
}

export function runningScheduled() {
  return db.prepare("SELECT * FROM scheduled_tasks WHERE status='running'").all();
}

// -- settings (key/value JSON) -----------------------------------------------

export function getSettings(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function setSettings(key, obj) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, JSON.stringify(obj));
}

// -- threads / turns ---------------------------------------------------------

export function createThread(project, title, planMode = false, model = null, direct = false) {
  const ts = now();
  const id = uuid();
  const sessionId = uuid();
  db.prepare(
    `INSERT INTO threads (id, project, session_id, title, status, plan_mode, model, direct_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`
  ).run(id, project, sessionId, title, planMode ? 1 : 0, model || null, direct ? 1 : 0, ts, ts);
  return getThread(id);
}

export function setThreadPlanMode(id, on) {
  db.prepare("UPDATE threads SET plan_mode=? WHERE id=?").run(on ? 1 : 0, id);
}

// Mark a thread as unattended (night scheduler) so its finished runs auto-save
// the NOTES: trailer instead of parking as a suggestions picker no one will act
// on.
export function setThreadUnattended(id) {
  db.prepare("UPDATE threads SET unattended=1 WHERE id=?").run(id);
}

export function setThreadModel(id, model) {
  db.prepare("UPDATE threads SET model=? WHERE id=?").run(model || null, id);
}

// The git branch this thread's work is scoped to. Pass null to clear it (e.g.
// when the project turns out not to be a git repo).
export function setThreadBranch(id, branch) {
  db.prepare("UPDATE threads SET branch=? WHERE id=?").run(branch || null, id);
}

// Thread created by the external task-dispatch API. Always plan_mode=1 (it must
// produce a plan for approval before touching the branch) and carries the
// caller's task id + the git branch the work lives on.
export function createTaskThread(project, title, { branch, ext_task_id, ext_task_source, model } = {}) {
  const ts = now();
  const id = uuid();
  const sessionId = uuid();
  db.prepare(
    `INSERT INTO threads
       (id, project, session_id, title, status, plan_mode, model, ext_task_id, ext_task_source, branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', 1, ?, ?, ?, ?, ?, ?)`
  ).run(id, project, sessionId, title, model || null, ext_task_id || null, ext_task_source || null, branch || null, ts, ts);
  return getThread(id);
}

// Look up a thread previously created for (project, ext_task_id) so a retried
// webhook is idempotent instead of forking a second branch/thread. Newest first.
export function findThreadByExtTask(project, extTaskId) {
  return db
    .prepare(
      "SELECT * FROM threads WHERE project=? AND ext_task_id=? ORDER BY created_at DESC LIMIT 1"
    )
    .get(project, extTaskId);
}

export function getThread(id) {
  return db.prepare("SELECT * FROM threads WHERE id=?").get(id);
}

export function listThreads(project) {
  return db
    .prepare(
      `SELECT id, project, session_id, title, status, plan_mode, model, branch, direct_mode,
              budget_tokens, budget_total_tokens, created_at, updated_at, read_at,
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

// Manually flag a thread as unread ("come back to this later"). Clearing
// read_at makes it unread again without touching updated_at.
export function markThreadUnread(id) {
  db.prepare("UPDATE threads SET read_at=NULL WHERE id=?").run(id);
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

export function latestRun(threadId) {
  return db
    .prepare("SELECT * FROM runs WHERE thread_id=? ORDER BY started_at DESC LIMIT 1")
    .get(threadId);
}

// New tokens this thread has used so far, summed over its runs. Runs that never
// reported (stopped, crashed) count as 0.
export function threadTokens(threadId) {
  return (
    db
      .prepare("SELECT COALESCE(SUM(tokens_new), 0) AS n FROM runs WHERE thread_id=?")
      .get(threadId).n || 0
  );
}

// Per-run / whole-thread ceilings. undefined leaves a field alone; null resets
// it to the server default; 0 means "no ceiling".
export function setThreadBudget(id, { run, total } = {}) {
  if (run !== undefined)
    db.prepare("UPDATE threads SET budget_tokens=? WHERE id=?").run(run, id);
  if (total !== undefined)
    db.prepare("UPDATE threads SET budget_total_tokens=? WHERE id=?").run(total, id);
}

// The thread's most recent turn — used to re-dispatch the turn that was parked
// on a budget stop instead of appending a duplicate one.
export function latestTurn(threadId) {
  return db
    .prepare("SELECT * FROM turns WHERE thread_id=? ORDER BY seq DESC LIMIT 1")
    .get(threadId);
}

// Errored runs whose scheduled auto-retry time has passed.
export function dueRetryRuns() {
  return db
    .prepare("SELECT * FROM runs WHERE status='error' AND resume_at IS NOT NULL AND resume_at <= ?")
    .all(now());
}

// A retry is queued for this thread but hasn't fired yet.
export function hasPendingRetry(threadId) {
  return !!db
    .prepare("SELECT 1 FROM runs WHERE thread_id=? AND status='error' AND resume_at IS NOT NULL LIMIT 1")
    .get(threadId);
}

// How many turns with exactly this user_text the thread already has — caps the
// number of automatic "try again" follow-ups.
export function countTurnsWithText(threadId, text) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM turns WHERE thread_id=? AND user_text=?")
    .get(threadId, text).n;
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
