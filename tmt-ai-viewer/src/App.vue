<script setup lang="ts">
import { onMounted, ref, computed, watch } from "vue";
import { useStore } from "./store";
import Login from "./components/Login.vue";
import Sidebar from "./components/Sidebar.vue";
import ThreadList from "./components/ThreadList.vue";
import ThreadDetail from "./components/ThreadDetail.vue";

const store = useStore();
const composer = ref("");
const planMode = ref(false);
// Where the request runs: "" = fresh claude/* branch, NO_BRANCH = main tree
// with nothing committed (direct mode), anything else = that existing branch.
const NO_BRANCH = "__none__";
const branchMode = ref("");
const noteText = ref("");

const existingBranches = computed(() => store.gitInfo?.branches || []);
watch(
  () => store.currentProject,
  () => {
    branchMode.value = "";
    if (store.currentProject) store.loadGitBranches();
  }
);

// Model picker for the composer. "" = the CLI's configured default; the aliases
// map to the latest of each tier, so they don't go stale. Choice is remembered.
const MODEL_OPTIONS = [
  { value: "", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
const model = ref(localStorage.getItem("tmt2-model") || "");
watch(model, (m) => localStorage.setItem("tmt2-model", m));

// -- notes checklist ---------------------------------------------------------
const CHECK_RE = /^(\s*)- \[( |~|x)\] (.*)$/;
const MARK_CYCLE: Record<string, string> = { " ": "~", "~": "x", x: " " };
const MARK_ICON: Record<string, string> = { " ": "", "~": "◐", x: "✓" };

const editId = ref<number | null>(null);
const editBuf = ref("");

function noteLines(body: string) {
  return (body || "").split("\n").map((line, idx) => {
    const m = line.match(CHECK_RE);
    return m
      ? { idx, check: true, mark: m[2], text: m[3] }
      : { idx, check: false, mark: " ", text: line };
  });
}

function progress(body: string) {
  let open = 0,
    done = 0;
  for (const line of (body || "").split("\n")) {
    const m = line.match(CHECK_RE);
    if (!m) continue;
    if (m[2] === "x") done++;
    else open++;
  }
  return { open, done, total: open + done };
}

function toggleMark(n: any, idx: number) {
  const lines = (n.body || "").split("\n");
  const m = lines[idx].match(CHECK_RE);
  if (!m) return;
  lines[idx] = `${m[1]}- [${MARK_CYCLE[m[2]]}] ${m[3]}`;
  store.updateNote(n.id, { body: lines.join("\n") });
}

function runLine(n: any, text: string) {
  store.runNoteLine(n.title ? `${n.title}: ${text}` : text);
}

function runAllOpen(n: any) {
  for (const ln of noteLines(n.body)) {
    if (ln.check && ln.mark !== "x") runLine(n, ln.text);
  }
}

function startEdit(n: any) {
  editId.value = n.id;
  editBuf.value = n.body || "";
}
function saveEdit(n: any) {
  store.updateNote(n.id, { body: editBuf.value });
  editId.value = null;
}

onMounted(() => store.init());

async function run() {
  const p = composer.value;
  const mode = branchMode.value;
  composer.value = "";
  branchMode.value = "";
  await store.submit(
    p,
    planMode.value,
    model.value,
    mode === NO_BRANCH,
    mode && mode !== NO_BRANCH ? mode : ""
  );
}

const win = (m: number) => store.usage.windows?.[m] || { tokens: 0, requests: 0 };
function fmt(n: number) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n || 0);
}

// live-ticking clock so the reset countdowns update each second
const nowSec = ref(Math.floor(Date.now() / 1000));
onMounted(() => setInterval(() => (nowSec.value = Math.floor(Date.now() / 1000)), 1000));

function pct(u: number | null) {
  return u == null ? "—" : Math.round(u * 100) + "%";
}
function countdown(resetEpoch: number | null) {
  if (!resetEpoch) return "—";
  let s = resetEpoch - nowSec.value;
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
function limClass(w: any) {
  if (!w) return "";
  if (w.status && w.status !== "allowed") return "lim-hot";
  return (w.utilization || 0) >= 0.8 ? "lim-warn" : "";
}

async function addNote() {
  const t = noteText.value.trim();
  if (!t) return;
  noteText.value = "";
  await store.addNote(t);
}

// -- scheduler panel ---------------------------------------------------------
const schedProject = ref("");
const schedPrompt = ref("");
const schedAgents = ref(4);

async function addSched() {
  const p = schedProject.value || store.currentProject || "";
  if (!p || !schedPrompt.value.trim()) return;
  await store.addScheduled(p, schedPrompt.value.trim(), schedAgents.value);
  schedPrompt.value = "";
}
function saveCfg(patch: any) {
  store.saveSchedulerConfig(patch);
}
function moveTask(id: string, dir: number) {
  const ids = store.scheduled.map((t: any) => t.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  store.reorderScheduled(ids);
}

// -- branches panel ----------------------------------------------------------
const gitOpen = ref<string | null>(null); // expanded branch name
const gitDiffText = ref("");
const gitDiffLabel = ref("");

function reldate(iso: string) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

const pushCmd = computed(
  () => "git push origin 'refs/heads/claude/*:refs/heads/claude/*'"
);

// Split a diff into per-line rows so we can color +/- lines.
const diffRows = computed(() =>
  (gitDiffText.value || "").split("\n").map((text) => {
    let cls = "";
    if (text.startsWith("+") && !text.startsWith("+++")) cls = "diff-add";
    else if (text.startsWith("-") && !text.startsWith("---")) cls = "diff-del";
    else if (text.startsWith("@@")) cls = "diff-hunk";
    return { text, cls };
  })
);

async function toggleBranch(b: any) {
  if (gitOpen.value === b.name) {
    gitOpen.value = null;
    return;
  }
  gitOpen.value = b.name;
  gitDiffLabel.value =
    b.unpushed > 0
      ? `unpushed diff · ${b.unpushed} commit${b.unpushed > 1 ? "s" : ""}`
      : "nothing unpushed";
  gitDiffText.value = "loading…";
  const r = await store.loadDiff({ branch: b.name });
  gitDiffText.value = r.diff || "(no changes)";
}
async function showCommit(sha: string) {
  gitDiffLabel.value = `commit ${sha}`;
  gitDiffText.value = "loading…";
  const r = await store.loadDiff({ commit: sha });
  gitDiffText.value = r.diff || "(no changes)";
}
function openReq(b: any) {
  if (!b.thread_id) return;
  store.openThread(b.thread_id);
  store.closePanel();
}
</script>

<template>
  <div v-if="!store.ready" class="empty">loading…</div>

  <Login v-else-if="store.authEnabled && !store.authed" />

  <div v-else class="app">
    <Sidebar />

    <div id="main">
      <!-- usage bar -->
      <div class="usage-bar">
        <span>tokens</span>
        <span class="usage-win">5m <b>{{ fmt(win(5).tokens) }}</b></span>
        <span class="usage-win">30m <b>{{ fmt(win(30).tokens) }}</b></span>
        <span class="usage-win">1h <b>{{ fmt(win(60).tokens) }}</b></span>
        <span class="usage-win">4h <b>{{ fmt(win(240).tokens) }}</b></span>
        <span class="usage-win">{{ win(60).requests }} req/1h</span>

        <template v-if="store.limits.available">
          <span class="lim-chip" :class="limClass(store.limits.five_h)" style="margin-left: auto"
            title="Anthropic 5-hour rolling limit">
            5h <b>{{ pct(store.limits.five_h.utilization) }}</b>
            · resets {{ countdown(store.limits.five_h.reset) }}
          </span>
          <span class="lim-chip" :class="limClass(store.limits.seven_d)"
            title="Anthropic weekly (7-day) limit">
            Week <b>{{ pct(store.limits.seven_d.utilization) }}</b>
            · resets {{ countdown(store.limits.seven_d.reset) }}
          </span>
        </template>
      </div>

      <!-- header -->
      <div class="project-header" v-if="store.currentProject">
        <h2>{{ store.currentProject }}</h2>
        <div class="chips">
          <span
            v-for="c in store.containers"
            :key="c.name"
            class="chip"
            :title="c.status"
          >
            <span class="dot" :class="c.state === 'running' ? 'running' : 'exited'"></span>
            {{ c.service || c.name }}
          </span>
        </div>
        <div class="header-actions">
          <button class="btn" @click="store.openPanel('notes')">Notes</button>
          <button class="btn" @click="store.openPanel('branches')">Branches</button>
          <button class="btn" @click="store.openPanel('scheduler')">Scheduler</button>
          <button class="btn" @click="store.openPanel('context')">CLAUDE.md</button>
          <button class="btn" @click="store.loadThreads(); store.loadStatus()">Refresh</button>
        </div>
      </div>

      <!-- composer -->
      <div class="composer" v-if="store.currentProject">
        <textarea
          v-model="composer"
          placeholder="Ask Claude to do something in this project… (Ctrl/⌘+Enter to run)"
          @keydown.ctrl.enter="run"
          @keydown.meta.enter="run"
        ></textarea>
        <div class="row">
          <button class="btn primary" :disabled="!composer.trim()" @click="run">
            {{ planMode ? "◑ Plan" : "▶ Run" }}
          </button>
          <select class="model-select" v-model="model" title="Which Claude model to run this request with">
            <option v-for="m in MODEL_OPTIONS" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select>
          <label class="plan-toggle" title="Research and propose a plan first; you approve it before anything runs">
            <input type="checkbox" v-model="planMode" />
            Plan mode
          </label>
          <select
            class="model-select"
            v-model="branchMode"
            title="Where the request runs: a fresh claude/* branch, the main tree with nothing committed, or an existing branch"
          >
            <option value="">New branch</option>
            <option :value="NO_BRANCH">No branch / no commits</option>
            <optgroup v-if="existingBranches.length" label="Existing branches">
              <option v-for="b in existingBranches" :key="b.name" :value="b.name">
                ⎇ {{ b.name }}
              </option>
            </optgroup>
          </select>
          <span class="tokens">
            {{ planMode
              ? "Claude proposes a plan; you approve it here before it executes."
              : branchMode === NO_BRANCH
              ? "Edits the current checkout directly; no branch, nothing committed."
              : branchMode
              ? `Runs on the existing branch ${branchMode}, committing there.`
              : "Starts a new request in its own Claude session." }}
          </span>
        </div>
      </div>

      <!-- panes -->
      <div class="panes" v-if="store.currentProject">
        <ThreadList />
        <ThreadDetail />
      </div>
      <div v-else class="empty">Pick a project from the sidebar.</div>
    </div>

    <!-- slide-over panels -->
    <template v-if="store.panel">
      <div class="overlay" @click="store.closePanel()"></div>
      <div class="slideover">
        <header>
          <h3>
            {{ store.panel === "notes" ? "Notes" : store.panel === "scheduler" ? "Scheduler" : store.panel === "branches" ? "Branches" : "Context" }}
            <template v-if="store.panel !== 'scheduler'"> — {{ store.currentProject }}</template>
          </h3>
          <button class="btn" style="margin-left: auto" @click="store.closePanel()">Close</button>
        </header>

        <div class="so-body" v-if="store.panel === 'notes'">
          <textarea
            v-model="noteText"
            placeholder="Add a note…"
            style="width: 100%; min-height: 44px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px; font: inherit"
          ></textarea>
          <div style="margin: 6px 0 14px">
            <button class="btn" @click="addNote">Add note</button>
          </div>
          <div v-if="!store.notes.length" class="empty">No notes.</div>
          <div v-for="n in store.notes" :key="n.id" class="note-card">
            <div class="note-head">
              <span class="tokens">
                {{ n.origin }} · {{ (n.created_at || "").slice(0, 16).replace("T", " ") }}
              </span>
              <span v-if="progress(n.body).total" class="n-progress" title="done / total">
                {{ progress(n.body).done }}/{{ progress(n.body).total }}
              </span>
              <span class="note-head-actions">
                <button
                  v-if="editId !== n.id && progress(n.body).open"
                  class="n-linkbtn"
                  title="run every unfinished item as its own claude run"
                  @click="runAllOpen(n)"
                >
                  ▶ Run all open ({{ progress(n.body).open }})
                </button>
                <button
                  v-if="editId !== n.id"
                  class="n-linkbtn"
                  @click="startEdit(n)"
                >
                  ✎ Edit
                </button>
              </span>
            </div>
            <div v-if="n.title" style="font-weight: 600; margin-bottom: 4px">{{ n.title }}</div>

            <template v-if="editId === n.id">
              <textarea
                v-model="editBuf"
                style="width: 100%; min-height: 120px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px; font: inherit"
              ></textarea>
              <div style="margin-top: 6px; display: flex; gap: 8px">
                <button class="btn" @click="saveEdit(n)">Save</button>
                <button class="btn" @click="editId = null">Cancel</button>
              </div>
            </template>

            <div v-else class="note-lines">
              <template v-for="ln in noteLines(n.body)" :key="ln.idx">
                <div
                  v-if="ln.check"
                  class="n-check"
                  :class="ln.mark === 'x' ? 'done' : ln.mark === '~' ? 'doing' : ''"
                >
                  <button
                    class="n-mark"
                    title="todo → in progress → done"
                    @click="toggleMark(n, ln.idx)"
                  >
                    {{ MARK_ICON[ln.mark] }}
                  </button>
                  <span class="n-text">{{ ln.text }}</span>
                  <button
                    v-if="ln.mark !== 'x'"
                    class="n-run"
                    title="run this line as its own claude run"
                    @click="runLine(n, ln.text)"
                  >
                    ▶
                  </button>
                </div>
                <div v-else-if="ln.text.trim()" class="n-line">{{ ln.text }}</div>
              </template>
            </div>
          </div>
        </div>

        <div class="so-body" v-else-if="store.panel === 'scheduler'">
          <!-- config -->
          <div class="sched-config" v-if="store.schedulerCfg">
            <label class="plan-toggle">
              <input type="checkbox" v-model="store.schedulerCfg.enabled"
                @change="saveCfg({ enabled: store.schedulerCfg.enabled })" />
              Scheduler enabled
            </label>
            <div class="sched-row">
              <span>Policy</span>
              <label><input type="radio" value="always" v-model="store.schedulerCfg.policy"
                @change="saveCfg({ policy: 'always' })" /> Always at night</label>
              <label><input type="radio" value="weekly_low" v-model="store.schedulerCfg.policy"
                @change="saveCfg({ policy: 'weekly_low' })" /> Only when weekly barely used</label>
            </div>
            <div class="sched-row">
              <span>Night window ({{ store.schedulerCfg.timezone }})</span>
              <input type="number" min="0" max="23" v-model.number="store.schedulerCfg.night_start_hour"
                @change="saveCfg({ night_start_hour: store.schedulerCfg.night_start_hour })" />
              <span>to</span>
              <input type="number" min="0" max="23" v-model.number="store.schedulerCfg.night_end_hour"
                @change="saveCfg({ night_end_hour: store.schedulerCfg.night_end_hour })" />
            </div>
            <div class="sched-row">
              <span>Concurrency</span>
              <input type="number" min="1" max="8" v-model.number="store.schedulerCfg.concurrency"
                @change="saveCfg({ concurrency: store.schedulerCfg.concurrency })" />
              <span>Default agents</span>
              <input type="number" min="1" max="12" v-model.number="store.schedulerCfg.default_agents"
                @change="saveCfg({ default_agents: store.schedulerCfg.default_agents })" />
            </div>
            <div class="tokens" v-if="store.schedulerDecision">
              tonight: {{ store.schedulerDecision.reason }}
              <b :style="{ color: store.schedulerDecision.allow ? 'var(--green)' : 'var(--amber)' }">
                → {{ store.schedulerDecision.allow ? "will run" : "will wait" }}
              </b>
            </div>
          </div>

          <!-- add task -->
          <div class="sched-add">
            <select v-model="schedProject">
              <option value="">{{ store.currentProject || "pick project" }}</option>
              <option v-for="p in store.projects" :key="p.name" :value="p.name">{{ p.name }}</option>
            </select>
            <input type="number" min="1" max="12" v-model.number="schedAgents" title="agents" style="width: 56px" />
            <textarea v-model="schedPrompt" placeholder="Task to queue for the night…"
              style="width: 100%; min-height: 44px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px; font: inherit"></textarea>
            <button class="btn" @click="addSched">Queue task</button>
          </div>

          <!-- queue -->
          <div v-if="!store.scheduled.length" class="empty">No scheduled tasks.</div>
          <div v-for="(t, i) in store.scheduled" :key="t.id" class="sched-task">
            <div class="sched-task-head">
              <span class="chip mono">{{ t.project }}</span>
              <span v-if="t.kind === 'approval'" class="chip plan-chip" title="scheduled plan approval — resumes that request's session with the plan approved">◑ approval</span>
              <span class="chip" :class="'st-' + t.status">{{ t.status }}</span>
              <span class="tokens">· {{ t.agents }} agent{{ t.agents > 1 ? "s" : "" }}</span>
              <span class="sched-actions">
                <button class="n-linkbtn" :disabled="i === 0" @click="moveTask(t.id, -1)">↑</button>
                <button class="n-linkbtn" :disabled="i === store.scheduled.length - 1" @click="moveTask(t.id, 1)">↓</button>
                <button v-if="t.thread_id" class="n-linkbtn" @click="store.openThread(t.thread_id); store.closePanel()">open</button>
                <button v-if="t.status !== 'running'" class="n-linkbtn" @click="store.runScheduled(t.id, t.agents)">▶ run now</button>
                <button class="n-linkbtn" @click="store.deleteScheduled(t.id)">✕</button>
              </span>
            </div>
            <div v-if="t.kind === 'approval' && t.thread_title" class="tokens">plan of: {{ t.thread_title }}</div>
            <div class="sched-prompt">{{ t.prompt }}</div>
            <div v-if="t.error" class="tokens" style="color: var(--red)">{{ t.error }}</div>
          </div>
        </div>

        <div class="so-body" v-else-if="store.panel === 'branches'">
          <div v-if="!store.gitInfo.is_repo" class="empty">
            {{ store.gitInfo.available === false ? "Could not read git." : "Not a git repository." }}
          </div>
          <template v-else>
            <div v-if="store.gitInfo.dirty" class="dirty-banner">
              ⚠ {{ store.gitInfo.dirty }} uncommitted change{{ store.gitInfo.dirty > 1 ? "s" : "" }}
              in the working tree (current branch: <span class="mono">{{ store.gitInfo.current }}</span>)
            </div>
            <div class="push-hint">
              <div class="tokens" style="margin:0 0 4px">Push all Claude branches from the host:</div>
              <pre class="mono push-cmd">{{ pushCmd }}</pre>
            </div>

            <div v-if="!store.gitInfo.branches.length" class="empty">
              No claude/* branches yet.
            </div>

            <div v-for="b in store.gitInfo.branches" :key="b.name" class="branch-card">
              <div class="branch-head" @click="toggleBranch(b)">
                <span class="branch-caret">{{ gitOpen === b.name ? "▾" : "▸" }}</span>
                <span class="mono branch-name">{{ b.name }}</span>
                <span v-if="b.name === store.gitInfo.current" class="chip cur-chip">current</span>
                <span
                  class="chip"
                  :class="b.unpushed > 0 ? 'unpushed-yes' : 'unpushed-no'"
                  :title="b.unpushed > 0 ? 'commits not on any remote' : 'nothing to push'"
                >
                  {{ b.unpushed > 0 ? `↑ ${b.unpushed} to push` : "✓ pushed" }}
                </span>
                <span class="branch-actions">
                  <a
                    v-if="b.pr_url"
                    class="n-linkbtn"
                    :href="b.pr_url"
                    target="_blank"
                    rel="noopener"
                    :title="b.unpushed > 0
                      ? 'open a pull request on the remote — this branch still has unpushed commits, push first for them to show up'
                      : 'open a pull request for this branch on the remote'"
                    @click.stop
                  >
                    open PR ↗
                  </a>
                  <button
                    v-if="b.thread_id"
                    class="n-linkbtn"
                    title="open the request/response that created this branch"
                    @click.stop="openReq(b)"
                  >
                    open request →
                  </button>
                </span>
              </div>
              <div v-if="b.last" class="branch-last tokens">
                {{ b.last.sha }} · {{ b.last.subject }} · {{ reldate(b.last.date) }}
              </div>

              <div v-if="gitOpen === b.name" class="branch-body">
                <div v-if="b.commits && b.commits.length" class="commit-list">
                  <div class="tokens" style="margin:0 0 2px">Unpushed commits (click to view):</div>
                  <button
                    v-for="c in b.commits"
                    :key="c.sha"
                    class="commit-row"
                    @click="showCommit(c.sha)"
                  >
                    <span class="mono">{{ c.sha }}</span>
                    <span class="commit-subj">{{ c.subject }}</span>
                    <span class="tokens" style="margin:0">{{ reldate(c.date) }}</span>
                  </button>
                </div>
                <div class="diff-label tokens">{{ gitDiffLabel }}</div>
                <pre class="diff"><span
                  v-for="(row, i) in diffRows"
                  :key="i"
                  class="dl"
                  :class="row.cls"
                >{{ row.text }}
</span></pre>
              </div>
            </div>
          </template>
        </div>

        <div class="so-body" v-else>
          <div v-if="!store.context.files || !store.context.files.length" class="empty">
            No CLAUDE.md / .claude files found.
          </div>
          <div v-for="f in store.context.files" :key="f.path" class="ctx-card">
            <div class="path mono">{{ f.path }}</div>
            <pre class="mono">{{ f.content }}</pre>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
