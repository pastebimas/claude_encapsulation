# tmt-ai — Claude Code in a container, with per-project logging

Run [Claude Code](https://docs.claude.com/en/docs/claude-code) inside a
single long-lived Docker container against any number of host projects.
Every Anthropic API request is logged to a per-project SQLite DB and
browsable in Datasette.

## Requirements

- Docker + Docker Compose
- A Claude account (you'll log in on first run)

## Quick start

```bash
git clone <this repo>
cd tmt-ai

# 1. List the host folders you want to expose to the container.
cp compose.override.yml.example compose.override.yml
Add your projects paths to compose.override.yml

# 2. Build and start (USER_UID keeps file ownership sane).
USER_UID=$(id -u) USER_GID=$(id -g) docker compose up -d --build

# 3. Put the launcher on PATH.
ln -s "$PWD/bin/tmt_ai" /usr/local/bin/tmt_ai    # add sudo if needed

# 4. Log into Claude once. Pick any project name you mapped.
tmt_ai my-app
```

Credentials are stored in `claude-config/` and reused after that.

## Daily use

```bash
tmt_ai                  # opens claude in /workspace/tmt (default)
tmt_ai my-app           # opens claude in /workspace/my-app
tmt_ai my-app --resume  # extra args go to claude
tmt_ai -s my-app        # bash shell instead of claude
tmt_ai -l               # list mounted projects
tmt_ai -h               # help
```

Dashboard: <http://localhost:8035> — dispatch Claude runs per project,
watch the live conversation (streamed), read/unread tracking, per-project
docker status and CLAUDE.md/context viewer. Notes are interactive
checklists (toggle todo/doing/done, run a line as its own run), and a run
can pause to ask a clarifying question you answer inline (it resumes the
same session).

Every request runs on its own git branch (`claude/<slug>-<id>`); Claude
commits its changes to that branch locally (it never pushes — the container
has no push credentials). The **Branches** panel lists each project's
`claude/*` branches with their unpushed commit counts, a link back to the
request that made them, and a clickable diff per branch/commit — so you can
see what still needs pushing. Push them from the host (see below).

Raw SQL: <http://localhost:8001> (Datasette, bound to 127.0.0.1 only).
Each project gets its own DB in the sidebar. Datasette only scans
`*.db` files at startup — restart it after creating logs for a
brand-new project:

```bash
docker compose restart tmt-ai-datasette
```

## Task-dispatch API

An external system (issue tracker, PM tool) can POST a task and have it
auto-start a **plan-mode** run scoped to a fresh git branch. It runs on its
own port (default `8036`), separate from the password-gated dashboard, with
its own **API token + IP allowlist**. Off unless `TASK_API_TOKEN` is set.

```bash
curl -X POST http://127.0.0.1:8036/task \
  -H "Authorization: Bearer $TASK_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project":"my-app","id":"T-123","name":"Add health endpoint",
       "description":"Expose GET /health returning 200.",
       "comments":["must not require auth"]}'
```

Flow: the project must be currently mounted (`tmt_ai -l`) — if not, the call
returns `404 project_not_found` and nothing is created. Otherwise it creates
branch `task/<id>-<name>`, starts a plan-mode run, and returns
`{thread_id, branch, status:"planning"}`. The plan appears in the dashboard for
approval; on approval the run implements it and **commits to that branch**
(local commit only — push from the host). Repeating the same `id` is
idempotent (returns the existing thread). Poll `GET /task/<id>?project=<p>`.

Environment (in `.env` next to `compose.yml`):

| Var | Purpose |
| --- | --- |
| `TASK_API_TOKEN` | **required** bearer token; unset → API disabled |
| `TASK_API_PORT` | host/container port (default `8036`) |
| `TASK_API_BIND` | host interface to publish on (default `127.0.0.1` = same-server only; `0.0.0.0` or a LAN/tailnet IP to reach it from other machines) |
| `TASK_API_IP_ALLOWLIST` | comma-separated IPs/CIDRs; empty → token-only |
| `TASK_API_TRUST_PROXY` | `1` → read client IP from `X-Forwarded-For` |
| `TASK_API_ONE_AT_A_TIME` | `1` → reject a task while the project has an active run |
| `TASK_GIT_NAME` / `TASK_GIT_EMAIL` | identity used for the commit (default `tmt-ai`) |
| `DASHBOARD_URL` | optional; included in responses as a convenience link |

**Exposing it:** by default the port is published on `127.0.0.1` only, so it is
reachable **only from the same server** — not from other machines. Two ways to
go wider:

- **TLS proxy on the same host (recommended):** keep the default bind and put
  your own TLS tunnel / reverse proxy (Cloudflare Tunnel, nginx, Caddy,
  `tailscale serve`) in front, forwarding to `127.0.0.1:8036`. Set
  `TASK_API_TRUST_PROXY=1` so the IP allowlist matches the real client.
- **Reach it from another machine directly:** set `TASK_API_BIND=0.0.0.0` (any
  interface) or a specific LAN/tailnet IP. Only do this behind TLS + the
  allowlist — the bearer token must never travel over plain HTTP.

## Pushing Claude's branches from the host

Runs inside the container commit to a per-request branch named `claude/*` but
**never push** — the container has no SSH key or git credentials. You push from
the host, where your normal git auth lives. The **Branches** panel in the
dashboard shows which branches still have unpushed commits.

Each run works in its own isolated git worktree under the project
(`.tmt-worktrees/`, added to the repo's local `.git/info/exclude` so it never
shows up as a change), so two requests against the same project never collide.
The branches and commits themselves live in the normal repo — worktrees are
disposable and cleaned up automatically, so you push exactly as usual.

### Push every project at once (recommended)

Run `bin/tmt-ai-push-all` **once, from the folder that holds all your project
checkouts** (the one directory above each repo). It walks every git repo one
level down, finds each with unpushed `claude/*` commits, and — after a single
confirmation — pushes them, printing exactly what went out:

```bash
cd /host/path/to/projects        # the PARENT dir of your mapped repos
bin/tmt-ai-push-all --dry-run     # preview across all repos, push nothing
bin/tmt-ai-push-all               # preview, confirm once, then push
bin/tmt-ai-push-all --yes         # skip the prompt
bin/tmt-ai-push-all -r upstream   # different remote (default: origin)
```

Counts are against local remote-tracking refs, so run `git fetch --all` first
if they might be stale.

### One project only

```bash
bin/tmt-ai-push /host/path/to/project        # preview, then confirm
bin/tmt-ai-push /host/path/to/project --yes   # skip the prompt
```

### What both do under the hood

Both wrappers push **only** `claude/*` and never force-overwrite:

```bash
git push origin 'refs/heads/claude/*:refs/heads/claude/*'
```

The wildcard refspec only maps `refs/heads/claude/*`, so `master` and every
other branch are left alone, and without `--force` a non-fast-forward is
rejected rather than clobbered. Commits are authored as
`TASK_GIT_NAME <TASK_GIT_EMAIL>` (default `tmt-ai <tmt-ai@localhost>`); override
those env vars if you want your own identity on them.

## Adding a project

Append a line to `compose.override.yml`:

```yaml
services:
  tmt-ai-code:
    volumes:
      - /host/path/to/code:/workspace/new-thing
```

Then `docker compose up -d` to recreate the container. The trailing
segment (`new-thing`) becomes the DB filename.

## What's where

| Path | Purpose |
| --- | --- |
| `compose.yml` | services: `tmt-ai-proxy`, `tmt-ai-viewer2`, `tmt-ai-datasette`, `tmt-ai-code`, `tmt-ai-docker-proxy` |
| `compose.override.yml` | **your** project mounts (gitignored) |
| `tmt-ai-code/` | Claude CLI container image |
| `tmt-ai-proxy/` | Anthropic API logger; SQLite migrations in `migrations/` |
| `tmt-ai-viewer2/` | web dashboard (Vue SPA + Node; threads/notes, state in `data/.viewer2-state.db`) |
| `tmt-ai-datasette/` | Datasette UI |
| `claude-config/` | Claude credentials, settings, container-side `CLAUDE.md` (gitignored) |
| `data/` | one `<project>.db` per mapped project (gitignored) |
| `bin/tmt_ai` | host launcher script |
| `bin/tmt-ai-push` / `bin/tmt-ai-push-all` | host helpers to push `claude/*` branches (one project / all projects in a folder) |

Permissions inside the container default to `bypassPermissions` and
secret files (`.env*`, `*.pem`, `*.key`, etc.) are explicitly denied —
see `claude-config/settings.json` to adjust. The proxy redacts
`Authorization`, `X-Claude-Code-Session-Id`, `Cookie`, and similar
headers before logging.

## Cleanup

```bash
docker compose down                # stop everything
rm -rf data/<project>.db           # drop a single project's logs
```

## Contributing

Pull requests welcome. If you find a rough edge — missing tool in the
container, a better default in `settings.json`, a cleaner launcher
flag, a useful query you'd want as a Datasette canned view — open a PR.
Keep changes focused; new features should explain the
problem they solve in the PR description.
