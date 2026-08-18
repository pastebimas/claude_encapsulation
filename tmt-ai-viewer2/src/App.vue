<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useStore } from "./store";
import Login from "./components/Login.vue";
import Sidebar from "./components/Sidebar.vue";
import ThreadList from "./components/ThreadList.vue";
import ThreadDetail from "./components/ThreadDetail.vue";

const store = useStore();
const composer = ref("");
const noteText = ref("");

// -- notes checklist (ported from the old viewer) ----------------------------
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
  composer.value = "";
  await store.submit(p);
}

const win = (m: number) => store.usage.windows?.[m] || { tokens: 0, requests: 0 };
function fmt(n: number) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n || 0);
}

async function addNote() {
  const t = noteText.value.trim();
  if (!t) return;
  noteText.value = "";
  await store.addNote(t);
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
        <span class="usage-win" style="margin-left: auto">{{ win(60).requests }} req/1h</span>
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
          <button class="btn primary" :disabled="!composer.trim()" @click="run">▶ Run</button>
          <span class="tokens">Starts a new request in its own Claude session.</span>
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
          <h3>{{ store.panel === "notes" ? "Notes" : "Context" }} — {{ store.currentProject }}</h3>
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
