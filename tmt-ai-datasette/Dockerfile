# Local build of Datasette UI. Auto-discovers every *.db in /data
# so a new project DB appears after a container restart.
FROM python:3.12-alpine

WORKDIR /app

RUN pip install --no-cache-dir \
    datasette==1.0a15 \
    datasette-json-html \
    datasette-copyable \
    datasette-pretty-json \
    datasette-export-notebook \
    datasette-dashboards

COPY metadata.json /app/metadata.json
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data && chmod 755 /data

EXPOSE 8001

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
