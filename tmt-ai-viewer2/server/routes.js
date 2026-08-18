import { Router } from "express";
import * as db from "./db.js";
import * as auth from "./auth.js";
import { bus, startRun, wrapPrompt } from "./claude.js";
import { usageWindows } from "./usage.js";
import { listNotes, addNote, updateNote } from "./projects.js";
import {
  listWorkspaceProjects,
  projectDockerStatus,
  projectContext,
} from "./docker.js";

const router = Router();

const squash = (s, n = 80) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

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

router.post("/threads", (req, res) => {
  const { project, prompt } = req.body || {};
  if (!project || !prompt || !prompt.trim())
    return res.status(400).json({ error: "project and prompt required" });
  const thread = db.createThread(project, squash(prompt));
  const sent = wrapPrompt(prompt, "new");
  const turn = db.addTurn(thread.id, prompt, sent, null);
  startRun(thread, turn, "new");
  res.json({ thread_id: thread.id });
});

router.post("/thread/followup", (req, res) => {
  const { id, prompt } = req.body || {};
  const thread = db.getThread(id);
  if (!thread) return res.status(404).json({ error: "no such thread" });
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: "prompt required" });
  const sent = wrapPrompt(prompt, "resume");
  const turn = db.addTurn(thread.id, prompt, sent, null);
  db.setThreadStatus(thread.id, "running");
  startRun(thread, turn, "resume");
  res.json({ ok: true, turn_id: turn.id });
});

router.get("/thread", (req, res) => {
  const thread = db.getThread(String(req.query.id || ""));
  if (!thread) return res.status(404).json({ error: "no such thread" });
  db.markThreadRead(thread.id);
  res.json({
    thread,
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

// -- usage -------------------------------------------------------------------
router.get("/usage", (req, res) => res.json(usageWindows()));

export default router;
