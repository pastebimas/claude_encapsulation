# Local build of the Claude Code container.
# Based on the official Playwright image (Ubuntu noble) so Chromium,
# Firefox and WebKit + their system deps are preinstalled in
# /ms-playwright (PLAYWRIGHT_BROWSERS_PATH is set by the base image).
#
# Pin must match the `playwright` npm version projects use, or the
# bundled browsers won't match the test runner. Bump both together.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

# gosu: drop privileges to USER_UID (replaces alpine's su-exec).
# git: most projects need it. bash already ships on Debian.
# curl/jq/openssl/make/ripgrep/sqlite3/zip/xz: common agent reach-fors.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git gosu tmux \
    curl jq openssl make ripgrep sqlite3 zip xz-utils \
    ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI only (talks to the socket proxy; no daemon in this container).
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
       -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Pin to the 2.1.x line that matches this compose setup.
RUN npm install -g @anthropic-ai/claude-code@~2.1.0

RUN mkdir -p /claude /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sh", "-c", "echo 'Claude Code container is ready. Use: tmt_ai <project> (or docker compose exec -w /workspace/<project> tmt-ai-code claude).'"]
