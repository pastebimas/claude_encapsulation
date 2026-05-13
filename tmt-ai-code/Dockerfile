# Local build of the Claude Code container.
# Mirrors the upstream nezhar/claude-container image so you can audit/modify it.
FROM node:22-alpine

# git: most projects need it. su-exec: drop privileges to USER_UID. bash: required shell.
RUN apk add --no-cache git su-exec bash docker-cli

# Pin to the 2.1.x line that matches this compose setup.
RUN npm install -g @anthropic-ai/claude-code@~2.1.0

RUN mkdir -p /claude /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sh", "-c", "echo 'Claude Code container is ready. Use: tmt_ai <project> (or docker compose exec -w /workspace/<project> tmt-ai-code claude).'"]