#!/bin/sh
#
# ttyd → docker exec → tmux. The tmux session lives inside tmt-ai-code so
# it survives this container restarting; reconnecting just reattaches.
#
set -e

: "${TTYD_CREDENTIAL:?Set TTYD_CREDENTIAL=user:password (basic auth for ttyd)}"
: "${TARGET_CONTAINER:=tmt-ai-code}"
: "${TARGET_WORKDIR:=/workspace}"
: "${USER_UID:=1000}"
: "${USER_GID:=1000}"
: "${TMUX_SESSION:=tmt}"
: "${TTYD_PORT:=7681}"

exec ttyd -W -p "$TTYD_PORT" -i 127.0.0.1 -c "$TTYD_CREDENTIAL" \
    docker exec -it \
      --user "$USER_UID:$USER_GID" \
      -w "$TARGET_WORKDIR" \
      -e TERM=xterm-256color \
      "$TARGET_CONTAINER" \
      tmux new-session -A -s "$TMUX_SESSION"