<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useStore } from "../store";

const store = useStore();
const followupText = ref("");

// Group events under their turn, preserving order. Each block = one user turn
// plus everything Claude produced answering it.
const blocks = computed(() => {
  const byTurn: Record<string, any[]> = {};
  for (const ev of store.events) {
    (byTurn[ev.turn_id] ||= []).push(ev);
  }
  return store.turns.map((t) => {
    const evs = (byTurn[t.id] || []).slice().sort((a, b) => a.seq - b.seq);
    const hasAssistantText = evs.some((e) => e.type === "assistant_text");
    return { turn: t, events: evs, hasAssistantText };
  });
});

function prettyInput(data_json: string) {
  try {
    return JSON.stringify(JSON.parse(data_json), null, 2);
  } catch {
    return data_json;
  }
}

function tokenLine(ev: any) {
  const parts: string[] = [];
  if (ev.in_tokens) parts.push(`${ev.in_tokens} in`);
  if (ev.out_tokens) parts.push(`${ev.out_tokens} out`);
  if (ev.cache_read) parts.push(`${ev.cache_read} cache-read`);
  if (ev.cache_creation) parts.push(`${ev.cache_creation} cache-write`);
  return parts.join(" · ");
}

async function send() {
  const p = followupText.value;
  followupText.value = "";
  await store.followup(p);
}

const awaiting = computed(() =>
  store.thread && store.thread.status === "awaiting" ? store.thread.awaiting : null
);
const awaitingPlan = computed(() => awaiting.value && awaiting.value.plan != null);

async function pick(option: string) {
  await store.followup(option);
}

// Collapse the noisy middle of a turn (thinking + tool calls + results) into a
// single foldable group, so only the request and Claude's answer stand out.
const STEP_TYPES = new Set(["thinking", "tool_use", "tool_result"]);
function segments(events: any[]) {
  const out: any[] = [];
  let buf: any[] = [];
  const flush = () => {
    if (buf.length) out.push({ kind: "steps", events: buf });
    buf = [];
  };
  for (const ev of events) {
    if (STEP_TYPES.has(ev.type)) buf.push(ev);
    else {
      flush();
      out.push({ kind: "event", ev });
    }
  }
  flush();
  return out;
}
function stepsLabel(events: any[]) {
  const tools = events.filter((e) => e.type === "tool_use").map((e) => e.name);
  const uniq = [...new Set(tools)];
  if (!tools.length) return "thinking";
  return uniq.slice(0, 4).join(", ") + (uniq.length > 4 ? "…" : "");
}

watch(
  () => store.detailTab,
  (tab) => {
    if (tab === "raw" && !store.rawData) store.loadRaw();
  }
);
</script>

<template>
  <div class="detail-pane" v-if="store.thread">
    <div class="detail-head">
      <div style="display: flex; align-items: center; gap: 10px">
        <span v-if="store.thread.status === 'running'" class="run-dot"></span>
        <span v-else class="dot" :class="store.thread.status"></span>
        <strong>{{ store.thread.status }}</strong>
        <span v-if="store.thread.plan_mode" class="chip plan-chip">◑ plan</span>
        <span class="chip mono">session {{ store.thread.session_id.slice(0, 8) }}</span>
        <button
          v-if="store.thread.status === 'running'"
          class="btn stop-btn"
          style="margin-left: auto"
          @click="store.stop()"
        >
          ■ Stop
        </button>
      </div>
    </div>

    <div class="detail-tabs">
      <div class="tab" :class="{ active: store.detailTab === 'conversation' }" @click="store.detailTab = 'conversation'">
        Conversation
      </div>
      <div class="tab" :class="{ active: store.detailTab === 'raw' }" @click="store.detailTab = 'raw'">
        Raw
      </div>
    </div>

    <!-- Conversation -->
    <div class="detail-body" v-if="store.detailTab === 'conversation'">
      <template v-for="b in blocks" :key="b.turn.id">
        <div class="msg user">
          <div class="role">you</div>
          <div class="content">{{ b.turn.user_text }}</div>
        </div>

        <template v-for="(seg, i) in segments(b.events)" :key="i">
          <!-- collapsed group of intermediate steps (thinking + tools) -->
          <details v-if="seg.kind === 'steps'" class="steps-group">
            <summary>▸ {{ seg.events.length }} step{{ seg.events.length > 1 ? "s" : "" }} · {{ stepsLabel(seg.events) }}</summary>
            <div class="steps-body">
              <template v-for="ev in seg.events" :key="ev.id">
                <details v-if="ev.type === 'thinking'" class="block" data-kind="thinking">
                  <summary>💭 thinking</summary>
                  <div class="body">{{ ev.text }}</div>
                </details>
                <details v-else-if="ev.type === 'tool_use'" class="block" data-kind="tool_use">
                  <summary>🔧 {{ ev.name }}</summary>
                  <pre class="body">{{ prettyInput(ev.data_json) }}</pre>
                </details>
                <details v-else-if="ev.type === 'tool_result'" class="block" data-kind="tool_result">
                  <summary>↩ tool result</summary>
                  <div class="body mono">{{ ev.text }}</div>
                </details>
              </template>
            </div>
          </details>

          <!-- always-visible events: request answer, result, git pull -->
          <template v-else>
            <div v-if="seg.ev.type === 'system' && seg.ev.name === 'git_pull'" class="tokens git-pull">
              ⤓ git pull — {{ seg.ev.text }}
            </div>
            <div v-else-if="seg.ev.type === 'assistant_text'" class="msg assistant">
              <div class="role">claude</div>
              <div class="content">{{ seg.ev.text }}</div>
            </div>
            <div v-else-if="seg.ev.type === 'result'">
              <div v-if="!b.hasAssistantText" class="msg result">
                <div class="role">result</div>
                <div class="content">{{ seg.ev.text }}</div>
              </div>
              <div class="tokens" v-if="tokenLine(seg.ev)">tokens: {{ tokenLine(seg.ev) }}</div>
            </div>
          </template>
        </template>
      </template>

      <div v-if="store.thread.status === 'running'" class="tokens">
        <span class="run-dot"></span> running…
      </div>

      <!-- a plan awaiting approval -->
      <div v-if="awaitingPlan" class="question-card">
        <div class="q-label">◑ Plan ready for your approval</div>
        <div class="content plan-text">{{ awaiting.plan }}</div>
        <div class="q-options">
          <button class="q-opt approve" @click="store.approvePlan()">✓ Approve &amp; run</button>
        </div>
        <div class="tokens" style="margin-top: 8px">
          Approve to run it, or type changes below to keep planning (stays in plan mode).
        </div>
      </div>

      <!-- clarifying question the run paused on -->
      <div v-else-if="awaiting" class="question-card">
        <div class="q-label">Claude is asking</div>
        <div class="q-text">{{ awaiting.question }}</div>
        <div class="q-options" v-if="awaiting.options && awaiting.options.length">
          <button
            v-for="(opt, i) in awaiting.options"
            :key="i"
            class="q-opt"
            @click="pick(opt)"
          >
            {{ opt }}
          </button>
        </div>
        <div class="tokens" style="margin-top: 8px">
          Pick an option or type your own answer below — it continues the same session.
        </div>
      </div>
    </div>

    <!-- Raw -->
    <div class="detail-body" v-else>
      <div v-if="!store.rawData" class="empty">loading…</div>
      <template v-else>
        <div v-for="t in store.rawData.turns" :key="t.seq" class="msg">
          <div class="role">turn {{ t.seq }} — what you typed</div>
          <div class="content">{{ t.user_text }}</div>
          <div class="role" style="border-top: 1px solid var(--border)">what was actually sent</div>
          <div class="content mono">{{ t.sent_text }}</div>
        </div>
        <details class="block">
          <summary>raw stream-json events ({{ store.rawData.events.length }})</summary>
          <pre class="body">{{ store.rawData.events.map((e: any) => e.data_json || `[${e.type}]`).join("\n") }}</pre>
        </details>
      </template>
    </div>

    <!-- follow-up -->
    <div class="followup" v-if="store.detailTab === 'conversation'">
      <textarea
        v-model="followupText"
        placeholder="Follow up (continues the same session)…"
        @keydown.ctrl.enter="send"
        @keydown.meta.enter="send"
      ></textarea>
      <div style="margin-top: 6px; display: flex; align-items: center; gap: 10px">
        <button class="btn primary" :disabled="store.thread.status === 'running' || !followupText.trim()" @click="send">
          ↩ Send follow-up
        </button>
        <span class="tokens" v-if="store.thread.status === 'running'">wait for the current run to finish</span>
        <span class="tokens" v-else>Ctrl/⌘+Enter</span>
      </div>
    </div>
  </div>

  <div class="detail-pane" v-else>
    <div class="empty">Select a request, or start a new one above.</div>
  </div>
</template>
