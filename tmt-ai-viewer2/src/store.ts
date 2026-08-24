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

  // -- list ordering / filtering (persisted) --
  const projectSort = ref(localStorage.getItem("tmt2-project-sort") || "recent"); // 'recent' | 'alpha'
  const threadSort = ref(localStorage.getItem("tmt2-thread-sort") || "recent"); // 'recent' | 'newest' | 'oldest'
  const unreadOnly = ref(localStorage.getItem("tmt2-unread-only") === "1");

  const thread = ref<any>(null);
  const turns = ref<any[]>([]);
  const events = ref<any[]>([]);
  const maxSeq = ref(0);

  const usage = ref<any>({ windows: {} });
  const limits = ref<any>({ available: false });
  const containers = ref<any[]>([]);
  const notes = ref<any[]>([]);
  const context = ref<any>({ files: [] });

  const scheduled = ref<any[]>([]);
  const schedulerCfg = ref<any>(null);
  const schedulerDecision = ref<any>(null);

  const panel = ref<string | null>(null); // 'notes' | 'context' | 'scheduler' | 'branches'
  const gitInfo = ref<any>({ available: false, is_repo: false, branches: [] });
  const gitScope = ref<"project" | "all">("project"); // Branches panel scope
  const gitAll = ref<any>({ projects: [], loading: false }); // all-projects branches
  const detailTab = ref<"conversation" | "raw">("conversation");
  const rawData = ref<any>(null);

  let stream: EventSource | null = null;
  let threadsTimer: any = null;
  let usageTimer: any = null;

  const anyRunning = computed(() => threads.value.some((t) => t.status === "running"));

  const unreadCount = computed(() => threads.value.filter((t) => t.unread).length);

  // Projects (sidebar), ordered by the chosen sort. 'recent' = most recent
  // activity first (last_ts); 'alpha' = by name. Projects with no activity yet
  // (mounts without threads) fall to the bottom in 'recent'.
  const sortedProjects = computed(() => {
    const list = projects.value.slice();
    if (projectSort.value === "alpha") {
      list.sort((a, b) =>
        (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
      );
    } else {
      list.sort((a, b) => (b.last_ts || "").localeCompare(a.last_ts || ""));
    }
    return list;
  });

  // The request list ThreadList renders: filtered by the unread toggle, then
  // ordered by the chosen sort. 'recent' = most recent response/activity
  // (updated_at); 'newest'/'oldest' = by creation time. The currently-open
  // thread is always kept visible so it doesn't vanish when marked read.
  const sortedThreads = computed(() => {
    let list = threads.value.slice();
    if (unreadOnly.value)
      list = list.filter((t) => t.unread || t.id === currentThreadId.value);
    if (threadSort.value === "newest") {
      list.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    } else if (threadSort.value === "oldest") {
      list.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
    } else {
      list.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    }
    return list;
  });

  function setProjectSort(mode: string) {
    projectSort.value = mode;
    localStorage.setItem("tmt2-project-sort", mode);
  }
  function setThreadSort(mode: string) {
    threadSort.value = mode;
    localStorage.setItem("tmt2-thread-sort", mode);
  }
  function toggleUnreadOnly() {
    unreadOnly.value = !unreadOnly.value;
    localStorage.setItem("tmt2-unread-only", unreadOnly.value ? "1" : "0");
  }

  async function markUnread(id: string) {
    await api.markUnread(id);
    const t = threads.value.find((x) => x.id === id);
    if (t) t.unread = 1;
    await loadProjects();
  }
  async function markRead(id: string) {
    await api.markRead(id);
    const t = threads.value.find((x) => x.id === id);
    if (t) t.unread = 0;
    await loadProjects();
  }

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
    try {
      limits.value = await api.limits();
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

  async function submit(prompt: string, plan = false, model = "") {
    if (!currentProject.value || !prompt.trim()) return;
    const r = await api.newThread(currentProject.value, prompt.trim(), plan, model);
    await loadThreads();
    await openThread(r.thread_id);
  }

  // Load a thread's full state (thread + turns + events) into the open detail
  // view. Used both when opening a thread and after a follow-up, so the new
  // user turn is present before its response events stream in.
  function applyThreadData(r: any) {
    thread.value = r.thread;
    thread.value.awaiting = parseAwaiting(r.thread.awaiting_json);
    turns.value = r.turns;
    events.value = r.events;
    maxSeq.value = r.events.length ? r.events[r.events.length - 1].seq : 0;
  }

  async function openThread(id: string) {
    currentThreadId.value = id;
    detailTab.value = "conversation";
    rawData.value = null;
    closeStream();
    const r = await api.thread(id);
    applyThreadData(r);
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

  async function followup(prompt: string, plan?: boolean, model?: string) {
    if (!currentThreadId.value || !prompt.trim()) return;
    const id = currentThreadId.value;
    await api.followup(id, prompt.trim(), plan, model);
    // Re-fetch the thread so the new user turn appears immediately. Without this
    // store.turns stays stale and the streamed response events — grouped by a
    // turn_id not in store.turns — never render until the thread is reopened.
    const r = await api.thread(id);
    applyThreadData(r);
    if (thread.value) {
      thread.value.status = "running";
      thread.value.awaiting = null;
    }
    await loadThreads();
    startStream();
  }
  // Approve a plan: resume the session with plan mode OFF so it executes.
  async function approvePlan() {
    await followup("The plan is approved. Proceed and implement it.", false);
  }
  async function stop() {
    if (!currentThreadId.value) return;
    await api.stopThread(currentThreadId.value);
  }

  async function loadRaw() {
    if (!currentThreadId.value) return;
    rawData.value = await api.threadRaw(currentThreadId.value);
  }

  async function openPanel(which: string) {
    panel.value = which;
    if (which === "notes") notes.value = (await api.notes(currentProject.value!)).notes;
    if (which === "context") context.value = await api.context(currentProject.value!);
    if (which === "scheduler") {
      await loadScheduled();
      await loadSchedulerConfig();
    }
    if (which === "branches")
      await (gitScope.value === "all" ? loadAllGitBranches() : loadGitBranches());
  }
  function closePanel() {
    panel.value = null;
  }

  async function loadGitBranches() {
    if (!currentProject.value) return;
    try {
      gitInfo.value = await api.gitBranches(currentProject.value);
    } catch {
      gitInfo.value = { available: false, is_repo: false, branches: [] };
    }
  }
  async function loadAllGitBranches() {
    gitAll.value = { projects: [], loading: true };
    try {
      const r = await api.gitBranchesAll();
      gitAll.value = { projects: r.projects || [], loading: false };
    } catch {
      gitAll.value = { projects: [], loading: false };
    }
  }
  async function setGitScope(scope: "project" | "all") {
    if (gitScope.value === scope) return;
    gitScope.value = scope;
    await (scope === "all" ? loadAllGitBranches() : loadGitBranches());
  }
  // project is required in all-projects mode; defaults to the open project.
  function loadDiff(opts: { branch?: string; commit?: string }, project?: string) {
    return api.gitDiff(project || currentProject.value!, opts);
  }

  async function loadScheduled() {
    scheduled.value = (await api.scheduled()).tasks;
  }
  async function loadSchedulerConfig() {
    const r = await api.schedulerConfig();
    schedulerCfg.value = r.config;
    schedulerDecision.value = r.decision;
  }
  async function saveSchedulerConfig(patch: any) {
    const r = await api.saveSchedulerConfig(patch);
    schedulerCfg.value = r.config;
    schedulerDecision.value = r.decision;
  }
  async function addScheduled(project: string, prompt: string, agents: number) {
    await api.addScheduled(project, prompt, agents);
    await loadScheduled();
  }
  async function updateScheduled(id: string, fields: any) {
    await api.updateScheduled(id, fields);
    await loadScheduled();
  }
  async function deleteScheduled(id: string) {
    await api.deleteScheduled(id);
    await loadScheduled();
  }
  async function reorderScheduled(ids: string[]) {
    await api.reorderScheduled(ids);
    await loadScheduled();
  }
  async function runScheduled(id: string, agents?: number) {
    const r = await api.runScheduled(id, agents);
    await loadScheduled();
    if (r.thread_id) {
      panel.value = null;
      await loadThreads();
      await openThread(r.thread_id);
    }
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
    projectSort, threadSort, unreadOnly, sortedProjects, sortedThreads, unreadCount,
    thread, turns, events, usage, limits, containers, notes, context,
    scheduled, schedulerCfg, schedulerDecision,
    panel, gitInfo, gitScope, gitAll, detailTab, rawData, anyRunning,
    init, doLogin, doLogout, toggleTheme,
    setProjectSort, setThreadSort, toggleUnreadOnly, markUnread, markRead,
    loadProjects, selectProject, loadThreads, loadStatus,
    submit, openThread, followup, approvePlan, stop, loadRaw,
    openPanel, closePanel, loadGitBranches, loadAllGitBranches, setGitScope, loadDiff,
    addNote, updateNote, runNoteLine,
    loadScheduled, loadSchedulerConfig, saveSchedulerConfig,
    addScheduled, updateScheduled, deleteScheduled, reorderScheduled, runScheduled,
  };
});
