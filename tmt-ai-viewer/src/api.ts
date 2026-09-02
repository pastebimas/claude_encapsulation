async function req(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) throw { unauthorized: true };
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${res.status}`);
  return res.json();
}

export const api = {
  me: () => req("/api/me"),
  login: (password: string) =>
    req("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req("/api/logout", { method: "POST" }),

  projects: () => req("/api/projects"),
  projectStatus: (project: string) =>
    req(`/api/project_status?project=${encodeURIComponent(project)}`),
  context: (project: string) => req(`/api/context?project=${encodeURIComponent(project)}`),
  notes: (project: string) => req(`/api/notes?project=${encodeURIComponent(project)}`),
  addNote: (project: string, body: string, title = "") =>
    req("/api/notes", { method: "POST", body: JSON.stringify({ project, body, title }) }),
  updateNote: (project: string, id: number, fields: { body?: string; title?: string }) =>
    req("/api/notes/update", { method: "POST", body: JSON.stringify({ project, id, ...fields }) }),
  usage: () => req("/api/usage"),
  limits: () => req("/api/limits"),

  scheduled: () => req("/api/scheduled"),
  addScheduled: (project: string, prompt: string, agents = 1) =>
    req("/api/scheduled", { method: "POST", body: JSON.stringify({ project, prompt, agents }) }),
  updateScheduled: (id: string, fields: any) =>
    req(`/api/scheduled/${id}`, { method: "PATCH", body: JSON.stringify(fields) }),
  deleteScheduled: (id: string) => req(`/api/scheduled/${id}`, { method: "DELETE" }),
  reorderScheduled: (ids: string[]) =>
    req("/api/scheduled/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
  runScheduled: (id: string, agents?: number) =>
    req(`/api/scheduled/${id}/run`, {
      method: "POST",
      body: JSON.stringify(agents === undefined ? {} : { agents }),
    }),
  schedulerConfig: () => req("/api/scheduler/config"),
  saveSchedulerConfig: (patch: any) =>
    req("/api/scheduler/config", { method: "PUT", body: JSON.stringify(patch) }),

  threads: (project: string) => req(`/api/threads?project=${encodeURIComponent(project)}`),
  newThread: (project: string, prompt: string, plan = false, model = "", direct = false, branch = "") =>
    req("/api/threads", {
      method: "POST",
      body: JSON.stringify({ project, prompt, plan, model, direct, branch }),
    }),
  thread: (id: string) => req(`/api/thread?id=${encodeURIComponent(id)}`),
  threadRaw: (id: string) => req(`/api/thread/raw?id=${encodeURIComponent(id)}`),
  followup: (id: string, prompt: string, plan?: boolean, model?: string) =>
    req("/api/thread/followup", {
      method: "POST",
      body: JSON.stringify({
        id,
        prompt,
        ...(plan === undefined ? {} : { plan }),
        ...(model === undefined ? {} : { model }),
      }),
    }),
  threadBudget: (
    id: string,
    mode: "add" | "unlimited" | "stop" | "compact",
    amount?: number
  ) =>
    req("/api/thread/budget", {
      method: "POST",
      body: JSON.stringify({ id, mode, ...(amount === undefined ? {} : { amount }) }),
    }),
  stopThread: (id: string) =>
    req("/api/thread/stop", { method: "POST", body: JSON.stringify({ id }) }),
  scheduleApproval: (id: string) =>
    req("/api/thread/schedule_approval", { method: "POST", body: JSON.stringify({ id }) }),
  markRead: (id: string) =>
    req("/api/thread/read", { method: "POST", body: JSON.stringify({ id }) }),
  markUnread: (id: string) =>
    req("/api/thread/unread", { method: "POST", body: JSON.stringify({ id }) }),
  events: (id: string, since: number) =>
    req(`/api/thread/events?id=${encodeURIComponent(id)}&since=${since}`),

  gitBranches: (project: string) =>
    req(`/api/git/branches?project=${encodeURIComponent(project)}`),
  gitBranchesAll: () => req(`/api/git/branches/all`),
  gitDiff: (project: string, opts: { branch?: string; commit?: string }) =>
    req(
      `/api/git/diff?project=${encodeURIComponent(project)}&` +
        (opts.commit
          ? `commit=${encodeURIComponent(opts.commit)}`
          : `branch=${encodeURIComponent(opts.branch || "")}`)
    ),
};

export function openStream(id: string, since: number, onMessage: (m: any) => void): EventSource {
  const es = new EventSource(`/api/thread/stream?id=${encodeURIComponent(id)}&since=${since}`);
  es.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch {
      /* ignore keepalive */
    }
  };
  return es;
}
