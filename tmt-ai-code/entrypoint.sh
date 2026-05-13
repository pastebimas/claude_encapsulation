#!/bin/sh
#
# Entrypoint for the Claude Code container.
# Maps the container user to USER_UID:USER_GID so bind-mounted files
# stay owned by your host user.
#
set -e

USER_UID=${USER_UID:-1000}
USER_GID=${USER_GID:-1000}

# Run as root if asked.
if [ "$USER_UID" -eq 0 ]; then
    exec "$@"
fi

# Resolve a group with USER_GID, creating "claude" if free.
if ! getent group "$USER_GID" >/dev/null 2>&1; then
    addgroup -g "$USER_GID" claude 2>/dev/null || true
    GROUP_NAME="claude"
else
    EXISTING_GROUP=$(getent group "$USER_GID" | cut -d: -f1)
    GROUP_NAME="${EXISTING_GROUP:-claude}"
fi

# Resolve a user with USER_UID, creating "claude" if free.
if ! getent passwd "$USER_UID" >/dev/null 2>&1; then
    adduser -D -u "$USER_UID" -G "$GROUP_NAME" -h /home/claude -s /bin/sh claude 2>/dev/null || true
    USER_NAME="claude"
else
    USER_NAME=$(getent passwd "$USER_UID" | cut -d: -f1)
fi

# Make /claude writable by the runtime user without disturbing existing creds.
if [ -d /claude ]; then
    chown "$USER_UID:$USER_GID" /claude 2>/dev/null || true
    chmod 755 /claude 2>/dev/null || true
fi

if [ -d /workspace ]; then
    chmod 755 /workspace 2>/dev/null || true
fi

export SHELL=/bin/bash
exec su-exec "${USER_NAME}" "$@"