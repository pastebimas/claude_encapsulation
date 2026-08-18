import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api, openStream } from "./api";

export const useStore = defineStore("main", () => {
  // -- auth / chrome
  const ready = ref(false);
  const authEnabled = ref(false);
  const authed = ref(false);
  const theme = ref(localStorage.getItem("tmt2-theme") || "dark");

  // -- data
  const projects = ref<any[]>([]);
  const currentProject = ref<string | null>(null);
  const threads = ref<any[]>([]);
  const currentThreadId = ref<string | null>(null);

  const thread = ref<any>(null);
  const turns = ref<any[]>([]);
  const events = ref<any[]>([]);
  const maxSeq = ref(0);

  const usage = ref<any>({ windows: {} });
  const containers = ref<any[]>([]);
  const notes = ref<any[]>([]);
  const context = ref<any>({ files: [] });

  const panel = ref<string | null>(null); // 'notes' | 'context'
  const detailTab = ref<"conversation" | "raw">("conversation");
  const rawData = ref<any>(null);

  let stream: EventSource | null = null;
  let threadsTimer: any = null;
  let usageTimer: any = null;

  const anyRunning = computed(() => threads.value.some((t) => t.status === "running"));

  function parseAwaiting(json: string | null | undefined) {
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  function applyTheme() {
    document.documentElement.classList.toggle("light", theme.value === "light");
  }
  function toggleTheme() {
    theme.value = theme.value === "light" ? "dark" : "light";
    localStorage.setItem("tmt2-theme", theme.value);
    applyTheme();
  }

  async function init() {
    applyTheme();
    const me = await api.me();
    authEnabled.value = me.auth_enabled;
    authed.value = me.authed;
    ready.value = true;
    if (authed.value) await afterLogin();
  }

  async function doLogin(password: string) {
    await api.login(password);
    authed.value = true;
    await afterLogin();
  }
  async function doLogout() {
    await api.logout();
    authed.value = false;
    stopTimers();
  }

  async function afterLogin() {
    await loadProjects();
    await loadUsage();
    usageTimer = setInterval(loadUsage, 30000);
    if (projects.value.length && !currentProject.value)
      await selectProject(projects.value[0].name);
  }

  function stopTimers() {
    clearInterval(threadsTimer);
    clearInterval(usageTimer);
    closeStream();
  }

  async function loadProjects() {
    const r = await api.projects();
    projects.value = r.projects;
  }
  async function loadUsage() {
    try {
      usage.value = await api.usage();
    } catch {
      /* ignore */
    }
  }

  async function selectProject(name: string) {
    currentProject.value = name;
    currentThreadId.value = null;
    thread.value = null;
    events.value = [];
    turns.value = [];
    closeStream();
    await loadThreads();
    loadStatus();
    // poll threads to keep run badges fresh
    clearInterval(threadsTimer);
    threadsTimer = setInterval(async () => {
      await loadThreads();
      await loadProjects();
    }, 4000);
  }

  async function loadThreads() {
    if (!currentProject.value) return;
    const r = await api.threads(currentProject.value);
    threads.value = r.threads;
  }

  async function loadStatus() {
    if (!currentProject.value) return;
    try {
      const r = await api.projectStatus(currentProject.value);
      containers.value = r.containers || [];
    } catch {
      containers.value = [];
    }
  }

  async function submit(prompt: string) {
    if (!currentProject.value || !prompt.trim()) return;
    const r = await api.newThread(currentProject.value, prompt.trim());
    await loadThreads();
    await openThread(r.thread_id);
  }

  async function openThread(id: string) {
    currentThreadId.value = id;
    detailTab.value = "conversation";
    rawData.value = null;
    closeStream();
    const r = await api.thread(id);
    thread.value = r.thread;
    thread.value.awaiting = parseAwaiting(r.thread.awaiting_json);
    turns.value = r.turns;
    events.value = r.events;
    maxSeq.value = r.events.length ? r.events[r.events.length - 1].seq : 0;
    // mark read locally
    const t = threads.value.find((x) => x.id === id);
    if (t) t.unread = 0;
    if (r.thread.status === "running") startStream();
  }

  function startStream() {
    if (!currentThreadId.value) return;
    closeStream();
    stream = openStream(currentThreadId.value, maxSeq.value, (m) => {
      if (m.t === "event") {
        if (m.event.seq > maxSeq.value) {
          events.value.push(m.event);
          maxSeq.value = m.event.seq;
        }
      } else if (m.t === "status") {
        if (thread.value) {
          thread.value.status = m.status;
          if (m.status !== "awaiting") thread.value.awaiting = null;
        }
        loadThreads();
      } else if (m.t === "awaiting") {
        if (thread.value) {
          thread.value.status = "awaiting";
          thread.value.awaiting = m.awaiting;
        }
        loadThreads();
      } else if (m.t === "done") {
        closeStream();
        loadThreads();
      }
    });
  }
  function closeStream() {
    if (stream) {
      stream.close();
      stream = null;
    }
  }

  async function followup(prompt: string) {
    if (!currentThreadId.value || !prompt.trim()) return;
    await api.followup(currentThreadId.value, prompt.trim());
    if (thread.value) {
      thread.value.status = "running";
      thread.value.awaiting = null;
    }
    await loadThreads();
    startStream();
  }

  async function loadRaw() {
    if (!currentThreadId.value) return;
    rawData.value = await api.threadRaw(currentThreadId.value);
  }

  async function openPanel(which: string) {
    panel.value = which;
    if (which === "notes") notes.value = (await api.notes(currentProject.value!)).notes;
    if (which === "context") context.value = await api.context(currentProject.value!);
  }
  function closePanel() {
    panel.value = null;
  }
  async function addNote(body: string) {
    await api.addNote(currentProject.value!, body);
    notes.value = (await api.notes(currentProject.value!)).notes;
  }
  async function updateNote(id: number, fields: { body?: string; title?: string }) {
    await api.updateNote(currentProject.value!, id, fields);
    notes.value = (await api.notes(currentProject.value!)).notes;
  }
  // Dispatch a single checklist line as its own new thread in this project.
  async function runNoteLine(text: string) {
    if (!text.trim()) return;
    panel.value = null;
    await submit(text.trim());
  }

  return {
    ready, authEnabled, authed, theme,
    projects, currentProject, threads, currentThreadId,
    thread, turns, events, usage, containers, notes, context,
    panel, detailTab, rawData, anyRunning,
    init, doLogin, doLogout, toggleTheme,
    loadProjects, selectProject, loadThreads, loadStatus,
    submit, openThread, followup, loadRaw,
    openPanel, closePanel, addNote, updateNote, runNoteLine,
  };
});
