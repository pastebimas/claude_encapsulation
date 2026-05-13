# Project notes for future Claude sessions

This file is auto-loaded when Claude Code runs from anywhere inside
`/Users/tautvis/Documents/Webs/a_claude_tmt/`. Read the README first
for the user-facing story; this file captures the non-obvious bits.

## What this repo is (one paragraph)

A self-contained Docker Compose stack with three services:
- **`tmt-ai-proxy`** — Anthropic API logger. Parses
  `working directory: /workspace/<name>` out of each request's system
  prompt and writes to `data/<name>.db`. Redacts `Authorization`,
  `X-Claude-Code-Session-Id`, `Cookie`, `X-Api-Key`, etc. before
  logging — do not undo that.
- **`tmt-ai-datasette`** — read-only web UI over `data/*.db` on
  `127.0.0.1:8001`. Discovers `.db` files at **startup only** —
  restart after adding a new project.
- **`tmt-ai-code`** — long-lived `sleep infinity` container holding
  the `claude` CLI. Users `docker exec` into it via `bin/tmt_ai`.

Host project folders are bind-mounted into `tmt-ai-code` under
`/workspace/<name>` via `compose.override.yml` (gitignored).

## Two different CLAUDE.md files — do not confuse them

- **`CLAUDE.md`** (this file) — loaded when Claude runs on the host
  in this infra repo. Use it for infra-development notes.
- **`claude-config/CLAUDE.md`** — bind-mounted into the container as
  `/claude/CLAUDE.md` (`$CLAUDE_CONFIG_DIR/CLAUDE.md`) and therefore
  loaded as user-global instructions for every Claude session running
  inside the container. Use it for container-environment constraints
  (no `brew`, no `docker`, etc.), not for infra notes.

## Critical exec gotcha: `--user` is mandatory

`docker exec` defaults to root. The container's entrypoint drops root
→ `$USER_UID` only for the main `sleep infinity` process; `exec`
processes start fresh as root. Claude's `bypassPermissions` mode
refuses root, so any plain `docker exec ... tmt-ai-code claude` fails
with:

> --dangerously-skip-permissions cannot be used with root/sudo privileges

Always pass `--user "$(id -u):$(id -g)"`. `bin/tmt_ai` wraps this.
Do not re-introduce examples that omit it.

## The `bin/tmt_ai` shortcut

Canonical way to launch Claude into a mounted project from anywhere
on the host. It enforces `--user`, checks the container is up,
validates the project mount exists, and supports `-s` (shell),
`-l` (list projects), `-h` (help). If you find yourself writing a
long `docker exec --user ... -w /workspace/...` line, use
`bin/tmt_ai` or extend it.

## Permissions are intentionally bypassed

`claude-config/settings.json` has `permissions.defaultMode:
"bypassPermissions"` with a `deny` list for secret files. The user
wants zero approval prompts inside the container; the deny list and
the container sandbox are the safety boundary. Do not re-enable
prompting.

## Proxy ports: 8080 inside, 8033 outside — do not mix them

`compose.yml` publishes `tmt-ai-proxy` as `127.0.0.1:8033:8080`.
- **From inside the docker network** (i.e. from `tmt-ai-code` →
  `tmt-ai-proxy`), use `http://tmt-ai-proxy:8080`. This is what
  `ANTHROPIC_BASE_URL` is set to.
- **From the host browser/curl**, use `http://127.0.0.1:8033`.

Using `:8033` from inside the network causes `ConnectionRefused`.
If the user reports that symptom, check `ANTHROPIC_BASE_URL` first.

## Where logs and config live

- `data/<name>.db` — SQLite, one per mapped project.
- `data/default.db` — catch-all for requests whose working directory
  couldn't be parsed (see `tmt-ai-proxy/proxy.py` routing logic).
- `claude-config/` — Claude CLI's `$CLAUDE_CONFIG_DIR` (credentials,
  settings, sessions, plugins, container-side `CLAUDE.md`).
- `tmt-ai-proxy/migrations/` — schema. Edit here for new
  tables/views, not by hand against live DBs.

## Routing of requests to DBs

`tmt-ai-proxy/proxy.py` picks the DB name with this priority:
1. `working directory: /workspace/<name>` (case-insensitive) in
   `request_body.system` — handles both string and content-block
   forms.
2. Scan of latest user message.
3. `DEFAULT_PROJECT` env (default `default`) → `default.db`.

If logs land in `default.db` unexpectedly, the system-prompt scrape
is the first thing to check.

## Style / preferences

- Terse documentation. Slim cheatsheets over prose. When in doubt,
  cut.
- No proactive comments in code or doc additions after a fix —
  persist only when the user asks.
- Don't suggest GUI/host-only commands (`open`, `code`, `brew`,
  `apt`, `pbcopy`, `docker` from inside the container, etc.) when
  the work is happening inside `tmt-ai-code`.

## Open / aware-of items

- Datasette's startup-time DB discovery means a
  `docker compose restart tmt-ai-datasette` is needed after the
  first request to a brand-new project.
- Existing rows in `data/*.db` that were written before the proxy
  redaction patch may still contain raw `Authorization` /
  `X-Claude-Code-Session-Id` values. Wipe or migrate those if the
  files have been shared.
