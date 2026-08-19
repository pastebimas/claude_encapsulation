// Public task-dispatch API. A separate Express app on its own port so it can be
// exposed independently of the password-gated dashboard: an external tracker
// POSTs a task, we validate the project is mounted here, create a git branch
// from the task id+name, and start a plan-mode Claude run scoped to it. The run
// parks awaiting approval in the dashboard; on approval it implements + commits
// to that branch.
//
// Exposure: the host publishes this port on 127.0.0.1 only (see compose.yml).
// Put your own TLS tunnel / reverse proxy in front and set TASK_API_TRUST_PROXY=1
// so the IP allowlist matches the real client from X-Forwarded-For.
import express from "express";
import crypto from "node:crypto";
import * as db from "./db.js";
import { startRun, wrapPrompt, buildTaskPrompt } from "./claude.js";
import {
  CODE_CONTAINER,
  execCollect,
  resolveExecUser,
  listWorkspaceProjects,
} from "./docker.js";

const PORT = parseInt(process.env.TASK_API_PORT || "8036", 10);
const TOKEN = process.env.TASK_API_TOKEN || "";
const TRUST_PROXY = (process.env.TASK_API_TRUST_PROXY || "") === "1";
const ALLOWLIST = parseAllowlist(process.env.TASK_API_IP_ALLOWLIST || "");
const GIT_NAME = process.env.TASK_GIT_NAME || "tmt-ai";
const GIT_EMAIL = process.env.TASK_GIT_EMAIL || "tmt-ai@localhost";
const DASHBOARD_URL = (process.env.DASHBOARD_URL || "").replace(/\/+$/, "");
const ONE_AT_A_TIME = (process.env.TASK_API_ONE_AT_A_TIME || "") === "1";
const MAX_ATTEMPTS = parseInt(process.env.TASK_API_MAX_ATTEMPTS || "10", 10);
const LOCKOUT_SECONDS = parseInt(process.env.TASK_API_LOCKOUT_SECONDS || "300", 10);

// -- ip / token helpers ------------------------------------------------------

function parseAllowlist(raw) {
  const out = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    if (s.includes("/") && s.includes(".")) {
      const [ip, bitsRaw] = s.split("/");
      const bits = parseInt(bitsRaw, 10);
      const long = ipv4ToLong(ip);
      if (long != null && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        out.push({ kind: "cidr", net: (long & mask) >>> 0, mask });
        continue;
      }
    }
    out.push({ kind: "exact", value: s });
  }
  return out;
}

function ipv4ToLong(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || "");
  if (!m) return null;
  let long = 0;
  for (let i = 1; i <= 4; i++) {
    const o = parseInt(m[i], 10);
    if (o > 255) return null;
    long = (long << 8) | o;
  }
  return long >>> 0;
}

// Strip IPv4-mapped IPv6 prefix so ::ffff:1.2.3.4 matches an IPv4 rule.
function normalizeIp(ip) {
  if (!ip) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xff) return normalizeIp(xff);
  }
  return normalizeIp(req.socket.remoteAddress || "");
}

function ipAllowed(ip) {
  if (!ALLOWLIST.length) return true; // no allowlist configured → token-only
  const long = ipv4ToLong(ip);
  for (const rule of ALLOWLIST) {
    if (rule.kind === "exact" && rule.value === ip) return true;
    if (rule.kind === "cidr" && long != null && ((long & rule.mask) >>> 0) === rule.net)
      return true;
  }
  return false;
}

function bearer(req) {
  const h = String(req.headers["authorization"] || "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  const alt = req.headers["x-api-token"];
  return alt ? String(alt).trim() : "";
}

function tokenOk(provided) {
  const a = Buffer.from(provided || "", "utf8");
  const b = Buffer.from(TOKEN, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Per-IP lockout on repeated bad tokens (mirrors auth.js).
const attempts = new Map(); // ip -> { count, lockedUntil }

function auth(req, res, next) {
  const ip = clientIp(req);
  const entry = attempts.get(ip);
  if (entry && entry.lockedUntil > Date.now()) {
    return res
      .status(429)
      .json({ error: "locked", retry_in: Math.ceil((entry.lockedUntil - Date.now()) / 1000) });
  }
  if (!ipAllowed(ip)) return res.status(403).json({ error: "forbidden_ip" });
  if (tokenOk(bearer(req))) {
    attempts.delete(ip);
    return next();
  }
  const e = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  e.count++;
  if (e.count >= MAX_ATTEMPTS) {
    e.count = 0;
    e.lockedUntil = Date.now() + LOCKOUT_SECONDS * 1000;
    attempts.set(ip, e);
    return res.status(429).json({ error: "locked", retry_in: LOCKOUT_SECONDS });
  }
  attempts.set(ip, e);
  return res.status(401).json({ error: "unauthorized" });
}

// -- branch naming -----------------------------------------------------------

function slug(s, max = 60) {
  const out = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, max)
    .replace(/[-._]+$/g, "");
  return out || "x";
}

// -- git (inside tmt-ai-code) ------------------------------------------------

function git(project, args, user) {
  return execCollect(CODE_CONTAINER, ["git", "-C", `/workspace/${project}`, ...args], {
    user,
    deadlineMs: 30_000,
  });
}

// Confirm repo, set a local bot identity if none (needed for the later commit),
// then create/switch to the branch. Returns { ok, error } — never throws.
async function prepareBranch(project, branch, user) {
  try {
    const repo = await git(project, ["rev-parse", "--is-inside-work-tree"], user);
    if (repo.exitCode !== 0 || repo.stdout.trim() !== "true")
      return { ok: false, code: 422, error: "not_a_git_repo" };

    const email = (await git(project, ["config", "--get", "user.email"], user)).stdout.trim();
    if (!email) await git(project, ["config", "user.email", GIT_EMAIL], user);
    const name = (await git(project, ["config", "--get", "user.name"], user)).stdout.trim();
    if (!name) await git(project, ["config", "user.name", GIT_NAME], user);

    const exists =
      (await git(project, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], user))
        .exitCode === 0;
    const co = await git(project, exists ? ["checkout", branch] : ["checkout", "-b", branch], user);
    if (co.exitCode !== 0)
      return { ok: false, code: 500, error: "branch_failed", detail: (co.stderr || "").trim() };
    return { ok: true, reused: exists };
  } catch (e) {
    return { ok: false, code: 500, error: "git_error", detail: e.message };
  }
}

// -- status projection -------------------------------------------------------

function mapStatus(thread) {
  if (!thread) return "unknown";
  if (thread.status === "awaiting") return "awaiting_approval";
  if (thread.status === "running") return thread.plan_mode ? "planning" : "working";
  return thread.status; // done | error | stopped | stale | idle
}

function threadView(thread) {
  const view = {
    thread_id: thread.id,
    project: thread.project,
    branch: thread.branch || null,
    status: mapStatus(thread),
  };
  if (DASHBOARD_URL) view.dashboard_url = DASHBOARD_URL;
  if (thread.status === "awaiting" && thread.awaiting_json) {
    try {
      view.awaiting = JSON.parse(thread.awaiting_json);
    } catch {
      /* ignore malformed */
    }
  }
  return view;
}

// -- routes ------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use(auth);

  app.get("/health", (req, res) => res.json({ ok: true }));

  app.post("/task", async (req, res) => {
    const body = req.body || {};
    const project = str(body.project);
    const id = str(body.id);
    const name = str(body.name);
    const description = typeof body.description === "string" ? body.description : "";
    const comments = Array.isArray(body.comments) ? body.comments : undefined;

    if (!project || !id || !name)
      return res.status(400).json({ error: "project, id and name are required" });

    let projects;
    try {
      projects = await listWorkspaceProjects();
    } catch (e) {
      return res.status(502).json({ error: "project_lookup_failed", detail: e.message });
    }
    if (!projects.includes(project))
      return res.status(404).json({ error: "project_not_found", project, available: projects });

    // Idempotent: a retried webhook returns the existing thread, no new branch.
    const existing = db.findThreadByExtTask(project, id);
    if (existing)
      return res.status(200).json({ ok: true, dedup: true, ...threadView(existing) });

    if (ONE_AT_A_TIME) {
      const busy = db
        .listThreads(project)
        .some((t) => t.status === "running" || t.status === "awaiting");
      if (busy) return res.status(409).json({ error: "project_busy" });
    }

    const branch = `task/${slug(id, 40)}-${slug(name, 60)}`;
    const user = await resolveExecUser();
    const prep = await prepareBranch(project, branch, user);
    if (!prep.ok)
      return res.status(prep.code).json({ error: prep.error, detail: prep.detail, branch });

    const raw = buildTaskPrompt({ id, name, description, comments, branch });
    const thread = db.createTaskThread(project, `[${id}] ${name}`.slice(0, 80), {
      branch,
      ext_task_id: id,
      ext_task_source: str(body.source) || "api",
    });
    const turn = db.addTurn(thread.id, raw, wrapPrompt(raw, "new"), null);
    startRun(thread, turn, "new");

    return res.status(201).json({ ok: true, ...threadView(db.getThread(thread.id)) });
  });

  app.get("/task/:id", (req, res) => {
    const project = str(req.query.project);
    if (!project) return res.status(400).json({ error: "project query param required" });
    const thread = db.findThreadByExtTask(project, str(req.params.id));
    if (!thread) return res.status(404).json({ error: "task_not_found" });
    return res.json(threadView(thread));
  });

  // JSON error handler (e.g. malformed body) instead of Express' HTML default.
  app.use((err, req, res, _next) => {
    res.status(400).json({ error: "bad_request", detail: err.message });
  });

  return app;
}

const str = (v) => (v == null ? "" : String(v).trim());

// Start the listener. Fail closed: without a token the public API stays off.
export function startTaskApi() {
  if (!TOKEN) {
    console.warn("task-api: TASK_API_TOKEN unset — task-dispatch API disabled");
    return null;
  }
  const app = buildApp();
  return app.listen(PORT, "0.0.0.0", () =>
    console.log(
      `task-api on :${PORT} (allowlist: ${ALLOWLIST.length || "off"}, trust_proxy: ${TRUST_PROXY})`
    )
  );
}
