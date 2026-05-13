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
$EDITOR compose.override.yml

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

Logs: <http://localhost:8001> (bound to 127.0.0.1 only). Each project
gets its own DB in the sidebar. Datasette only scans `*.db` files at
startup — restart it after creating logs for a brand-new project:

```bash
docker compose restart tmt-ai-datasette
```

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
| `compose.yml` | three services: `tmt-ai-proxy`, `tmt-ai-datasette`, `tmt-ai-code` |
| `compose.override.yml` | **your** project mounts (gitignored) |
| `tmt-ai-code/` | Claude CLI container image |
| `tmt-ai-proxy/` | Anthropic API logger; SQLite migrations in `migrations/` |
| `tmt-ai-datasette/` | Datasette UI |
| `claude-config/` | Claude credentials, settings, container-side `CLAUDE.md` (gitignored) |
| `data/` | one `<project>.db` per mapped project (gitignored) |
| `bin/tmt_ai` | host launcher script |

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
