// Thin client for the docker-socket-proxy (tmt-ai-docker-proxy). It exposes
// CONTAINERS + EXEC + POST only, which is all we need: exec `claude` inside
// tmt-ai-code, inspect containers, and enumerate the /workspace/* mounts.
import http from "node:http";

const DOCKER_API = process.env.DOCKER_API || "http://tmt-ai-docker-proxy:2375";
export const CODE_CONTAINER = process.env.CODE_CONTAINER || "tmt-ai-code";
const OWN_COMPOSE_PROJECT = process.env.OWN_COMPOSE_PROJECT || "tmt-ai";
const EXEC_USER_FALLBACK = process.env.RUN_EXEC_USER_DEFAULT || "1000:1000";

const base = new URL(DOCKER_API);

function request(path, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path,
        method,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": data.length }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

export async function dockerJson(path, body) {
  const { status, body: raw } = await request(path, body ? { method: "POST", body } : {});
  if (status >= 400) throw new Error(`docker ${path} -> ${status}`);
  return raw.length ? JSON.parse(raw.toString("utf8")) : null;
}

// -- exec stream demux -------------------------------------------------------

// Docker multiplexes exec output into 8-byte-framed chunks when Tty:false:
// [stream_type(1), 0,0,0, size(4 BE)] + payload. type 1=stdout, 2=stderr.
function makeDemuxer(onStdoutLine, onStderr) {
  let acc = Buffer.alloc(0);
  let lineBuf = "";
  let framed = null; // null=unknown, true/false once decided
  const pushStdout = (s) => {
    lineBuf += s;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      onStdoutLine(line);
    }
  };
  return {
    feed(chunk) {
      acc = Buffer.concat([acc, chunk]);
      if (framed === null && acc.length >= 1) framed = acc[0] === 0 || acc[0] === 1 || acc[0] === 2;
      if (framed === false) {
        pushStdout(acc.toString("utf8"));
        acc = Buffer.alloc(0);
        return;
      }
      while (acc.length >= 8) {
        const type = acc[0];
        const size = acc.readUInt32BE(4);
        if (acc.length < 8 + size) break;
        const payload = acc.slice(8, 8 + size).toString("utf8");
        acc = acc.slice(8 + size);
        if (type === 2) onStderr(payload);
        else pushStdout(payload);
      }
    },
    flush() {
      if (lineBuf.trim()) onStdoutLine(lineBuf);
      lineBuf = "";
    },
  };
}

// Create an exec and stream its output live. onStdoutLine fires per stdout line
// (NDJSON). Resolves after the stream ends with {exitCode, stderr, note}.
export async function execStream(container, cmd, opts = {}) {
  const { workdir, user, onStdoutLine, deadlineMs = 3_600_000 } = opts;
  const payload = {
    AttachStdout: true,
    AttachStderr: true,
    Cmd: cmd,
  };
  if (workdir) payload.WorkingDir = workdir;
  if (user) payload.User = user;
  const created = await dockerJson(`/containers/${container}/exec`, payload);
  const execId = created.Id;

  let stderr = "";
  const demux = makeDemuxer(onStdoutLine || (() => {}), (s) => {
    stderr += s;
  });

  const note = await new Promise((resolve) => {
    const start = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `/exec/${execId}/start`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": start.length,
        },
      },
      (res) => {
        res.on("data", (c) => demux.feed(c));
        res.on("end", () => resolve(null));
        res.on("error", (e) => resolve(`stream error: ${e.message}`));
      }
    );
    const timer = setTimeout(() => {
      req.destroy();
      resolve(`stream timeout after ${deadlineMs}ms`);
    }, deadlineMs);
    req.on("error", (e) => {
      clearTimeout(timer);
      resolve(`attach lost: ${e.message}`);
    });
    req.on("close", () => clearTimeout(timer));
    req.write(start);
    req.end();
  });
  demux.flush();

  let exitCode = null;
  try {
    const info = await dockerJson(`/exec/${execId}/json`);
    exitCode = info ? info.ExitCode : null;
  } catch {
    /* ignore */
  }
  return { execId, exitCode, stderr, note };
}

// Run an exec and collect its full output (short-lived commands: cat, ls...).
export async function execCollect(container, cmd, opts = {}) {
  const lines = [];
  const { stderr, exitCode } = await execStream(container, cmd, {
    ...opts,
    onStdoutLine: (l) => lines.push(l),
    deadlineMs: opts.deadlineMs || 30_000,
  });
  return { stdout: lines.join("\n"), stderr, exitCode };
}

// -- exec user resolution ----------------------------------------------------

let _execUser = null;
export async function resolveExecUser() {
  if (_execUser) return _execUser;
  if (process.env.RUN_EXEC_USER) {
    _execUser = process.env.RUN_EXEC_USER;
    return _execUser;
  }
  try {
    const info = await dockerJson(`/containers/${CODE_CONTAINER}/json`);
    const config = info?.Config || {};
    const env = Object.fromEntries(
      (config.Env || []).filter((x) => x.includes("=")).map((x) => x.split(/=(.*)/s).slice(0, 2))
    );
    if (env.USER_UID) {
      _execUser = `${env.USER_UID}:${env.USER_GID || env.USER_UID}`;
      return _execUser;
    }
    if (config.User) {
      _execUser = config.User;
      return _execUser;
    }
  } catch (e) {
    console.error(`could not resolve ${CODE_CONTAINER} uid (${e.message})`);
  }
  return EXEC_USER_FALLBACK; // don't cache the fallback
}

// -- project enumeration + status --------------------------------------------

// Projects = every /workspace/<name> bind-mounted into tmt-ai-code. This is
// exactly what compose.override.yml maps, read from the live container.
export async function listWorkspaceProjects() {
  const info = await dockerJson(`/containers/${CODE_CONTAINER}/json`);
  const names = [];
  for (const m of info?.Mounts || []) {
    const dest = m.Destination || "";
    if (dest.startsWith("/workspace/")) {
      const name = dest.slice("/workspace/".length);
      if (name && !name.includes("/")) names.push(name);
    }
  }
  return [...new Set(names)].sort();
}

function composeProjectName(dir) {
  const bReplace = (dir || "").replace(/\/+$/, "").split("/").pop().toLowerCase();
  return bReplace.replace(/[^a-z0-9_-]/g, "");
}

export async function projectDockerStatus(project) {
  try {
    const code = await dockerJson(`/containers/${CODE_CONTAINER}/json`);
    let hostDir = null;
    for (const m of code?.Mounts || []) {
      if (m.Destination === `/workspace/${project}`) {
        hostDir = m.Source;
        break;
      }
    }
    const containers = (await dockerJson("/containers/json?all=1")) || [];
    const matches = [];
    for (const c of containers) {
      const labels = c.Labels || {};
      const composeProj = labels["com.docker.compose.project"] || "";
      if (composeProj === OWN_COMPOSE_PROJECT) continue;
      const workingDir = labels["com.docker.compose.project.working_dir"] || "";
      const name = (c.Names || ["/?"])[0].replace(/^\//, "");
      let matched = false;
      if (hostDir && workingDir && workingDir.startsWith(hostDir.replace(/\/+$/, "")))
        matched = true;
      else if (hostDir && composeProj === composeProjectName(hostDir)) matched = true;
      else if (name.toLowerCase().includes(project.toLowerCase())) matched = true;
      if (matched)
        matches.push({
          name,
          service: labels["com.docker.compose.service"] || null,
          compose_project: composeProj || null,
          image: c.Image,
          state: c.State,
          status: c.Status,
        });
    }
    matches.sort((a, b) =>
      a.state !== "running" && b.state === "running"
        ? 1
        : a.state === "running" && b.state !== "running"
          ? -1
          : a.name.localeCompare(b.name)
    );
    return { available: true, host_dir: hostDir, mounted: hostDir != null, containers: matches };
  } catch (e) {
    return { available: false, reason: e.message, containers: [] };
  }
}

// -- CLAUDE.md / context reading (cat inside tmt-ai-code) --------------------

const CONTEXT_FILES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".claude/CLAUDE.md",
  ".claude/settings.json",
  ".claude/settings.local.json",
];
const CONTEXT_MARKER = "-----TMT-AI-VIEWER2-FILE-----";

export async function projectContext(project) {
  const candidates = CONTEXT_FILES.map((f) => `"${f}"`).join(" ");
  const script =
    `cd "/workspace/${project}" 2>/dev/null || exit 3; ` +
    `for f in ${candidates} .claude/rules/*.md .claude/agents/*.md; do ` +
    `[ -f "$f" ] && { echo "${CONTEXT_MARKER}$f"; cat "$f"; echo; }; ` +
    `done; true`;
  try {
    const { stdout, stderr } = await execCollect(CODE_CONTAINER, ["sh", "-c", script]);
    const files = [];
    for (const section of stdout.split(CONTEXT_MARKER)) {
      if (!section.trim()) continue;
      const nl = section.indexOf("\n");
      if (nl === -1) continue;
      files.push({ path: section.slice(0, nl).trim(), content: section.slice(nl + 1) });
    }
    return { available: true, files, stderr: stderr.trim() || null };
  } catch (e) {
    return { available: false, reason: e.message, files: [] };
  }
}
