# Browser-terminal sidecar: ttyd serves a shared tmux session that lives
# inside tmt-ai-code. Built only when compose.remote.yml is layered in.
FROM alpine:3.20

RUN apk add --no-cache ttyd docker-cli bash tini

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 7681

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]