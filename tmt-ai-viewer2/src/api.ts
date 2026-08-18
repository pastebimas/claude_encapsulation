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

  threads: (project: string) => req(`/api/threads?project=${encodeURIComponent(project)}`),
  newThread: (project: string, prompt: string) =>
    req("/api/threads", { method: "POST", body: JSON.stringify({ project, prompt }) }),
  thread: (id: string) => req(`/api/thread?id=${encodeURIComponent(id)}`),
  threadRaw: (id: string) => req(`/api/thread/raw?id=${encodeURIComponent(id)}`),
  followup: (id: string, prompt: string) =>
    req("/api/thread/followup", { method: "POST", body: JSON.stringify({ id, prompt }) }),
  events: (id: string, since: number) =>
    req(`/api/thread/events?id=${encodeURIComponent(id)}&since=${since}`),
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
