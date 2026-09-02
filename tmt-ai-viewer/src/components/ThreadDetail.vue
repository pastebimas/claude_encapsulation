<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useStore } from "../store";

const store = useStore();
const followupText = ref("");

// Model for the next follow-up; seeded from the thread's current model and kept
// in sync when you switch threads. "" = the CLI default. Sending with a
// different value switches the model for this and later runs of the session.
const MODEL_OPTIONS = [
  { value: "", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
const followupModel = ref("");
watch(
  () => store.thread && store.thread.id,
  () => {
    followupModel.value = (store.thread && store.thread.model) || "";
  },
  { immediate: true }
);

// Group events under their turn, preserving order. Each block = one user turn
// plus everything Claude produced answering it, folded into: request →
// collapsed progress → result.
const blocks = computed(() => {
  const byTurn: Record<string, any[]> = {};
  for (const ev of store.events) {
    (byTurn[ev.turn_id] ||= []).push(ev);
  }
  return store.turns.map((t) => {
    const evs = (byTurn[t.id] || []).slice().sort((a, b) => a.seq - b.seq);
    const hasAssistantText = evs.some((e) => e.type === "assistant_text");
    return { turn: t, events: evs, hasAssistantText, layout: layout(evs) };
  });
});

// Split a turn's events into the collapsed middle (progress) and the final
// answer. The final answer is the last assistant_text; everything before it —
// thinking, tool calls/results, intermediate narration, git pull — is progress.
// With no assistant_text, the result event's text is the answer.
function layout(evs: any[]) {
  let lastAssistant = -1;
  for (let i = 0; i < evs.length; i++) {
    if (evs[i].type === "assistant_text") lastAssistant = i;
  }
  const resultEv = evs.find((e) => e.type === "result") || null;
  const progress: any[] = [];
  let finalText: string | null = null;
  if (lastAssistant >= 0) {
    finalText = evs[lastAssistant].text;
    evs.forEach((e, i) => {
      if (i === lastAssistant || e.type === "result") return;
      progress.push(e);
    });
  } else {
    finalText = resultEv ? resultEv.text : null;
    for (const e of evs) if (e.type !== "result") progress.push(e);
  }
  return { progress, finalText, resultEv };
}

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
  const cost = costOf(ev);
  if (cost != null) parts.push(`$${cost.toFixed(2)}`);
  return parts.join(" · ");
}

// The CLI prices each run itself and puts it on the result record.
function costOf(ev: any) {
  try {
    const d = JSON.parse(ev.data_json || "{}");
    return typeof d.total_cost_usd === "number" ? d.total_cost_usd : null;
  } catch {
    return null;
  }
}

const money = (n: any) => `$${Number(n || 0).toFixed(2)}`;

async function send() {
  const p = followupText.value;
  followupText.value = "";
  // Only send a model override when it differs from the thread's current one, so
  // an unchanged picker doesn't need special-casing server-side.
  const cur = (store.thread && store.thread.model) || "";
  await store.followup(p, undefined, followupModel.value === cur ? undefined : followupModel.value);
}

const awaiting = computed(() =>
  store.thread && store.thread.status === "awaiting" ? store.thread.awaiting : null
);
const awaitingPlan = computed(() => awaiting.value && awaiting.value.plan != null);
const awaitingBudget = computed(() => (awaiting.value && awaiting.value.budget) || null);

// Follow-up suggestions the run parked on (NOTES: trailer). The user checks the
// ones to run now; the rest are saved to the project notes.
const awaitingSuggestions = computed<string[] | null>(() =>
  awaiting.value && Array.isArray(awaiting.value.suggestions) ? awaiting.value.suggestions : null
);
const sugSel = ref<boolean[]>([]);
watch(
  awaitingSuggestions,
  (items) => {
    sugSel.value = (items || []).map(() => false);
  },
  { immediate: true }
);
const sugSelectedCount = computed(() => sugSel.value.filter(Boolean).length);
function sugSelectedItems() {
  return (awaitingSuggestions.value || []).filter((_, i) => sugSel.value[i]);
}
async function runSelectedSuggestions() {
  if (!sugSelectedCount.value) return;
  await store.resolveSuggestions(sugSelectedItems());
}
async function saveAllSuggestions() {
  await store.resolveSuggestions([]);
}

async function pick(option: string) {
  await store.followup(option);
}

// Summary label for the collapsed progress fold: the distinct tools it ran, or
// "thinking" when it was reasoning/narration only.
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
        <span v-if="store.thread.model" class="chip mono">{{ store.thread.model }}</span>
        <span class="chip mono">session {{ store.thread.session_id.slice(0, 8) }}</span>
        <span v-if="store.thread.branch" class="chip mono" title="git branch this request works on">⎇ {{ store.thread.branch }}</span>
        <button
          class="btn"
          style="margin-left: auto"
          title="Flag this request as unread so you can come back to it later"
          @click="store.markUnread(store.thread.id)"
        >
          ◦ Mark unread
        </button>
        <button
          v-if="store.thread.status === 'running'"
          class="btn stop-btn"
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

        <!-- the whole middle of the turn, folded into one collapsed block -->
        <details v-if="b.layout.progress.length" class="steps-group">
          <summary>{{ b.layout.progress.length }} step{{ b.layout.progress.length > 1 ? "s" : "" }} · {{ stepsLabel(b.layout.progress) }}</summary>
          <div class="steps-body">
            <template v-for="ev in b.layout.progress" :key="ev.id">
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
              <div v-else-if="ev.type === 'assistant_text'" class="msg assistant progress-note">
                <div class="role">claude</div>
                <div class="content">{{ ev.text }}</div>
              </div>
              <div v-else-if="ev.type === 'system' && ev.name === 'git_pull'" class="tokens git-pull">
                ⤓ git pull — {{ ev.text }}
              </div>
              <div v-else-if="ev.type === 'system' && ev.name === 'budget_warn'" class="tokens budget-warn">
                ◔ budget — {{ ev.text }}
              </div>
            </template>
          </div>
        </details>

        <!-- the result: final answer + token line -->
        <div v-if="b.layout.finalText != null" class="msg" :class="b.hasAssistantText ? 'assistant' : 'result'">
          <div class="role">{{ b.hasAssistantText ? "claude" : "result" }}</div>
          <div class="content">{{ b.layout.finalText }}</div>
        </div>
        <div class="tokens" v-if="b.layout.resultEv && tokenLine(b.layout.resultEv)">
          tokens: {{ tokenLine(b.layout.resultEv) }}
        </div>
      </template>

      <div v-if="store.thread.status === 'running'" class="tokens">
        <span class="run-dot"></span> running…
      </div>

      <!-- stopped on a cost ceiling -->
      <div v-if="awaitingBudget" class="question-card budget-card">
        <div class="q-label">◔ Paused on its cost ceiling</div>
        <div class="q-text">
          <template v-if="awaitingBudget.reason === 'run'">
            This run reached {{ money(awaitingBudget.run_cap) }} and stopped itself.
          </template>
          <template v-else>
            This thread has used its {{ money(awaitingBudget.thread_cap) }} allowance, so nothing
            was dispatched.
          </template>
          Spent on this thread so far: <b>{{ money(awaitingBudget.thread_spent) }}</b>.
        </div>
        <div class="q-options">
          <button class="q-opt approve" @click="store.raiseBudget('add', 5)">Continue +$5</button>
          <button class="q-opt" @click="store.raiseBudget('add', 20)">Continue +$20</button>
          <button
            class="q-opt"
            title="Remove both the per-run and per-thread ceilings for this thread"
            @click="store.raiseBudget('unlimited')"
          >
            No limit
          </button>
          <button class="q-opt" @click="store.raiseBudget('stop')">Leave it stopped</button>
        </div>
        <div class="tokens" style="margin-top: 8px">
          Continuing picks up the same session where it stopped — no work is lost.
        </div>
      </div>

      <!-- a plan awaiting approval -->
      <div v-else-if="awaitingPlan" class="question-card">
        <div class="q-label">◑ Plan ready for your approval</div>
        <div class="content plan-text">{{ awaiting.plan }}</div>
        <div class="q-options">
          <button class="q-opt approve" @click="store.approvePlan()">✓ Approve &amp; run</button>
          <button
            v-if="!store.thread.scheduled_approval"
            class="q-opt night"
            title="Queue this approval for the night scheduler — it resumes this session and implements the plan during the night window"
            @click="store.scheduleApprovalTonight()"
          >
            ☾ Approve &amp; run tonight
          </button>
          <button
            v-else
            class="q-opt night queued"
            title="Unschedule the night run — the plan goes back to waiting for your approval"
            @click="store.cancelScheduledApproval()"
          >
            ☾ Queued for tonight — click to unschedule
          </button>
        </div>
        <div class="tokens" style="margin-top: 8px">
          Approve to run now, queue it for the night window, or type changes below to keep planning (stays in plan mode).
        </div>
      </div>

      <!-- follow-up suggestions: run any now, save the rest to notes -->
      <div v-else-if="awaitingSuggestions" class="question-card">
        <div class="q-label">Claude suggested follow-ups — run any now?</div>
        <div style="display: flex; flex-direction: column; gap: 6px; margin: 10px 0">
          <label
            v-for="(item, i) in awaitingSuggestions"
            :key="i"
            style="display: flex; gap: 8px; align-items: flex-start; cursor: pointer"
          >
            <input type="checkbox" v-model="sugSel[i]" style="margin-top: 3px" />
            <span>{{ item }}</span>
          </label>
        </div>
        <div class="q-options">
          <button class="q-opt approve" :disabled="!sugSelectedCount" @click="runSelectedSuggestions()">
            ▶ Run selected ({{ sugSelectedCount }})
          </button>
          <button class="q-opt" @click="saveAllSuggestions()">Save all to notes</button>
        </div>
        <div class="tokens" style="margin-top: 8px">
          Checked items run now, each as its own request; the rest are saved to the project notes.
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
        <select class="model-select" v-model="followupModel" title="Model for this follow-up (and later runs of this session)">
          <option v-for="m in MODEL_OPTIONS" :key="m.value" :value="m.value">{{ m.label }}</option>
        </select>
        <span class="tokens" v-if="store.thread.status === 'running'">wait for the current run to finish</span>
        <span class="tokens" v-else>Ctrl/⌘+Enter</span>
      </div>
    </div>
  </div>

  <div class="detail-pane" v-else>
    <div class="empty">Select a request, or start a new one above.</div>
  </div>
</template>
