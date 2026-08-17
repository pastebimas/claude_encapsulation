"use strict";

const $ = (sel) => document.querySelector(sel);

const state = {
  projects: [],
  project: null,
  filters: { q: "", model: "", status: "", unread: false },
  groupBySession: true,
  requests: [],
  total: 0,
  offset: 0,
  limit: 50,
  selectedId: null,
  detail: null,
  detailTab: "summary",
  notes: [],
  noteId: null,
  noteEdit: false,
  runs: [],
  expandedSessions: new Set(),
  sessionMembers: {},
};

// ---- api helpers ----------------------------------------------------------

async function api(path, opts) {
  const resp = await fetch(path, opts);
  if (resp.status === 401) {
    location.reload();
    return new Promise(() => {});
  }
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || resp.statusText);
  return data;
}

const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ---- utils ----------------------------------------------------------------

function esc(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function fmtTime(ts) {
  if (!ts) return "";
  const date = new Date(ts.endsWith("Z") ? ts : ts + "Z");
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleString();
}

function fullTime(ts) {
  if (!ts) return "";
  return new Date(ts.endsWith("Z") ? ts : ts + "Z").toLocaleString();
}

function shortModel(model) {
  return (model || "").replace(/^claude-/, "");
}

function fmtTokens(n) {
  if (n == null) return null;
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

// ---- projects sidebar -----------------------------------------------------

async function loadProjects() {
  try {
    const data = await api("/api/projects");
    state.projects = data.projects;
    renderProjects();
  } catch (e) {
    console.error("loadProjects", e);
  }
}

function renderProjects() {
  const nav = $("#project-list");
  nav.innerHTML = "";
  const running = {};
  for (const r of state.runs)
    if (r.status === "running") running[r.project] = (running[r.project] || 0) + 1;
  for (const proj of state.projects) {
    const btn = document.createElement("button");
    btn.className = "project-item" + (proj.name === state.project ? " active" : "");
    btn.innerHTML = `
      <span class="name">${esc(proj.name)}</span>
      ${running[proj.name] ? `<span class="run-badge" title="active runs">▶${running[proj.name]}</span>` : ""}
      ${proj.unread ? `<span class="badge">${proj.unread}</span>` : ""}
      <span class="total">${proj.total}</span>`;
    btn.title = `last activity: ${fullTime(proj.last_ts)}`;
    btn.onclick = () => selectProject(proj.name);
    nav.appendChild(btn);
  }
}

// ---- project selection ----------------------------------------------------

async function selectProject(name) {
  state.project = name;
  state.offset = 0;
  state.selectedId = null;
  state.detail = null;
  state.noteId = null;
  state.noteEdit = false;
  state.expandedSessions = new Set();
  state.sessionMembers = {};
  $("#empty-state").hidden = true;
  $("#project-view").hidden = false;
  $("#project-title").textContent = name;
  $("#detail").hidden = true;
  $("#detail-empty").hidden = false;
  closePanels();
  renderProjects();
  renderRunsStrip();
  await Promise.all([loadRequests(false), loadStatus(), loadNotes()]);
}

// ---- docker status --------------------------------------------------------

async function loadStatus() {
  const el = $("#status-chips");
  el.innerHTML = `<span class="chip"><span class="dot"></span>checking…</span>`;
  try {
    const st = await api(`/api/project_status?project=${encodeURIComponent(state.project)}`);
    if (!st.available) {
      el.innerHTML = `<span class="chip" title="${esc(st.reason)}"><span class="dot"></span>docker unavailable</span>`;
      return;
    }
    if (!st.containers.length) {
      const hint = st.mounted ? "no containers found for this project" : "project not mounted in tmt-ai-code";
      el.innerHTML = `<span class="chip"><span class="dot"></span>${esc(hint)}</span>`;
      return;
    }
    el.innerHTML = st.containers
      .map(
        (c) => `
        <span class="chip ${esc(c.state)}" title="${esc(c.image)} — ${esc(c.status)}">
          <span class="dot"></span>${esc(c.service || c.name)}
        </span>`
      )
      .join("");
  } catch (e) {
    el.innerHTML = `<span class="chip" title="${esc(e.message)}"><span class="dot"></span>status error</span>`;
  }
}

// ---- request list ---------------------------------------------------------

function filterParams() {
  const p = new URLSearchParams({ project: state.project, limit: state.limit, offset: state.offset });
  const f = state.filters;
  if (f.q) p.set("q", f.q);
  if (f.model) p.set("model", f.model);
  if (f.status) p.set("status", f.status);
  if (f.unread) p.set("unread", "1");
  if (state.groupBySession) p.set("view", "sessions");
  return p;
}

async function loadRequests(append) {
  if (!append) {
    state.offset = 0;
    state.sessionMembers = {};
  }
  try {
    const data = await api(`/api/requests?${filterParams()}`);
    state.total = data.total;
    state.requests = append ? state.requests.concat(data.requests) : data.requests;
    renderModelOptions(data.models);
    renderRequestList();
  } catch (e) {
    console.error("loadRequests", e);
  }
}

function renderModelOptions(models) {
  const sel = $("#f-model");
  const current = sel.value;
  sel.innerHTML =
    `<option value="">All models</option>` +
    models.map((m) => `<option value="${esc(m)}">${esc(shortModel(m))}</option>`).join("");
  sel.value = current;
}

function renderRequestList() {
  const list = $("#request-list");
  list.innerHTML = "";
  const noun = state.groupBySession ? "session" : "request";
  $("#result-count").textContent = `${state.total} ${noun}${state.total === 1 ? "" : "s"}`;
  for (const req of state.requests) {
    list.appendChild(requestItem(req));
    if (
      state.groupBySession &&
      req.session_id &&
      state.expandedSessions.has(req.session_id)
    ) {
      const holder = document.createElement("div");
      holder.className = "session-members";
      const members = state.sessionMembers[req.session_id];
      if (!members) holder.innerHTML = `<div class="sm-loading">loading…</div>`;
      else for (const m of members) holder.appendChild(requestItem(m, true));
      list.appendChild(holder);
    }
  }
  $("#btn-more").hidden = state.requests.length >= state.total;
}

async function toggleSession(sid) {
  if (state.expandedSessions.has(sid)) {
    state.expandedSessions.delete(sid);
    renderRequestList();
    return;
  }
  state.expandedSessions.add(sid);
  renderRequestList();
  if (!state.sessionMembers[sid]) {
    try {
      const data = await api(
        `/api/requests?project=${encodeURIComponent(state.project)}&session_id=${encodeURIComponent(sid)}&limit=200`
      );
      state.sessionMembers[sid] = data.requests;
    } catch (e) {
      console.error("toggleSession", e);
      state.sessionMembers[sid] = [];
    }
    renderRequestList();
  }
}

function requestItem(req, isMember) {
  const div = document.createElement("div");
  const unread = isMember
    ? !req.read_at
    : !req.read_at || (req.session_unread || 0) > 0;
  div.className =
    "req-item" +
    (isMember ? " member" : "") +
    (unread ? " unread" : "") +
    (req.id === state.selectedId ? " active" : "");
  div.dataset.id = req.id;
  const ok = req.response_status >= 200 && req.response_status < 300;
  const tokens = [fmtTokens(req.input_tokens), fmtTokens(req.output_tokens)]
    .filter(Boolean)
    .join("→");
  const grouped =
    !isMember && state.groupBySession && req.session_id && (req.session_count || 0) > 1;
  div.innerHTML = `
    <div class="row1">
      <span title="${esc(fullTime(req.timestamp))}">${esc(fmtTime(req.timestamp))}</span>
      <span class="model">${esc(shortModel(req.model) || req.path)}</span>
      <span class="${ok ? "status-ok" : "status-err"}">${req.response_status ?? "?"}</span>
      ${tokens ? `<span>${esc(tokens)}</span>` : ""}
      <span>${req.duration_ms != null ? req.duration_ms + "ms" : ""}</span>
      ${grouped ? `<button class="r-expand" title="show the session's ${req.session_count} requests">${state.expandedSessions.has(req.session_id) ? "▾" : "▸"} ×${req.session_count}</button>` : ""}
    </div>
    ${req.request_snippet ? `<div class="snippet">${esc(req.request_snippet)}</div>` : ""}
    ${req.response_snippet ? `<div class="snippet resp">${esc(req.response_snippet)}</div>` : ""}
    <button class="r-del" title="delete">✕</button>`;
  div.onclick = () => openDetail(req.id, req);
  const exp = div.querySelector(".r-expand");
  if (exp)
    exp.onclick = (e) => {
      e.stopPropagation();
      toggleSession(req.session_id);
    };
  div.querySelector(".r-del").onclick = (e) => {
    e.stopPropagation();
    deleteRequest(req.id);
  };
  return div;
}

// ---- detail ---------------------------------------------------------------

async function openDetail(id, listRow) {
  state.selectedId = id;
  try {
    state.detail = await api(
      `/api/request?project=${encodeURIComponent(state.project)}&id=${id}`
    );
  } catch (e) {
    console.error("openDetail", e);
    return;
  }
  $("#detail-empty").hidden = true;
  $("#detail").hidden = false;
  renderDetail();
  renderRequestList();
  const sid = listRow && listRow.session_id;
  if (sid && (listRow.session_count || 0) > 1) {
    if ((listRow.session_unread || 0) > 0 || !state.detail.read_at)
      await markSessionRead(sid, listRow);
  } else if (!state.detail.read_at) {
    await setRead([id], true, { keepSelection: true });
  }
}

async function markSessionRead(sid, listRow) {
  try {
    await post("/api/mark", { project: state.project, session_id: sid, read: true });
  } catch (e) {
    console.error("markSessionRead", e);
    return;
  }
  const now = new Date().toISOString();
  if (listRow) {
    listRow.session_unread = 0;
    listRow.read_at = listRow.read_at || now;
  }
  for (const m of state.sessionMembers[sid] || []) m.read_at = m.read_at || now;
  if (state.detail && state.detail.session_id === sid) {
    state.detail.read_at = state.detail.read_at || now;
    $("#btn-toggle-read").textContent = "Mark unread";
  }
  renderRequestList();
  loadProjects();
}

function metaChip(label, value) {
  return value == null || value === ""
    ? ""
    : `<span class="chip">${esc(label)}: ${esc(value)}</span>`;
}

function parseJSON(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function renderDetail() {
  const det = state.detail;
  const req = parseJSON(det.request_body) || {};
  const resp = parseJSON(det.response_body);
  const usage = (resp && resp.usage) || {};

  $("#detail-meta").innerHTML = [
    metaChip("id", det.id),
    metaChip("time", fullTime(det.timestamp)),
    metaChip("model", shortModel(req.model)),
    metaChip("status", det.response_status),
    metaChip("duration", det.duration_ms != null ? det.duration_ms + "ms" : null),
    metaChip("stop", resp && resp.stop_reason),
    metaChip("in", fmtTokens(usage.input_tokens)),
    metaChip("out", fmtTokens(usage.output_tokens)),
    metaChip("cache read", fmtTokens(usage.cache_read_input_tokens)),
    metaChip("session", det.session_id ? det.session_id.slice(0, 8) : null),
  ].join("");

  $("#btn-toggle-read").textContent = det.read_at ? "Mark unread" : "Mark read";
  $("#followup-hint").textContent = det.session_id
    ? `resumes session ${det.session_id.slice(0, 8)}…`
    : "no session id — continues the project's most recent conversation";
  renderDetailBody();
}

function renderDetailBody() {
  const body = $("#detail-body");
  const det = state.detail;
  document
    .querySelectorAll("#detail-tabs .tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === state.detailTab));

  if (state.detailTab === "summary") {
    body.innerHTML = renderSummary();
  } else if (state.detailTab === "request") {
    body.innerHTML = `<pre class="raw">${esc(prettyJSON(det.request_body))}</pre>`;
  } else if (state.detailTab === "response") {
    body.innerHTML = `<pre class="raw">${esc(prettyJSON(det.response_body))}</pre>`;
  } else if (state.detailTab === "headers") {
    body.innerHTML =
      `<h4>Request headers</h4><pre class="raw">${esc(prettyJSON(det.request_headers))}</pre>` +
      `<h4>Response headers</h4><pre class="raw">${esc(prettyJSON(det.response_headers))}</pre>`;
  } else {
    body.innerHTML = renderConversation();
  }
  body.scrollTop = 0;
}

function prettyJSON(text) {
  const parsed = parseJSON(text);
  return parsed == null ? text || "" : JSON.stringify(parsed, null, 2);
}

function contentBlocks(content) {
  if (content == null) return "";
  if (typeof content === "string") return `<div class="txt">${esc(content)}</div>`;
  if (!Array.isArray(content)) return `<pre>${esc(JSON.stringify(content, null, 2))}</pre>`;
  return content
    .map((block) => {
      if (typeof block === "string") return `<div class="txt">${esc(block)}</div>`;
      switch (block.type) {
        case "text":
          return `<div class="txt">${esc(block.text)}</div>`;
        case "thinking":
          return `<details><summary>💭 thinking</summary><pre>${esc(block.thinking)}</pre></details>`;
        case "tool_use":
          return `<details><summary>🔧 tool_use: <b>${esc(block.name)}</b></summary><pre>${esc(
            JSON.stringify(block.input, null, 2)
          )}</pre></details>`;
        case "tool_result": {
          const inner =
            typeof block.content === "string"
              ? block.content
              : (block.content || [])
                  .map((c) => (c && c.type === "text" ? c.text : `[${(c || {}).type}]`))
                  .join("\n");
          return `<details><summary>📄 tool_result${block.is_error ? " (error)" : ""}</summary><pre>${esc(
            inner
          )}</pre></details>`;
        }
        case "image":
          return `<div class="txt">[image]</div>`;
        default:
          return `<details><summary>${esc(block.type || "block")}</summary><pre>${esc(
            JSON.stringify(block, null, 2)
          )}</pre></details>`;
      }
    })
    .join("");
}

function stripReminders(text) {
  return (text || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

function messageText(content) {
  if (typeof content === "string") return stripReminders(content);
  if (!Array.isArray(content)) return "";
  return stripReminders(
    content
      .filter((b) => b && b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n\n")
  );
}

function renderSummary() {
  const det = state.detail;
  const req = parseJSON(det.request_body) || {};
  const resp = parseJSON(det.response_body);

  let asked = "";
  const messages = Array.isArray(req.messages) ? req.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") {
      asked = messageText(messages[i].content);
      if (asked) break;
    }
  }

  let html = `<div class="msg user">
    <div class="role">asked</div>
    <div class="body"><div class="txt">${esc(asked || "(no user text in this request — tool results only)")}</div></div>
  </div>`;

  if (resp && resp.type === "error") {
    const err = resp.error || {};
    html += `<div class="msg response"><div class="role">result — error</div>
      <div class="body"><div class="txt">${esc(err.type)}: ${esc(err.message)}</div></div></div>`;
  } else if (resp) {
    const blocks = Array.isArray(resp.content) ? resp.content : [];
    const text = blocks
      .filter((b) => b && b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    const tools = blocks.filter((b) => b && b.type === "tool_use").map((b) => b.name);
    const fallback = tools.length
      ? `(no text — assistant ran tools: ${tools.join(", ")})`
      : "(no text in response)";
    html += `<div class="msg assistant response">
      <div class="role">result${resp.stop_reason ? " — " + esc(resp.stop_reason) : ""}</div>
      <div class="body"><div class="txt">${esc(text || fallback)}</div></div>
    </div>`;
  } else if (det.response_body) {
    html += `<div class="msg response"><div class="role">result (raw)</div>
      <div class="body"><pre>${esc(det.response_body.slice(0, 20000))}</pre></div></div>`;
  }
  return html;
}

function renderConversation() {
  const det = state.detail;
  const req = parseJSON(det.request_body);
  const resp = parseJSON(det.response_body);
  if (!req) return `<pre class="raw">${esc(det.request_body || "(empty)")}</pre>`;

  let html = "";

  const system = req.system;
  if (system) {
    const text = Array.isArray(system)
      ? system.map((b) => (b && b.text) || "").join("\n\n")
      : String(system);
    html += `<div class="sys"><details><summary>⚙️ system prompt (${text.length.toLocaleString()} chars)</summary><pre>${esc(
      text
    )}</pre></details></div>`;
  }

  for (const msg of req.messages || []) {
    html += `<div class="msg ${esc(msg.role)}">
      <div class="role">${esc(msg.role)}</div>
      <div class="body">${contentBlocks(msg.content)}</div>
    </div>`;
  }

  if (resp) {
    if (resp.type === "error") {
      const err = resp.error || {};
      html += `<div class="msg response"><div class="role">response — error</div>
        <div class="body"><div class="txt">${esc(err.type)}: ${esc(err.message)}</div></div></div>`;
    } else {
      const usage = resp.usage || {};
      html += `<div class="msg assistant response">
        <div class="role">response${resp.stop_reason ? " — " + esc(resp.stop_reason) : ""}</div>
        <div class="body">${contentBlocks(resp.content)}
          <div class="usage-line">tokens: in ${usage.input_tokens ?? "?"} / out ${usage.output_tokens ?? "?"}${
            usage.cache_read_input_tokens ? ` / cache read ${usage.cache_read_input_tokens}` : ""
          }</div>
        </div></div>`;
    }
  } else if (det.response_body) {
    html += `<div class="msg response"><div class="role">response (raw)</div>
      <div class="body"><pre>${esc(det.response_body.slice(0, 20000))}</pre></div></div>`;
  }

  return html || '<div class="txt">(empty request)</div>';
}

// ---- read / delete actions ------------------------------------------------

async function setRead(ids, read, { keepSelection = false } = {}) {
  try {
    await post("/api/mark", { project: state.project, ids, read });
  } catch (e) {
    console.error("setRead", e);
    return;
  }
  const now = new Date().toISOString();
  for (const req of state.requests) if (ids.includes(req.id)) req.read_at = read ? now : null;
  if (state.detail && ids.includes(state.detail.id)) {
    state.detail.read_at = read ? now : null;
    $("#btn-toggle-read").textContent = read ? "Mark unread" : "Mark read";
  }
  if (!keepSelection && state.filters.unread) await loadRequests(false);
  else renderRequestList();
  loadProjects();
}

async function deleteRequest(id) {
  if (!confirm(`Permanently delete request #${id} from ${state.project}.db?`)) return;
  try {
    await post("/api/delete", { project: state.project, ids: [id] });
  } catch (e) {
    alert("Delete failed: " + e.message);
    return;
  }
  state.requests = state.requests.filter((r) => r.id !== id);
  state.total -= 1;
  if (state.selectedId === id) {
    state.detail = null;
    state.selectedId = null;
    $("#detail").hidden = true;
    $("#detail-empty").hidden = false;
  }
  renderRequestList();
  loadProjects();
}

// ---- notes panel -----------------------------------------------------------

const CHECK_RE = /^(\s*)- \[( |~|x)\] (.*)$/;
const MARK_CYCLE = { " ": "~", "~": "x", x: " " };
const MARK_ICON = { " ": "", "~": "◐", x: "✓" };

function currentNote() {
  return state.notes.find((n) => n.id === state.noteId) || null;
}

async function loadNotes() {
  if (!state.project) return;
  try {
    const data = await api(`/api/notes?project=${encodeURIComponent(state.project)}`);
    state.notes = data.notes || [];
    $("#notes-status").textContent = "";
  } catch (e) {
    state.notes = [];
    $("#notes-status").textContent = "error: " + e.message;
  }
  renderNoteList();
  renderNoteDetail();
}

async function openNotes() {
  closePanels();
  $("#notes-panel").hidden = false;
  $("#notes-title").textContent = `Notes — ${state.project}`;
  await loadNotes();
  if (state.noteId && !currentNote()) state.noteId = null;
  renderNoteList();
  renderNoteDetail();
}

function noteLabel(note) {
  if (note.title) return note.title;
  const first = (note.body || "").split("\n").find((l) => l.trim());
  return first ? first.trim() : "(empty note)";
}

function noteProgress(note) {
  let open = 0, done = 0;
  for (const line of (note.body || "").split("\n")) {
    const m = line.match(CHECK_RE);
    if (!m) continue;
    if (m[2] === "x") done++;
    else open++;
  }
  return { open, done };
}

function renderNoteList() {
  const ul = $("#notes-list");
  ul.innerHTML = "";
  for (const note of state.notes) {
    const li = document.createElement("li");
    li.className = "note-item" + (note.id === state.noteId ? " active" : "");
    const p = noteProgress(note);
    li.innerHTML = `
      <span class="n-title">${esc(noteLabel(note))}</span>
      ${note.origin === "agent" ? `<span class="t-origin" title="saved from an agent run's NOTES: section">agent</span>` : ""}
      ${p.open + p.done ? `<span class="n-progress" title="done / total checklist items">${p.done}/${p.open + p.done}</span>` : ""}
      <span class="n-when" title="${esc(fullTime(note.updated_at))}">${esc(fmtTime(note.updated_at))}</span>`;
    li.onclick = () => {
      state.noteId = note.id;
      state.noteEdit = false;
      renderNoteList();
      renderNoteDetail();
    };
    ul.appendChild(li);
  }
}

async function noteUpdate(id, fields) {
  try {
    await post("/api/note_update", { project: state.project, id, ...fields });
  } catch (e) {
    $("#notes-status").textContent = "save failed: " + e.message;
  }
  await loadNotes();
}

function runLine(note, text) {
  const prompt = (note.title ? note.title + ": " : "") + text;
  return post("/api/run", { project: state.project, prompt })
    .then(pollRuns)
    .catch((e) => {
      $("#notes-status").textContent = "run failed: " + e.message;
    });
}

function renderNoteDetail() {
  const note = currentNote();
  $("#note-detail-empty").hidden = !!note;
  $("#note-detail").hidden = !note;
  if (!note) return;

  const title = $("#note-title");
  title.value = note.title || "";
  title.onchange = () => noteUpdate(note.id, { title: title.value });

  const lines = (note.body || "").split("\n");
  const openLines = lines.filter((l) => {
    const m = l.match(CHECK_RE);
    return m && m[2] !== "x";
  });
  const runAll = $("#note-run-all");
  runAll.hidden = openLines.length === 0;
  runAll.textContent = `▶ Run all open (${openLines.length})`;
  runAll.onclick = () => {
    for (const l of openLines) runLine(note, l.match(CHECK_RE)[3]);
  };

  $("#note-edit").textContent = state.noteEdit ? "👁 View" : "✎ Edit";
  const ta = $("#note-body");
  const view = $("#note-body-view");
  ta.hidden = !state.noteEdit;
  view.hidden = state.noteEdit;
  $("#note-meta").textContent =
    `${note.origin} · created ${fmtTime(note.created_at)} · updated ${fmtTime(note.updated_at)}`;

  if (state.noteEdit) {
    ta.value = note.body || "";
    ta.onchange = () => noteUpdate(note.id, { body: ta.value });
    return;
  }

  view.innerHTML = "";
  lines.forEach((line, idx) => {
    const m = line.match(CHECK_RE);
    const div = document.createElement("div");
    if (!m) {
      div.className = "n-line";
      div.textContent = line;
      view.appendChild(div);
      return;
    }
    const mark = m[2];
    div.className =
      "n-check" + (mark === "x" ? " done" : mark === "~" ? " doing" : "");
    div.innerHTML = `
      <button class="n-mark" title="todo → in progress → done">${MARK_ICON[mark] || ""}</button>
      <span class="n-text">${esc(m[3])}</span>
      ${mark === "x" ? "" : `<button class="n-run" title="run this line as its own claude session">▶</button>`}`;
    div.querySelector(".n-mark").onclick = () => {
      const next = lines.slice();
      next[idx] = `${m[1]}- [${MARK_CYCLE[mark]}] ${m[3]}`;
      noteUpdate(note.id, { body: next.join("\n") });
    };
    const run = div.querySelector(".n-run");
    if (run) run.onclick = () => runLine(note, m[3]);
    view.appendChild(div);
  });
}

// ---- usage bar (tokens, rolling windows) ------------------------------------

function tokenBreakdown(u) {
  return `in ${u.input_tokens || 0} / out ${u.output_tokens || 0} / cache write ${u.cache_creation_tokens || 0} / cache read ${u.cache_read_tokens || 0}`;
}

function windowLabel(minutes) {
  return minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
}

async function pollUsage() {
  try {
    renderUsageBar(await api("/api/usage_windows"));
  } catch (e) {
    console.error("pollUsage", e);
  }
}

function renderUsageBar(u) {
  const bar = $("#usage-bar");
  bar.hidden = false;
  const windows = u.windows || [];
  const active = windows.some((w) => w.tokens);
  bar.classList.toggle("idle", !active);
  const winEl = $("#ub-windows");
  winEl.innerHTML = active
    ? windows
        .map(
          (w) =>
            `<span class="ub-win" title="${esc(tokenBreakdown(w))} · ${w.requests} request${w.requests === 1 ? "" : "s"}">` +
            `<span class="ub-win-label">${windowLabel(w.minutes)}</span> ${esc(fmtTokens(w.tokens))}</span>`
        )
        .join("")
    : '<span class="ub-idle">idle</span>';
  const topEl = $("#ub-top");
  const top = (u.top || [])[0];
  if (!top || !top.tokens) {
    topEl.textContent = "";
    topEl.title = "";
    topEl.onclick = null;
    return;
  }
  const label = top.session_id
    ? `<span class="ub-session">session ${esc(top.session_id.slice(0, 8))}</span>`
    : `<span class="ub-session">no session</span>`;
  topEl.innerHTML = `top: ${label} <span class="ub-proj">(${esc(top.project)})</span> — ${esc(fmtTokens(top.tokens))} tok`;
  topEl.title = tokenBreakdown(top);
  topEl.onclick = () => selectProject(top.project);
}

// ---- runs (claude -p in tmt-ai-code) ---------------------------------------

let runsTimer = null;
let knownRunStatus = {};
const dismissedRuns = new Set();
const expandedRuns = new Set();
const runOutputs = {};

function parseTs(ts) {
  if (!ts) return 0;
  return new Date(ts.endsWith("Z") ? ts : ts + "Z").getTime();
}

function fmtElapsed(run) {
  const end = run.finished_at ? parseTs(run.finished_at) : Date.now();
  const secs = Math.max(0, Math.round((end - parseTs(run.started_at)) / 1000));
  if (secs < 90) return secs + "s";
  return Math.round(secs / 60) + "m";
}

const RUN_ICON = { done: "✓", error: "✗", stale: "⚠" };

async function pollRuns() {
  clearTimeout(runsTimer);
  try {
    const data = await api("/api/runs");
    const prev = knownRunStatus;
    knownRunStatus = {};
    const finished = [];
    for (const r of data.runs) {
      knownRunStatus[r.id] = r.status;
      if (prev[r.id] === "running" && r.status !== "running") finished.push(r);
    }
    state.runs = data.runs;
    renderRunsGlobal();
    renderRunsStrip();
    renderProjects();
    if (finished.length) {
      loadProjects();
      if (finished.some((r) => r.project === state.project)) {
        loadRequests(false);
        loadNotes();
      }
    }
  } catch (e) {
    console.error("pollRuns", e);
  }
  const active = state.runs.some((r) => r.status === "running");
  runsTimer = setTimeout(pollRuns, active ? 3000 : 15000);
}

function runVisible(r) {
  if (r.status === "running") return true;
  if (dismissedRuns.has(r.id)) return false;
  return parseTs(r.finished_at) > Date.now() - 10 * 60 * 1000;
}

function renderRunsGlobal() {
  const wrap = $("#runs-global");
  const list = $("#runs-global-list");
  const visible = state.runs.filter(runVisible);
  wrap.hidden = visible.length === 0;
  list.innerHTML = "";
  for (const run of visible) {
    const div = document.createElement("div");
    div.className = `run-item ${run.status}`;
    div.title = run.error ? `${run.prompt}\n\n✗ ${run.error}` : run.prompt;
    div.innerHTML = `
      <span class="run-dot">${run.status === "running" ? "" : RUN_ICON[run.status] || "?"}</span>
      <span class="run-proj">${esc(run.project)}</span>
      <span class="run-prompt">${esc(run.prompt)}</span>
      <span class="run-age">${esc(fmtElapsed(run))}</span>
      ${run.status === "running" ? "" : `<button class="run-dismiss" title="dismiss">✕</button>`}`;
    div.onclick = () => selectProject(run.project);
    const dis = div.querySelector(".run-dismiss");
    if (dis)
      dis.onclick = (e) => {
        e.stopPropagation();
        dismissedRuns.add(run.id);
        renderRunsGlobal();
        renderRunsStrip();
      };
    list.appendChild(div);
  }
}

async function toggleRunOutput(run, item) {
  if (expandedRuns.has(run.id)) {
    expandedRuns.delete(run.id);
    renderRunsStrip();
    return;
  }
  expandedRuns.add(run.id);
  renderRunsStrip();
  if (runOutputs[run.id] === undefined || run.status === "running") {
    try {
      const st = await api(
        `/api/run?project=${encodeURIComponent(run.project)}&id=${run.id}`
      );
      const parts = [];
      if (st.error) parts.push("── error ──\n" + st.error);
      if (st.error_detail) parts.push("── detail ──\n" + st.error_detail);
      if (st.output && st.output !== st.error) parts.push(st.output);
      runOutputs[run.id] = parts.join("\n\n") || "(no output)";
    } catch (e) {
      runOutputs[run.id] = "error: " + e.message;
    }
    renderRunsStrip();
  }
}

function fmtResumeAt(run) {
  if (!run.resume_at || run.auto_resumed) return "";
  const t = parseTs(run.resume_at);
  if (t < Date.now()) return "";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function retryRun(run) {
  try {
    await post("/api/run_retry", { project: run.project, run_id: run.id });
  } catch (e) {
    alert("retry failed: " + e.message);
  }
  pollRuns();
}

function renderRunsStrip() {
  const strip = $("#runs-strip");
  if (!state.project) {
    strip.innerHTML = "";
    return;
  }
  const runs = state.runs
    .filter((r) => r.project === state.project && runVisible(r))
    .slice(0, 8);
  strip.innerHTML = "";
  for (const run of runs) {
    const div = document.createElement("div");
    div.className = `strip-run ${run.status}`;
    const label =
      run.status === "running"
        ? `running ${fmtElapsed(run)}`
        : `${run.status}${run.exit_code ? ` (exit ${run.exit_code})` : ""} · ${fmtElapsed(run)}`;
    const resumeAt = fmtResumeAt(run);
    const canRetry = run.status === "error" || run.status === "stale";
    div.innerHTML = `
      <div class="strip-row">
        <span class="run-dot">${run.status === "running" ? "" : RUN_ICON[run.status] || "?"}</span>
        <span class="strip-label">${esc(label)}</span>
        ${run.resume_session_id ? `<span class="strip-resumed" title="resumed session ${esc(run.resume_session_id)}">↩ resumed</span>` : ""}
        ${run.error ? `<span class="strip-err" title="${esc(run.error)}">${esc(run.error)}</span>` : ""}
        ${resumeAt ? `<span class="strip-resume-at" title="hit a usage limit — will auto-continue when it resets">⏱ auto-continue ${esc(resumeAt)}</span>` : ""}
        <span class="strip-prompt">${esc(run.prompt)}</span>
        ${canRetry && !run.auto_resumed ? `<button class="strip-retry btn" title="${run.session_id ? "resume this claude session" : "re-run the prompt (session id was not captured)"}">↻ continue</button>` : ""}
        <button class="strip-expand btn">${expandedRuns.has(run.id) ? "▾" : "▸"} output</button>
        ${run.status === "running" ? "" : `<button class="run-dismiss" title="dismiss">✕</button>`}
      </div>`;
    div.querySelector(".strip-expand").onclick = () => toggleRunOutput(run, div);
    const retry = div.querySelector(".strip-retry");
    if (retry)
      retry.onclick = (e) => {
        e.stopPropagation();
        retry.disabled = true;
        retryRun(run);
      };
    const dis = div.querySelector(".run-dismiss");
    if (dis)
      dis.onclick = () => {
        dismissedRuns.add(run.id);
        renderRunsGlobal();
        renderRunsStrip();
      };
    if (expandedRuns.has(run.id)) {
      const pre = document.createElement("pre");
      pre.className = "strip-output";
      pre.textContent =
        runOutputs[run.id] === undefined ? "loading…" : runOutputs[run.id];
      div.appendChild(pre);
    }
    strip.appendChild(div);
  }
}

async function startRun() {
  const prompt = $("#c-prompt").value.trim();
  if (!prompt || !state.project) return;
  const btn = $("#c-run");
  btn.disabled = true;
  $("#c-status").textContent = "";
  try {
    await post("/api/run", {
      project: state.project,
      prompt,
      continue: $("#c-continue").checked,
    });
    $("#c-prompt").value = "";
    $("#c-continue").checked = false;
  } catch (e) {
    $("#c-status").textContent = "failed: " + e.message;
  } finally {
    btn.disabled = false;
  }
  pollRuns();
}

async function sendFollowup() {
  const input = $("#followup-input");
  const prompt = input.value.trim();
  if (!prompt || !state.detail) return;
  const det = state.detail;
  const body = { project: state.project, prompt };
  if (det.session_id) body.resume_session_id = det.session_id;
  else body.continue = true;
  const btn = $("#followup-send");
  btn.disabled = true;
  try {
    await post("/api/run", body);
    input.value = "";
    $("#followup-hint").textContent = "follow-up run started — see runs above";
  } catch (e) {
    $("#followup-hint").textContent = "failed: " + e.message;
  } finally {
    btn.disabled = false;
  }
  pollRuns();
}

// ---- context panel --------------------------------------------------------

async function openContext() {
  closePanels();
  $("#context-panel").hidden = false;
  $("#context-title").textContent = `Context — ${state.project}`;
  $("#context-tabs").innerHTML = "";
  $("#context-content").textContent = "loading…";
  try {
    const data = await api(`/api/project_context?project=${encodeURIComponent(state.project)}`);
    if (!data.available) {
      $("#context-content").textContent = "unavailable: " + data.reason;
      return;
    }
    if (!data.files.length) {
      $("#context-content").textContent =
        "No CLAUDE.md / .claude context files found (or project not mounted in tmt-ai-code).";
      return;
    }
    const tabs = $("#context-tabs");
    data.files.forEach((file, i) => {
      const btn = document.createElement("button");
      btn.className = "tab" + (i === 0 ? " active" : "");
      btn.textContent = file.path;
      btn.onclick = () => {
        tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        btn.classList.add("active");
        $("#context-content").textContent = file.content;
      };
      tabs.appendChild(btn);
    });
    $("#context-content").textContent = data.files[0].content;
  } catch (e) {
    $("#context-content").textContent = "error: " + e.message;
  }
}

function closePanels() {
  $("#notes-panel").hidden = true;
  $("#context-panel").hidden = true;
}

// ---- wiring ---------------------------------------------------------------

$("#f-search").addEventListener(
  "input",
  debounce((e) => {
    state.filters.q = e.target.value.trim();
    loadRequests(false);
  }, 300)
);
$("#f-model").onchange = (e) => {
  state.filters.model = e.target.value;
  loadRequests(false);
};
$("#f-status").onchange = (e) => {
  state.filters.status = e.target.value;
  loadRequests(false);
};
$("#f-unread").onchange = (e) => {
  state.filters.unread = e.target.checked;
  loadRequests(false);
};
$("#f-group").onchange = (e) => {
  state.groupBySession = e.target.checked;
  state.expandedSessions = new Set();
  loadRequests(false);
};
$("#btn-more").onclick = () => {
  state.offset += state.limit;
  loadRequests(true);
};
$("#btn-refresh").onclick = () => {
  loadRequests(false);
  loadStatus();
  loadProjects();
};
$("#btn-mark-all").onclick = async () => {
  await post("/api/mark_all", { project: state.project });
  loadRequests(false);
  loadProjects();
};
$("#btn-read-all").onclick = async () => {
  await post("/api/mark_all_global", {});
  if (state.project) loadRequests(false);
  loadProjects();
};
$("#btn-logout").onclick = async () => {
  await post("/api/logout", {});
  location.reload();
};
function applyTheme(theme) {
  document.documentElement.classList.toggle("light", theme === "light");
  $("#btn-theme").textContent = theme === "light" ? "🌙" : "☀️";
  localStorage.setItem("tmt-theme", theme);
}
$("#btn-theme").onclick = () =>
  applyTheme(document.documentElement.classList.contains("light") ? "dark" : "light");
applyTheme(localStorage.getItem("tmt-theme") || "dark");
$("#btn-toggle-read").onclick = () => {
  if (state.detail) setRead([state.detail.id], !state.detail.read_at);
};
$("#btn-delete").onclick = () => state.detail && deleteRequest(state.detail.id);
$("#btn-notes").onclick = openNotes;
$("#btn-notes-close").onclick = closePanels;
$("#btn-context").onclick = openContext;
$("#btn-context-close").onclick = closePanels;
$("#notes-add-form").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("#notes-add-input");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  try {
    const res = await post("/api/note_create", { project: state.project, title, body: "" });
    await loadNotes();
    if (res.note) {
      state.noteId = res.note.id;
      state.noteEdit = true;
      renderNoteList();
      renderNoteDetail();
    }
  } catch (err) {
    $("#notes-status").textContent = "create failed: " + err.message;
  }
};
$("#note-edit").onclick = () => {
  state.noteEdit = !state.noteEdit;
  renderNoteDetail();
};
$("#note-delete").onclick = async () => {
  const note = currentNote();
  if (!note) return;
  if (!confirm(`Delete note "${noteLabel(note)}"?`)) return;
  await post("/api/note_delete", { project: state.project, id: note.id });
  state.noteId = null;
  loadNotes();
};
$("#c-run").onclick = startRun;
$("#c-prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startRun();
});
$("#followup-send").onclick = sendFollowup;
$("#followup-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendFollowup();
});
document.querySelectorAll("#detail-tabs .tab").forEach((tab) => {
  tab.onclick = () => {
    state.detailTab = tab.dataset.tab;
    renderDetailBody();
  };
});

loadProjects();
pollRuns();
pollUsage();
setInterval(loadProjects, 20000);
setInterval(pollUsage, 15000);
setInterval(() => {
  if (state.project) loadStatus();
}, 30000);
