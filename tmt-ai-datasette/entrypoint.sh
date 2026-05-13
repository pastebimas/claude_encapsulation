#!/bin/sh
#
# Datasette entrypoint: collect every *.db file under /data and serve them
# as separate databases in a single Datasette instance.
#
set -e

DBS=""
for f in /data/*.db; do
    [ -e "$f" ] || continue
    DBS="$DBS $f"
done

if [ -z "$DBS" ]; then
    echo "No .db files in /data yet — starting Datasette empty."
    echo "Run claude in a project, then restart this container to see it."
fi

exec datasette $DBS \
    --host 0.0.0.0 \
    --port 8001 \
    --cors \
    --metadata /app/metadata.json \
    --setting max_returned_rows 100 \
    --setting sql_time_limit_ms 5000 \
    --setting default_page_size 50 \
    --setting cache_size_kb 10000 \
    --setting default_cache_ttl 60 \
    --setting num_sql_threads 8
