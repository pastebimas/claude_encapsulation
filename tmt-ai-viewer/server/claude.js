// Dispatch `claude -p --output-format stream-json` inside tmt-ai-code and
// persist Claude Code's own structured events straight into the state DB.
// Nothing here reconstructs conversations from API traffic — the stream-json
// records ARE the conversation.
import { EventEmitter } from "node:events";
import {
  CODE_CONTAINER,
  execStream,
  execCollect,
  resolveExecUser,
} from "./docker.js";
import { addNote } from "./projects.js";
import { ensureWorktree, removeWorktree, branchNameFor, branchPromptNote, directPromptNote } from "./git.js";
import * as db from "./db.js";

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const RUN_TIMEOUT = parseInt(process.env.RUN_TIMEOUT || "3600", 10) * 1000;
const RUN_GIT_PULL = (process.env.RUN_GIT_PULL ?? "1") !== "0";

// Best-effort refresh before a run. Every guard makes it a safe no-op rather
// than a risk: skip non-repos, skip a dirty tree (never touch local work), skip
// when there is no upstream, and --ff-only can only fast-forward or fail — it
// never creates a merge commit or a conflict. No git identity needed.
const GIT_PULL_SCRIPT =
  'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "skipped: not a git repo";' +
  ' elif [ -n "$(git status --porcelain)" ]; then echo "skipped: uncommitted local changes";' +
  ' elif ! git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then echo "skipped: no upstream";' +
  ' else git pull --ff-only 2>&1; fi';

const RUN_PROMPT_SUFFIX =
  process.env.RUN_PROMPT_SUFFIX ??
  "If something extra pops up that is worth returning to later (follow-up" +
    " work, proposals, ideas), do not do it now — end your final reply with a" +
    " 'NOTES:' section listing each item as a '- [ ] item' line; it is saved" +
    " to the project notes.";
const RUN_NO_QUESTIONS =
  process.env.RUN_NO_QUESTIONS ??
  "This task was dispatched from the web dashboard and runs non-interactively —" +
    " you cannot have a live back-and-forth. For minor or low-risk choices, make" +
    " the most reasonable assumption, state it briefly, and carry the task through" +
    " to completion. ONLY if a decision is genuinely blocking and you cannot" +
    " proceed safely without it, stop and ask: end your reply with a block in" +
    " exactly this form, with nothing after it —\n" +
    "QUESTION: <the single blocking question>\n- <option 1>\n- <option 2>\n" +
    "List 2–4 concrete options when you can. The user picks one (or types a free" +
    " answer) and you resume in the same session, so do not ask about anything you" +
    " can reasonably decide yourself.";

const LIMIT_RE = /(?:session|usage|rate)[ _-]?limit|limit reached|hit your .{0,20}limit/i;
// Transient infrastructure failures worth an automatic retry: API/proxy 5xx
// (e.g. "API Error: 500 Proxy error: 400 … Can not decode content-encoding:
// brotli"), overload, or a dropped connection.
const TRANSIENT_RE =
  /API Error:\s*5\d\d|Proxy error:|Can not decode content-encoding|overloaded_error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i;
const RETRY_MINUTES = parseInt(process.env.RUN_TRANSIENT_RETRY_MINUTES || "10", 10);
const RETRY_MAX = parseInt(process.env.RUN_TRANSIENT_RETRY_MAX || "3", 10);
export const AUTO_RETRY_PROMPT =
  "The previous attempt failed with a transient API/proxy error. Try again:" +
  " continue the task from where it left off and carry it through to completion.";
const NOTES_MARKER_RE = /^NOTES:[ \t]*(.*)$/im;
const QUESTION_MARKER_RE = /^QUESTION:[ \t]*(.*)$/im;
const PLAN_OPTIONS = ["✓ Approve & run", "Revise the plan"];

// Runs the user asked to stop, by run id. ingest() consults this on finish so a
// killed run is reported as 'stopped', not 'error'.
const stopping = new Set();
const OPTION_RE = /^\s*[-*]\s+(.*\S)\s*$/;

// Parse a trailing `QUESTION:` block into { question, options[] }. Returns null
// when there is no marker or no question text.
function parseQuestion(resultText) {
  const m = QUESTION_MARKER_RE.exec(resultText || "");
  if (!m) return null;
  const question = m[1].trim();
  if (!question) return null;
  const options = [];
  for (const line of resultText.slice(m.index + m[0].length).split("\n")) {
    const om = OPTION_RE.exec(line);
    if (om) options.push(om[1].trim());
  }
  return { question, options };
}

// Same shape from a real AskUserQuestion tool_use, if the CLI ever emits one in
// print mode. Takes the first question and its option labels.
function parseAskTool(input) {
  const qs = input && input.questions;
  if (!Array.isArray(qs) || !qs.length) return null;
  const first = qs[0];
  const options = (first.options || []).map((o) => o.label).filter(Boolean);
  const question = (first.question || first.header || "").trim();
  return question ? { question, options } : null;
}

// Normalize a requested model to a value safe to hand `claude --model`. Accepts
// the short aliases and any plain model id; anything else (or empty) → null,
// meaning "use the CLI default". Guards the arg boundary even though it's shell-
// quoted downstream.
const MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "default"]);
export function normalizeModel(m) {
  const s = String(m == null ? "" : m).trim();
  if (!s || s === "default") return null;
  if (MODEL_ALIASES.has(s.toLowerCase())) return s.toLowerCase();
  return /^[a-z0-9][a-z0-9.\-:_]{1,80}$/i.test(s) ? s : null;
}

// The wrapper Claude actually receives. Stored in turns.sent_text (raw tab),
// never shown as the request itself.
export function wrapPrompt(userText, kind, opts = {}) {
  let body = userText;
  if (kind === "new" && RUN_PROMPT_SUFFIX) body = `${body}\n\n${RUN_PROMPT_SUFFIX}`;
  // When the run is scoped to a git branch, remind Claude to stay on it and
  // commit locally (applies to both the first run and any resume/followup).
  // Direct ("no commits") threads get the opposite instruction instead.
  if (opts.branch) body = `${body}\n\n${branchPromptNote(opts.branch)}`;
  else if (opts.direct) body = `${body}\n\n${directPromptNote()}`;
  return RUN_NO_QUESTIONS ? `${RUN_NO_QUESTIONS}\n\n${body}` : body;
}

// Build the raw prompt for an external task-dispatch run (taskApi.js). The
// branch is already created + checked out; this run is in plan mode, so it must
// propose a plan whose FINAL step commits to that branch. wrapPrompt() then adds
// the standard non-interactive + NOTES conventions on top.
export function buildTaskPrompt({ id, name, description, comments, branch }) {
  const lines = [
    `You are implementing an external task on the git branch \`${branch}\`, which has already been created and checked out for you in this project.`,
    "Keep ALL work on that branch: do not switch to, create, or merge other branches, and do not push — commit locally only.",
    "",
    `Task ID: ${id}`,
    `Task name: ${name}`,
  ];
  const desc = (description || "").trim();
  lines.push("", "Task description:", desc || "(none provided)");
  const list = normalizeComments(comments);
  if (list.length) {
    lines.push("", "Additional comments / context:");
    for (const c of list) lines.push(`- ${c}`);
  }
  lines.push(
    "",
    "You are in plan mode: research the codebase and propose a plan via ExitPlanMode — do not edit yet.",
    `Your plan's FINAL step MUST be to commit all changes to branch \`${branch}\` with a message like \`task(${id}): ${name}\`. After I approve, implement the plan and make that commit.`
  );
  return lines.join("\n");
}

// Accept comments as string[] or {author?, body}[]; render each to one line.
function normalizeComments(comments) {
  if (!Array.isArray(comments)) return [];
  const out = [];
  for (const c of comments) {
    if (c == null) continue;
    if (typeof c === "string") {
      const t = c.trim();
      if (t) out.push(t.replace(/\s+/g, " "));
    } else if (typeof c === "object") {
      const body = String(c.body ?? c.text ?? "").trim();
      if (!body) continue;
      const author = String(c.author ?? c.user ?? "").trim();
      out.push((author ? `${author}: ${body}` : body).replace(/\s+/g, " "));
    }
  }
  return out;
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const squashTitle = (s, n = 80) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// Unattended (scheduler) runs must not stall on a question overnight.
const RUN_UNATTENDED =
  "This task runs unattended — it was dispatched by the night scheduler and no one is" +
  " watching. Do NOT ask questions: make the most reasonable assumptions, state them" +
  " briefly, and carry the task through to completion.";

function agentsSuffix(n) {
  if (!n || n <= 1) return "";
  return (
    `You may work autonomously and, where it genuinely helps, fan out into up to ${n} ` +
    "parallel subagents (or a Workflow) to complete this efficiently."
  );
}

// Dispatch a queued scheduled task. kind 'prompt' runs as its own new thread;
// kind 'approval' resumes the awaiting thread whose plan the user scheduled
// for tonight. Reuses the normal run path; only the prompt wrapping differs
// (unattended + optional subagents). Returns the thread, or null when nothing
// was dispatched.
export function dispatchScheduled(task) {
  if (task.kind === "approval") return dispatchApproval(task);
  const thread = db.createThread(task.project, squashTitle(task.prompt));
  const branch = branchNameFor(thread.title, thread.id);
  db.setThreadBranch(thread.id, branch);
  const parts = [RUN_UNATTENDED];
  const as = agentsSuffix(task.agents);
  if (as) parts.push(as);
  if (RUN_PROMPT_SUFFIX) parts.push(RUN_PROMPT_SUFFIX);
  parts.push(branchPromptNote(branch));
  const sent = `${parts.join("\n\n")}\n\n${task.prompt}`;
  const turn = db.addTurn(thread.id, task.prompt, sent, null);
  db.updateScheduled(task.id, {
    status: "running",
    thread_id: thread.id,
    started_at: db.now(),
  });
  // Re-fetch so the run carries the branch we just stored.
  startRun(db.getThread(thread.id), turn, "new");
  return thread;
}

// Scheduled plan approval: resume the thread's session with plan mode off so
// the approved plan executes overnight. A still-running thread keeps the task
// queued for a later tick; a thread that is gone or no longer awaiting ends it.
function dispatchApproval(task) {
  const thread = task.thread_id ? db.getThread(task.thread_id) : null;
  if (!thread) {
    db.updateScheduled(task.id, { status: "failed", error: "thread missing", finished_at: db.now() });
    return null;
  }
  if (thread.status === "running") return null;
  // 'stale' still resumes: a restart marked it stale while the approval was
  // queued, but the CLI session itself is resumable.
  if (thread.status !== "awaiting" && thread.status !== "stale") {
    db.updateScheduled(task.id, {
      status: "canceled",
      error: `thread is ${thread.status}, no longer awaiting approval`,
      finished_at: db.now(),
    });
    return null;
  }
  db.setThreadPlanMode(thread.id, false);
  const parts = [RUN_UNATTENDED];
  const as = agentsSuffix(task.agents);
  if (as) parts.push(as);
  if (RUN_PROMPT_SUFFIX) parts.push(RUN_PROMPT_SUFFIX);
  if (thread.branch) parts.push(branchPromptNote(thread.branch));
  const sent = `${parts.join("\n\n")}\n\n${task.prompt}`;
  const turn = db.addTurn(thread.id, task.prompt, sent, null);
  db.setThreadStatus(thread.id, "running");
  db.updateScheduled(task.id, { status: "running", started_at: db.now() });
  startRun(db.getThread(thread.id), turn, "resume");
  return thread;
}

function emitEvent(ev) {
  const { seq, id } = db.insertEvent(ev);
  db.touchThread(ev.thread_id);
  bus.emit(ev.thread_id, { t: "event", event: { ...ev, seq, id } });
}

// Turn one stream-json record into event rows.
function ingestRecord(ctx, obj) {
  const common = { thread_id: ctx.threadId, turn_id: ctx.turnId, run_id: ctx.runId };
  const type = obj.type;
  if (type === "system") {
    emitEvent({
      ...common,
      type: "system",
      name: obj.subtype || null,
      text: obj.subtype === "init" ? `session ${obj.session_id || ""}` : null,
      data_json: JSON.stringify(obj),
    });
  } else if (type === "assistant" && obj.message) {
    const usage = obj.message.usage || {};
    for (const block of obj.message.content || []) {
      if (block.type === "text") {
        emitEvent({
          ...common,
          type: "assistant_text",
          text: block.text || "",
          out_tokens: usage.output_tokens || 0,
        });
      } else if (block.type === "thinking") {
        emitEvent({
          ...common,
          type: "thinking",
          text: block.thinking || "",
          data_json: JSON.stringify(block),
        });
      } else if (block.type === "tool_use") {
        if (block.name === "AskUserQuestion") {
          const q = parseAskTool(block.input);
          if (q) ctx.askQuestion = q;
        } else if (block.name === "ExitPlanMode" || block.name === "exit_plan_mode") {
          ctx.plan = (block.input && block.input.plan) || "";
        }
        emitEvent({
          ...common,
          type: "tool_use",
          name: block.name || "",
          text: null,
          data_json: JSON.stringify(block.input ?? {}),
        });
      }
    }
  } else if (type === "user" && obj.message) {
    for (const block of obj.message.content || []) {
      if (block.type === "tool_result") {
        emitEvent({
          ...common,
          type: "tool_result",
          name: block.tool_use_id || null,
          text: flattenToolResult(block.content),
          data_json: JSON.stringify(block),
        });
      }
    }
  } else if (type === "result") {
    ctx.resultSeen = true;
    ctx.resultJson = JSON.stringify(obj);
    ctx.resultText = obj.result || "";
    const u = obj.usage || {};
    emitEvent({
      ...common,
      type: "result",
      text: obj.result || "",
      data_json: JSON.stringify(obj),
      in_tokens: u.input_tokens || 0,
      out_tokens: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      cache_creation: u.cache_creation_input_tokens || 0,
    });
  }
}

function flattenToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b) => (typeof b === "string" ? b : b.text || ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

function handleLine(ctx, line) {
  const s = line.trim();
  if (!s || s[0] !== "{") return;
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return;
  }
  ctx.processed++;
  ingestRecord(ctx, obj);
}

// Kick off a run for an already-created turn. Returns immediately; ingest runs
// in the background and streams to `bus`.
export function startRun(thread, turn, kind) {
  const runId = db.createRun(thread.id, turn.id, kind);
  db.setTurnRun(turn.id, runId);
  ingest(thread, turn, runId, kind).catch((e) => {
    console.error(`run ${runId} failed:`, e);
    db.updateRun(runId, {
      status: "error",
      error: e.message,
      finished_at: db.now(),
    });
    db.setThreadStatus(thread.id, "error");
    bus.emit(thread.id, { t: "status", status: "error" });
  });
  return runId;
}

// Stop a thread's in-flight run. Kills the claude process inside the container
// by its unique session id; ingest() then finalizes the run as 'stopped'.
export async function stopThread(threadId) {
  const thread = db.getThread(threadId);
  if (!thread) return { ok: false, error: "no such thread" };
  const run = db.latestRun(threadId);
  if (run && run.status === "running") stopping.add(run.id);
  const user = await resolveExecUser();
  try {
    await execCollect(CODE_CONTAINER, ["pkill", "-9", "-f", thread.session_id], { user });
  } catch {
    /* pkill exits non-zero when nothing matched — fine */
  }
  return { ok: true };
}

async function ingest(thread, turn, runId, kind) {
  const outFile = `/tmp/tmt2-${runId}.jsonl`;
  const errFile = `/tmp/tmt2-${runId}.err`;
  const user = await resolveExecUser();
  const sid = thread.session_id;

  // Set up an isolated worktree for this run so concurrent same-project runs
  // never share a checkout. Falls back to the main tree if setup fails; a
  // non-git project self-heals (clear the branch, run plainly).
  let workdir = `/workspace/${thread.project}`;
  if (thread.branch) {
    const wt = await ensureWorktree(thread.project, thread.branch, user);
    emitEvent({
      thread_id: thread.id,
      turn_id: turn.id,
      run_id: runId,
      type: "system",
      name: "git_branch",
      text: wt.ok
        ? `on ${thread.branch} — worktree ${wt.reused ? "reused" : "created"}`
        : `worktree skipped: ${wt.error}${wt.detail ? ` — ${wt.detail}` : ""} (main tree)`,
    });
    if (wt.ok) workdir = wt.path;
    else if (wt.error === "not_a_git_repo") {
      db.setThreadBranch(thread.id, null);
      thread.branch = null;
    }
  }

  // Pull newest changes into the run's checkout (safe no-op if not
  // fast-forwardable). Never blocks the run — gitPull swallows its own errors.
  if (RUN_GIT_PULL) await gitPull(thread, turn.id, runId, user, workdir);

  const args = ["claude", "-p", "--verbose", "--output-format", "stream-json"];
  // Model override chosen when the request was sent (alias like opus/sonnet/haiku
  // or a full id). Empty → the CLI's configured default. Applies to every run of
  // the thread, plan or regular.
  if (thread.model) args.push("--model", thread.model);
  // Plan mode: Claude researches and proposes a plan (via ExitPlanMode) instead
  // of editing; the dashboard surfaces it for approval.
  if (thread.plan_mode) args.push("--permission-mode", "plan");
  // Fresh run: assign the session id up front so the thread maps immediately.
  // Resume: --resume alone continues that same session (passing --session-id
  // too is rejected unless --fork-session).
  if (kind === "resume") args.push("--resume", sid);
  else args.push("--session-id", sid);
  args.push(turn.sent_text);

  // tee: the exec's stdout (the attach stream we read live) also lands in a
  // file, so if the socket-proxy drops a quiet stream we recover the tail.
  const shell = `${args.map(shq).join(" ")} 2>${shq(errFile)} | tee ${shq(outFile)}`;

  const ctx = { threadId: thread.id, turnId: turn.id, runId, processed: 0, resultSeen: false };

  const { exitCode, stderr, note } = await execStream(CODE_CONTAINER, ["sh", "-c", shell], {
    workdir,
    user,
    onStdoutLine: (l) => handleLine(ctx, l),
    deadlineMs: RUN_TIMEOUT,
  });

  // Tail-catch: re-read the file for anything the live stream missed.
  if (note || !ctx.resultSeen) {
    try {
      const { stdout } = await execCollect(CODE_CONTAINER, ["cat", outFile]);
      const lines = stdout.split("\n");
      for (const l of lines.slice(ctx.processed)) handleLine(ctx, l);
    } catch {
      /* best effort */
    }
  }

  let errText = stderr || "";
  try {
    const { stdout } = await execCollect(CODE_CONTAINER, ["cat", errFile]);
    if (stdout.trim()) errText = `${errText}\n${stdout}`.trim();
  } catch {
    /* ignore */
  }

  const wasStopped = stopping.delete(runId);
  const ok = exitCode === 0 && ctx.resultSeen;
  const status = wasStopped ? "stopped" : ok ? "done" : "error";

  const fields = {
    status,
    exit_code: exitCode,
    finished_at: db.now(),
    stream_note: note,
    result_json: ctx.resultJson || null,
    error: status === "error" ? errText || `exit ${exitCode}` || null : null,
  };

  // usage-limit / transient-error detection → mark resumable + schedule. The
  // retry loop (startRetryLoop) picks runs up once resume_at passes. Only an
  // errored run schedules a retry — a successful result may merely *quote* an
  // error string (e.g. a task about fixing one).
  const haystack = `${errText}\n${ctx.resultText || ""}`;
  if (!wasStopped && LIMIT_RE.test(haystack)) {
    fields.limit_hit = 1;
    fields.resume_at = new Date(
      Date.now() + parseInt(process.env.RUN_LIMIT_RETRY_MINUTES || "30", 10) * 60000
    ).toISOString();
  } else if (
    status === "error" &&
    TRANSIENT_RE.test(haystack) &&
    db.countTurnsWithText(thread.id, AUTO_RETRY_PROMPT) < RETRY_MAX
  ) {
    fields.resume_at = new Date(Date.now() + RETRY_MINUTES * 60000).toISOString();
  }

  db.updateRun(runId, fields);

  // Decide whether the thread should pause for the user. Priority:
  //   1. a clarifying question (QUESTION marker or AskUserQuestion tool)
  //   2. a plan awaiting approval (ExitPlanMode, or any plan-mode run's output)
  // Either parks the thread as 'awaiting'; the answer/approval resumes it.
  let awaiting = null;
  if (ok && !wasStopped) {
    const question = parseQuestion(ctx.resultText) || ctx.askQuestion;
    if (question) {
      awaiting = question;
    } else if (ctx.plan != null) {
      awaiting = { plan: ctx.plan || ctx.resultText || "", options: PLAN_OPTIONS };
    } else if (thread.plan_mode) {
      awaiting = { plan: ctx.resultText || "(no plan text)", options: PLAN_OPTIONS };
    }
  }
  if (awaiting) db.setThreadAwaiting(thread.id, awaiting);
  else db.setThreadStatus(thread.id, status);

  // Save any NOTES: trailer to the project notes (proxy's notes table).
  if (ctx.resultText) saveNotes(thread, ctx.resultText);

  bus.emit(thread.id, {
    t: "status",
    status: awaiting ? "awaiting" : status,
    run: db.getRun(runId),
  });
  if (awaiting) bus.emit(thread.id, { t: "awaiting", awaiting });
  bus.emit(thread.id, { t: "done" });

  // Reclaim the worktree once the thread is terminal; keep it while awaiting a
  // follow-up (or an auto-retry) so the resume is instant and uncommitted work
  // survives. Branch + commits remain in .git.
  if (thread.branch && !awaiting && !fields.resume_at)
    removeWorktree(thread.project, thread.branch, user).catch(() => {});

  execCollect(CODE_CONTAINER, ["rm", "-f", outFile, errFile]).catch(() => {});
}

async function gitPull(thread, turnId, runId, user, workdir) {
  let out = "";
  try {
    const r = await execCollect(CODE_CONTAINER, ["sh", "-c", GIT_PULL_SCRIPT], {
      workdir,
      user,
      deadlineMs: 60_000,
    });
    out = (r.stdout || "").trim() || (r.stderr || "").trim();
  } catch (e) {
    out = `error: ${e.message}`;
  }
  emitEvent({
    thread_id: thread.id,
    turn_id: turnId,
    run_id: runId,
    type: "system",
    name: "git_pull",
    text: out || "already up to date",
  });
}

// -- auto-retry loop ---------------------------------------------------------
// Consumes errored runs whose resume_at has passed (usage limit or transient
// API/proxy failure) and resumes their thread with a "try again" follow-up.
// DB-driven, so pending retries survive a server restart.
export function startRetryLoop() {
  setInterval(retryTick, 60_000);
  console.log("auto-retry loop started");
}

function retryTick() {
  try {
    for (const run of db.dueRetryRuns()) {
      // One shot per scheduled retry — clear before dispatch so a failure in
      // startRun can't loop every tick.
      db.updateRun(run.id, { resume_at: null });
      const thread = db.getThread(run.thread_id);
      if (!thread || thread.status === "running" || thread.status === "awaiting") continue;
      // The user (or another retry) already moved the thread past this run.
      const latest = db.latestRun(thread.id);
      if (!latest || latest.id !== run.id) continue;
      const sent = wrapPrompt(AUTO_RETRY_PROMPT, "resume", { branch: thread.branch || null });
      const turn = db.addTurn(thread.id, AUTO_RETRY_PROMPT, sent, null);
      db.setThreadStatus(thread.id, "running");
      bus.emit(thread.id, { t: "status", status: "running" });
      startRun(thread, turn, "resume");
      console.log(`auto-retry: resuming thread ${thread.id} after run ${run.id} failed`);
    }
  } catch (e) {
    console.error("retry tick:", e.message);
  }
}

function saveNotes(thread, resultText) {
  const m = NOTES_MARKER_RE.exec(resultText);
  if (!m) return;
  const body = resultText.slice(m.index + m[0].length).trim();
  const combined = [m[1].trim(), body].filter(Boolean).join("\n").trim();
  if (!combined) return;
  try {
    addNote(thread.project, {
      title: thread.title.slice(0, 80),
      body: combined,
      origin: "agent",
      session_id: thread.session_id,
    });
  } catch (e) {
    console.error("saveNotes failed:", e.message);
  }
}
