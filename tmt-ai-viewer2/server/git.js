// Shared git plumbing run inside tmt-ai-code via the docker-socket-proxy.
// Used by both the dashboard run path (routes.js/claude.js) and the external
// task-dispatch API (taskApi.js): create/checkout a per-request branch, set a
// local bot identity so the later commit works (the container has no global git
// identity), and read back branch/commit/diff info for the dashboard panel.
import { CODE_CONTAINER, execCollect, resolveExecUser } from "./docker.js";

const GIT_NAME = process.env.TASK_GIT_NAME || "tmt-ai";
const GIT_EMAIL = process.env.TASK_GIT_EMAIL || "tmt-ai@localhost";

// git's canonical empty-tree object — the base for diffing a root-based branch
// (a branch whose oldest commit has no parent).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Only names we ourselves generate / that map to a real mount. Guards the
// values we interpolate into `sh -c` scripts below against injection.
const SAFE_PROJECT = /^[A-Za-z0-9._-]+$/;
const SAFE_BRANCH = /^claude\/[A-Za-z0-9._/-]+$/;
// Broader than SAFE_BRANCH (which is claude/* only, for the read side): the run
// path also creates task/* branches. Injection-safe (no quotes/spaces/;).
const SAFE_REF = /^(claude|task)\/[A-Za-z0-9._/-]+$/;
const SAFE_SHA = /^[0-9a-fA-F]{4,40}$/;

const FS = "\x1f"; // field separator for the branch-info script (unit separator)
const DIFF_CAP = 200_000; // bytes of diff text returned to the browser

export function slug(s, max = 60) {
  const out = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, max)
    .replace(/[-._]+$/g, "");
  return out || "x";
}

// A stable, unique-per-request branch name: readable slug + a short slice of the
// thread uuid so two requests with the same title never collide.
export function branchNameFor(title, id) {
  const short = String(id || "").replace(/-/g, "").slice(0, 6) || "000000";
  return `claude/${slug(title, 40)}-${short}`;
}

// The instruction appended to a branched dashboard/scheduler prompt. Mirrors the
// task-API convention: stay on the branch, commit locally, never push.
export function branchPromptNote(branch) {
  return (
    `All work for this request must stay on the git branch \`${branch}\`, which is already` +
    " checked out for you. Do not switch to, create, or merge other branches, and do NOT push." +
    ` When you have made changes, commit them locally to \`${branch}\` with a clear message.` +
    " If you are in plan mode, make committing to this branch the FINAL step of your plan." +
    " If you only investigated and changed nothing, no commit is needed."
  );
}

// The instruction for a "no commits" (direct) run: edit the current working
// tree in place, leave everything uncommitted for the user.
export function directPromptNote() {
  return (
    "Work directly in the project's current working tree and branch. Do NOT" +
    " create, switch, or delete git branches, do NOT commit, and do NOT push —" +
    " leave all changes uncommitted for the user to review and commit themselves."
  );
}

export function git(project, args, user) {
  return execCollect(CODE_CONTAINER, ["git", "-C", `/workspace/${project}`, ...args], {
    user,
    deadlineMs: 30_000,
  });
}

// Confirm repo, set a local bot identity if none (needed for the later commit),
// then create the branch *ref* (no checkout — the run works in its own
// worktree, so the main working tree is never switched). Returns { ok, error }.
export async function ensureBranchRef(project, branch, user) {
  if (!SAFE_PROJECT.test(project)) return { ok: false, code: 400, error: "bad_project" };
  if (!SAFE_REF.test(branch)) return { ok: false, code: 400, error: "bad_branch" };
  try {
    const repo = await git(project, ["rev-parse", "--is-inside-work-tree"], user);
    if (repo.exitCode !== 0 || repo.stdout.trim() !== "true")
      return { ok: false, code: 422, error: "not_a_git_repo" };

    if (!(await git(project, ["config", "--get", "user.email"], user)).stdout.trim())
      await git(project, ["config", "user.email", GIT_EMAIL], user);
    if (!(await git(project, ["config", "--get", "user.name"], user)).stdout.trim())
      await git(project, ["config", "user.name", GIT_NAME], user);

    const exists =
      (await git(project, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], user))
        .exitCode === 0;
    if (!exists) {
      const cr = await git(project, ["branch", branch], user);
      if (cr.exitCode !== 0)
        return { ok: false, code: 500, error: "branch_failed", detail: (cr.stderr || "").trim() };
    }
    return { ok: true, reused: exists };
  } catch (e) {
    return { ok: false, code: 500, error: "git_error", detail: e.message };
  }
}

// ---- per-request git worktrees --------------------------------------------
// Each run works in its own linked worktree so concurrent same-project runs
// never share a checkout (no branch thrash, no interleaved edits). Worktrees
// live at /workspace/<project>/.tmt-worktrees/<branch-tail> — one level under
// the project so the proxy's `/workspace/<name>` DB-routing still resolves
// <name> (it captures only the first path segment). Branch refs and commits
// live in the shared .git and survive worktree removal.
const WORKTREES_DIR = ".tmt-worktrees";
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const worktreeTail = (branch) => branch.replace(/\//g, "__").replace(/[^A-Za-z0-9._-]/g, "-");

// Add (or reuse) a worktree checked out to `branch`; returns its absolute path
// to run in. On any failure returns { ok:false } so the caller falls back to
// the main tree. Never throws.
export async function ensureWorktree(project, branch, user) {
  if (!SAFE_PROJECT.test(project) || !SAFE_REF.test(branch))
    return { ok: false, error: "bad_args" };
  const wt = `${WORKTREES_DIR}/${worktreeTail(branch)}`;
  const excl = `${WORKTREES_DIR}/`;
  const script =
    `cd "/workspace/${project}" 2>/dev/null || { echo NOREPO; exit 0; }; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo NOREPO; exit 0; }; ` +
    `[ -n "$(git config --get user.email)" ] || git config user.email ${sq(GIT_EMAIL)}; ` +
    `[ -n "$(git config --get user.name)" ] || git config user.name ${sq(GIT_NAME)}; ` +
    `mkdir -p .git/info; grep -qxF ${sq(excl)} .git/info/exclude 2>/dev/null || echo ${sq(excl)} >> .git/info/exclude; ` +
    `git worktree prune >/dev/null 2>&1; ` +
    `abs="$(pwd)/${wt}"; ` +
    `if git worktree list --porcelain | grep -qxF "worktree $abs"; then echo "REUSED $abs"; exit 0; fi; ` +
    `[ -e "${wt}" ] && rm -rf "${wt}"; ` +
    `git show-ref --verify --quiet "refs/heads/${branch}" || git branch "${branch}" >/dev/null 2>&1; ` +
    `[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "${branch}" ] && git checkout --detach >/dev/null 2>&1; ` +
    `if git worktree add "${wt}" "${branch}" >/dev/null 2>&1; then echo "OK $abs"; else echo ERR; fi`;
  try {
    const { stdout } = await execCollect(CODE_CONTAINER, ["sh", "-c", script], { user });
    const line = (stdout.trim().split("\n").pop() || "").trim();
    const sp = line.indexOf(" ");
    const tag = sp === -1 ? line : line.slice(0, sp);
    const path = sp === -1 ? "" : line.slice(sp + 1);
    if (tag === "NOREPO") return { ok: false, error: "not_a_git_repo" };
    if ((tag === "OK" || tag === "REUSED") && path)
      return { ok: true, path, reused: tag === "REUSED" };
    return { ok: false, error: "worktree_failed" };
  } catch (e) {
    return { ok: false, error: "git_error", detail: e.message };
  }
}

// Drop a run's worktree (branch + commits are preserved in .git). Best effort.
export async function removeWorktree(project, branch, user) {
  if (!SAFE_PROJECT.test(project) || !SAFE_REF.test(branch)) return;
  const wt = `${WORKTREES_DIR}/${worktreeTail(branch)}`;
  const script =
    `cd "/workspace/${project}" 2>/dev/null || exit 0; ` +
    `git worktree remove --force "${wt}" >/dev/null 2>&1; ` +
    `git worktree prune >/dev/null 2>&1`;
  try {
    await execCollect(CODE_CONTAINER, ["sh", "-c", script], { user });
  } catch {
    /* best effort */
  }
}

// Boot-time cleanup. Non-destructive by design: only drop stale admin entries
// whose worktree dir is already gone. Existing worktrees are preserved so no
// uncommitted work (e.g. an `awaiting` thread paused mid-edit across a restart)
// is ever lost — per-run removeWorktree reclaims them on completion. A truly
// orphaned dir can linger, which is a safe disk cost. Best effort.
export async function pruneWorktrees(project, user) {
  if (!SAFE_PROJECT.test(project)) return;
  const script =
    `cd "/workspace/${project}" 2>/dev/null || exit 0; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0; ` +
    `git worktree prune >/dev/null 2>&1`;
  try {
    await execCollect(CODE_CONTAINER, ["sh", "-c", script], { user });
  } catch {
    /* best effort */
  }
}

// -- read-only inspection for the dashboard Branches panel -------------------

// One shell round-trip: current branch, dirty count, remote, and for every
// claude/* branch its unpushed-commit count, latest commit, and the unpushed
// commits themselves (capped). Tagged, 0x1f-delimited lines.
export async function gitBranchInfo(project) {
  if (!SAFE_PROJECT.test(project)) return { available: false, is_repo: false, branches: [] };
  const user = await resolveExecUser();
  const script =
    `cd "/workspace/${project}" 2>/dev/null || { echo NOREPO; exit 0; }; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo NOREPO; exit 0; }; ` +
    `printf 'CURRENT\\037%s\\n' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"; ` +
    `printf 'DIRTY\\037%s\\n' "$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"; ` +
    `printf 'REMOTE\\037%s\\n' "$(git remote 2>/dev/null | head -n1)"; ` +
    `git for-each-ref --format='%(refname:short)' refs/heads/claude/ 2>/dev/null | while IFS= read -r b; do ` +
    `[ -n "$b" ] || continue; ` +
    `up=$(git rev-list --count "$b" --not --remotes 2>/dev/null); ` +
    `printf 'BRANCH\\037%s\\037%s\\n' "$b" "$up"; ` +
    `git log -1 --format='LAST%x1f'"$b"'%x1f%h%x1f%s%x1f%cI' "$b" 2>/dev/null; ` +
    `git log --format='COMMIT%x1f'"$b"'%x1f%h%x1f%s%x1f%cI' "$b" --not --remotes 2>/dev/null | head -n 50; ` +
    `done`;

  let stdout = "";
  try {
    ({ stdout } = await execCollect(CODE_CONTAINER, ["sh", "-c", script], { user }));
  } catch (e) {
    return { available: false, is_repo: false, reason: e.message, branches: [] };
  }
  if (stdout.trim() === "NOREPO") return { available: true, is_repo: false, branches: [] };

  const map = new Map();
  const info = { available: true, is_repo: true, current: "", dirty: 0, remote: "", branches: [] };
  const ensure = (name) => {
    let b = map.get(name);
    if (!b) {
      b = { name, unpushed: 0, last: null, commits: [] };
      map.set(name, b);
      info.branches.push(b);
    }
    return b;
  };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const p = line.split(FS);
    switch (p[0]) {
      case "CURRENT":
        info.current = p[1] || "";
        break;
      case "DIRTY":
        info.dirty = parseInt(p[1] || "0", 10) || 0;
        break;
      case "REMOTE":
        info.remote = p[1] || "";
        break;
      case "BRANCH":
        ensure(p[1]).unpushed = parseInt(p[2] || "0", 10) || 0;
        break;
      case "LAST":
        ensure(p[1]).last = { sha: p[2], subject: p[3], date: p[4] };
        break;
      case "COMMIT":
        ensure(p[1]).commits.push({ sha: p[2], subject: p[3], date: p[4] });
        break;
    }
  }
  // Most-recently-touched branch first.
  info.branches.sort((a, b) => (b.last?.date || "").localeCompare(a.last?.date || ""));
  return info;
}

const capDiff = (s) =>
  s && s.length > DIFF_CAP ? s.slice(0, DIFF_CAP) + "\n… (diff truncated)" : s || "";

// Diff for a whole branch's unpushed range (branch) or a single commit (commit).
export async function gitDiff(project, { branch, commit } = {}) {
  if (!SAFE_PROJECT.test(project)) return { available: false, diff: "" };
  const user = await resolveExecUser();

  if (commit) {
    if (!SAFE_SHA.test(commit)) return { available: false, diff: "" };
    const r = await git(project, ["show", "--stat", "--patch", commit], user);
    return { available: r.exitCode === 0, commit, diff: capDiff(r.stdout) };
  }

  if (!SAFE_BRANCH.test(branch || "")) return { available: false, diff: "" };
  // Base = parent of the oldest unpushed commit; empty when nothing is unpushed.
  const rl = await git(project, ["rev-list", branch, "--not", "--remotes"], user);
  const shas = rl.stdout.split("\n").filter(Boolean);
  if (!shas.length) return { available: true, branch, base: null, diff: "" };
  const oldest = shas[shas.length - 1];
  const pr = await git(project, ["rev-parse", "--verify", "--quiet", `${oldest}^`], user);
  const base = pr.stdout.trim() || EMPTY_TREE;
  const d = await git(project, ["diff", base, branch], user);
  return { available: d.exitCode === 0, branch, base, diff: capDiff(d.stdout) };
}
