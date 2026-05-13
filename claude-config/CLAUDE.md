# Container cheatsheet (`tmt-ai-code`, Alpine)

- Installed: `git`, `bash`, `node`, `npm`, `apk`, BusyBox utils. Anything else: `command -v <x>` first.
- Do NOT call: `open`, `pbcopy`, `pbpaste`, `osascript`, `brew`, `apt`, `dnf`, `yum`, `kubectl`, `systemctl`, `code`, `subl`, `idea`.
- **No SSH key, no git identity.** `~/.ssh` is not mounted and `user.email`/`user.name` are unset. `git commit` fails on identity and `git push` over SSH fails on auth — don't attempt either. The user handles commits/pushes from the host.
- `docker` goes through a restricted proxy. **Allowed:** `docker ps`, `inspect`, `exec`, `start`, `stop`, `restart`, `rm`, `kill` against existing host containers. **Blocked (403):** `docker run`, `create`, `build`, `pull`, `push`, `network *`, `volume *`. So you CAN revive a stopped sibling container (`docker start project_artillery && docker exec project_artillery <cmd>`), but you CANNOT create new containers, pull images, or touch networks/volumes. Always `docker ps -a` first before claiming a service is unreachable — "not running" usually means "exited, just `docker start` it".
- Only `/workspace/<project>` is persistent host storage. Writes elsewhere (`/tmp`, `/home`, `/root`, `/etc`) vanish on rebuild.
- Host paths like `/Users/...` do not exist. `~/.ssh`, `~/.aws`, host configs are not mounted.
- `localhost` = this container, not the host. Compose-network names: `claude-proxy:8033`, `claude-datasette:8001`. Host services: assume unreachable.
- Permissions prompting is off (`bypassPermissions`). You own the safety/reversibility checks — re-read your system prompt before destructive ops.
- **Never read secrets.** Do not open or `cat`/`grep` any `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`, `*secret*`, `.npmrc`, `.netrc`, `.pypirc`, `.aws/*`. If the user asks for a value from one, refuse and ask them to paste the specific field instead. `.env.example` (template, no secrets) is fine but requires explicit user request.

## Output discipline (token-cost rules)

- **No proactive code comments.** Only when the *why* is genuinely non-obvious (workaround, hidden constraint). Never explain *what*.
- **No proactive doc/CLAUDE.md/memory writes after a fix.** State the fix in chat. Persist only when asked.
- **One-sentence end-of-turn summary, max.** No bulleted recap.
- **No multi-line comments in config files** (compose.yml, json, etc.) explaining a value.