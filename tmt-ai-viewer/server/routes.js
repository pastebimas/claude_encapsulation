import { Router } from "express";
import * as db from "./db.js";
import * as auth from "./auth.js";
import { bus, startRun, wrapPrompt, stopThread, dispatchScheduled, dispatchNewThread, normalizeModel } from "./claude.js";
import { schedulerConfig, saveSchedulerConfig, policyDecision } from "./scheduler.js";
import { usageWindows, latestLimits } from "./usage.js";
import { listNotes, addNote, updateNote } from "./projects.js";
import {
  listWorkspaceProjects,
  projectDockerStatus,
  projectContext,
} from "./docker.js";
import { gitBranchInfo, gitDiff, localBranchExists } from "./git.js";

const router = Router();

const squash = (s, n = 80) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// Parse a thread's awaiting_json; return its suggestions[] or [].
function awaitingSuggestions(thread) {
  if (!thread || thread.status !== "awaiting" || !thread.awaiting_json) return [];
  try {
    const a = JSON.parse(thread.awaiting_json);
    return Array.isArray(a.suggestions) ? a.suggestions : [];
  } catch {
    return [];
  }
}

// Save a list of suggestion items to the project notes as open checklist lines.
function saveSuggestionNotes(thread, items) {
  if (!items.length) return;
  addNote(thread.project, {
    title: (thread.title || "").slice(0, 80),
    body: items.map((t) => `- [ ] ${t}`).join("\n"),
    origin: "agent",
    session_id: thread.session_id,
  });
}

// -- auth --------------------------------------------------------------------
router.post("/login", auth.login);
router.post("/logout", auth.logout);
router.get("/me", (req, res) =>
  res.json({ auth_enabled: auth.authEnabled(), authed: auth.isAuthed(req) })
);

// -- projects ----------------------------------------------------------------
router.get("/projects", async (req, res) => {
  let mounts = [];
  try {
    mounts = await listWorkspaceProjects();
  } catch (e) {
    /* fall back to whatever has threads */
  }
  const summary = Object.fromEntries(db.projectSummaries().map((s) => [s.project, s]));
  const names = new Set([...mounts, ...Object.keys(summary)]);
  const projects = [...names]
    .map((name) => {
      const s = summary[name] || {};
      return {
        name,
        total: s.total || 0,
        running: s.running || 0,
        unread: s.unread || 0,
        last_ts: s.last_ts || null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ projects });
});

router.get("/project_status", async (req, res) => {
  res.json(await projectDockerStatus(String(req.query.project || "")));
});

router.get("/context", async (req, res) => {
  res.json(await projectContext(String(req.query.project || "")));
});

router.get("/notes", (req, res) => {
  res.json({ notes: listNotes(String(req.query.project || "")) });
});
router.post("/notes", (req, res) => {
  const { project, title, body } = req.body || {};
  if (!project || !body) return res.status(400).json({ error: "project and body required" });
  const id = addNote(project, { title: title || "", body, origin: "user" });
  res.json({ ok: true, id });
});
router.post("/notes/update", (req, res) => {
  const { project, id, body, title } = req.body || {};
  if (!project || !id) return res.status(400).json({ error: "project and id required" });
  const ok = updateNote(project, id, {
    body: body ?? null,
    title: title ?? null,
  });
  res.json({ ok });
});

// -- threads -----------------------------------------------------------------
router.get("/threads", (req, res) => {
  res.json({ threads: db.listThreads(String(req.query.project || "")) });
});

router.post("/threads", async (req, res) => {
  const { project, prompt, plan, model, direct, branch: existing } = req.body || {};
  if (!project || !prompt || !prompt.trim())
    return res.status(400).json({ error: "project and prompt required" });
  // An explicitly-picked existing branch is validated before the thread row is
  // created (no orphan threads on a typo'd/deleted branch) and overrides direct.
  const useExisting = existing && String(existing).trim();
  if (useExisting && !(await localBranchExists(project, useExisting)))
    return res
      .status(400)
      .json({ error: "no such branch — only existing claude/* branches can be selected" });
  // A request pinned to an existing branch reuses that branch (and its
  // worktree). Otherwise dispatchNewThread creates its own claude/* branch —
  // ingest() checks it out (self-healing to a plain run for non-git projects) —
  // or, in direct ("no commits") mode, runs in the main tree uncommitted.
  if (useExisting) {
    const thread = db.createThread(project, squash(prompt), !!plan, normalizeModel(model), false);
    db.setThreadBranch(thread.id, useExisting);
    const sent = wrapPrompt(prompt, "new", { branch: useExisting });
    const turn = db.addTurn(thread.id, prompt, sent, null);
    startRun(db.getThread(thread.id), turn, "new");
    return res.json({ thread_id: thread.id, branch: useExisting });
  }
  const { thread, branch } = dispatchNewThread(project, prompt, {
    plan: !!plan,
    model,
    direct: !!direct,
  });
  res.json({ thread_id: thread.id, branch });
});

router.post("/thread/followup", (req, res) => {
  const { id, prompt, plan, model } = req.body || {};
  const existing = db.getThread(id);
  if (!existing) return res.status(404).json({ error: "no such thread" });
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: "prompt required" });
  // A manual follow-up supersedes any pending suggestions picker — flush those
  // items to notes so ignoring the picker never loses them.
  saveSuggestionNotes(existing, awaitingSuggestions(existing));
  // A manual follow-up supersedes any night-scheduled approval of this thread.
  db.cancelQueuedApprovals(id);
  // Approving a plan turns plan mode off so the resume run executes; any other
  // explicit value flips it too. Omitted → keep the thread's current mode.
  if (plan !== undefined) db.setThreadPlanMode(id, !!plan);
  // A model sent with the follow-up switches the model for this and later runs;
  // omitted → keep whatever the thread already uses.
  if (model !== undefined) db.setThreadModel(id, normalizeModel(model));
  const thread = db.getThread(id);
  const sent = wrapPrompt(prompt, "resume", {
    branch: thread.branch || null,
    direct: !!thread.direct_mode,
  });
  const turn = db.addTurn(thread.id, prompt, sent, null);
  db.setThreadStatus(thread.id, "running");
  startRun(thread, turn, "resume");
  res.json({ ok: true, turn_id: turn.id });
});

// Resolve a suggestions picker: dispatch the selected items as their own new
// runs, save the rest to the project notes, and finish this thread. `run` is the
// subset of the awaiting suggestions the user chose to run now.
router.post("/thread/suggestions", (req, res) => {
  const { id, run } = req.body || {};
  const thread = db.getThread(id);
  if (!thread) return res.status(404).json({ error: "no such thread" });
  const suggestions = awaitingSuggestions(thread);
  if (!suggestions.length)
    return res.status(409).json({ error: "thread has no pending suggestions" });
  const wanted = new Set(Array.isArray(run) ? run : []);
  const selected = suggestions.filter((s) => wanted.has(s));
  const leftover = suggestions.filter((s) => !wanted.has(s));
  const dispatched = [];
  for (const item of selected) {
    const { thread: t } = dispatchNewThread(thread.project, item);
    dispatched.push(t.id);
  }
  saveSuggestionNotes(thread, leftover);
  db.setThreadStatus(thread.id, "done");
  bus.emit(thread.id, { t: "status", status: "done" });
  res.json({ ok: true, dispatched: dispatched.length, saved: leftover.length });
});

router.post("/thread/stop", async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "id required" });
  res.json(await stopThread(id));
});

// Queue tonight's approval of the plan this thread is awaiting: instead of
// running now, the night scheduler resumes this same session with plan mode
// off once the window/idle/policy gates pass (scheduled_tasks kind 'approval').
router.post("/thread/schedule_approval", (req, res) => {
  const { id, prompt, agents } = req.body || {};
  const thread = db.getThread(id);
  if (!thread) return res.status(404).json({ error: "no such thread" });
  if (thread.status !== "awaiting")
    return res.status(409).json({ error: "thread is not awaiting approval" });
  const existing = db.approvalTaskForThread(id);
  if (existing) return res.json({ ok: true, task: existing });
  const text =
    (prompt && String(prompt).trim()) || "The plan is approved. Proceed and implement it.";
  const task = db.addScheduled(thread.project, text, parseInt(agents, 10) || 1, {
    kind: "approval",
    thread_id: id,
  });
  res.json({ ok: true, task });
});

router.get("/thread", (req, res) => {
  const thread = db.getThread(String(req.query.id || ""));
  if (!thread) return res.status(404).json({ error: "no such thread" });
  db.markThreadRead(thread.id);
  res.json({
    thread,
    scheduled_approval: db.approvalTaskForThread(thread.id) || null,
    turns: db.listTurns(thread.id),
    events: db.listEvents(thread.id, 0),
  });
});

router.get("/thread/events", (req, res) => {
  const id = String(req.query.id || "");
  const since = parseInt(req.query.since || "0", 10);
  res.json({ events: db.listEvents(id, since) });
});

router.get("/thread/raw", (req, res) => {
  const id = String(req.query.id || "");
  const thread = db.getThread(id);
  if (!thread) return res.status(404).json({ error: "no such thread" });
  const turns = db.listTurns(id);
  res.json({
    thread,
    turns: turns.map((t) => ({ seq: t.seq, user_text: t.user_text, sent_text: t.sent_text })),
    events: db.listEvents(id, 0).map((e) => ({ seq: e.seq, type: e.type, name: e.name, data_json: e.data_json })),
  });
});

router.post("/thread/read", (req, res) => {
  const { id } = req.body || {};
  if (id) db.markThreadRead(id);
  res.json({ ok: true });
});

router.post("/thread/unread", (req, res) => {
  const { id } = req.body || {};
  if (id) db.markThreadUnread(id);
  res.json({ ok: true });
});

// -- SSE live event stream ---------------------------------------------------
router.get("/thread/stream", (req, res) => {
  const id = String(req.query.id || "");
  const since = parseInt(req.query.since || "0", 10);
  if (!db.getThread(id)) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const send = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);

  // Buffer live events until the replay catches up, so nothing is lost or
  // reordered relative to what the client already has.
  let replaying = true;
  const buffered = [];
  const listener = (msg) => (replaying ? buffered.push(msg) : send(msg));
  bus.on(id, listener);

  for (const ev of db.listEvents(id, since)) send({ t: "event", event: ev });
  replaying = false;
  for (const msg of buffered) send(msg);

  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    bus.off(id, listener);
  });
});

// -- git branches (per-project, read-only) -----------------------------------
// Lists the claude/* branches Claude created for this project, their unpushed
// commits, and links each back to the request/response thread that made it.

// Link each branch back to the thread that created it (mutates info in place).
function attachThreads(project, info) {
  if (!info.branches || !info.branches.length) return info;
  const byBranch = new Map();
  for (const t of db.listThreads(project)) {
    if (t.branch && !byBranch.has(t.branch))
      byBranch.set(t.branch, { thread_id: t.id, title: t.title, status: t.status });
  }
  for (const b of info.branches) {
    const t = byBranch.get(b.name);
    if (t) Object.assign(b, t);
  }
  return info;
}

router.get("/git/branches", async (req, res) => {
  const project = String(req.query.project || "");
  if (!project) return res.status(400).json({ error: "project required" });
  res.json(attachThreads(project, await gitBranchInfo(project)));
});

// All mounted projects at once, so the dashboard can show unpushed work across
// every project (not just the open one). Each entry carries the same shape as
// /git/branches plus a project name and an unpushed total. Projects with no
// claude/* branches are dropped to keep the list focused on actual work.
router.get("/git/branches/all", async (req, res) => {
  let mounts = [];
  try {
    mounts = await listWorkspaceProjects();
  } catch {
    /* fall back to projects that have threads */
  }
  const names = new Set([...mounts, ...db.projectSummaries().map((s) => s.project)]);
  const infos = await Promise.all(
    [...names].map(async (project) => {
      const info = attachThreads(project, await gitBranchInfo(project));
      const unpushed_total = (info.branches || []).reduce((n, b) => n + (b.unpushed || 0), 0);
      return { project, unpushed_total, ...info };
    })
  );
  const projects = infos
    .filter((p) => p.is_repo && p.branches && p.branches.length)
    // Projects with unpushed work first, then most-recently-touched.
    .sort(
      (a, b) =>
        (b.unpushed_total > 0) - (a.unpushed_total > 0) ||
        (b.branches[0]?.last?.date || "").localeCompare(a.branches[0]?.last?.date || "") ||
        a.project.localeCompare(b.project)
    );
  res.json({ projects });
});

// Diff for a whole branch's unpushed range (?branch=) or a single commit
// (?commit=). Backs the panel's clickable diff sections.
router.get("/git/diff", async (req, res) => {
  const project = String(req.query.project || "");
  const branch = req.query.branch ? String(req.query.branch) : null;
  const commit = req.query.commit ? String(req.query.commit) : null;
  if (!project || (!branch && !commit))
    return res.status(400).json({ error: "project and branch|commit required" });
  res.json(await gitDiff(project, { branch, commit }));
});

// -- usage -------------------------------------------------------------------
router.get("/usage", (req, res) => res.json(usageWindows()));
router.get("/limits", (req, res) => res.json(latestLimits()));

// -- scheduled tasks ---------------------------------------------------------
router.get("/scheduled", (req, res) => res.json({ tasks: db.listScheduled() }));

router.post("/scheduled", (req, res) => {
  const { project, prompt, agents } = req.body || {};
  if (!project || !prompt || !prompt.trim())
    return res.status(400).json({ error: "project and prompt required" });
  const task = db.addScheduled(project, prompt.trim(), parseInt(agents, 10) || 1);
  res.json({ ok: true, task });
});

router.patch("/scheduled/:id", (req, res) => {
  const { prompt, agents, project } = req.body || {};
  const fields = {};
  if (prompt !== undefined) fields.prompt = String(prompt);
  if (project !== undefined) fields.project = String(project);
  if (agents !== undefined) fields.agents = Math.max(1, parseInt(agents, 10) || 1);
  if (!Object.keys(fields).length) return res.status(400).json({ error: "nothing to update" });
  db.updateScheduled(req.params.id, fields);
  res.json({ ok: true, task: db.getScheduled(req.params.id) });
});

router.delete("/scheduled/:id", (req, res) => {
  db.deleteScheduled(req.params.id);
  res.json({ ok: true });
});

router.post("/scheduled/reorder", (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids[] required" });
  db.reorderScheduled(ids);
  res.json({ ok: true });
});

// Run now — bypasses the window/idle/policy gates.
router.post("/scheduled/:id/run", (req, res) => {
  const task = db.getScheduled(req.params.id);
  if (!task) return res.status(404).json({ error: "no such task" });
  if (task.status === "running") return res.status(409).json({ error: "already running" });
  const { agents } = req.body || {};
  if (agents !== undefined) {
    task.agents = Math.max(1, parseInt(agents, 10) || 1);
    db.updateScheduled(task.id, { agents: task.agents });
  }
  const thread = dispatchScheduled(task);
  // An approval can decline to dispatch (its thread is busy or no longer
  // awaiting) — surface why instead of crashing on thread.id.
  if (!thread) {
    const fresh = db.getScheduled(task.id);
    return res
      .status(409)
      .json({ error: (fresh && fresh.error) || "not dispatchable right now — its thread is still running" });
  }
  res.json({ ok: true, thread_id: thread.id });
});

// -- scheduler config --------------------------------------------------------
router.get("/scheduler/config", (req, res) => {
  const cfg = schedulerConfig();
  res.json({ config: cfg, decision: policyDecision(cfg, latestLimits()) });
});
router.put("/scheduler/config", (req, res) => {
  const cfg = saveSchedulerConfig(req.body || {});
  res.json({ config: cfg, decision: policyDecision(cfg, latestLimits()) });
});

export default router;
