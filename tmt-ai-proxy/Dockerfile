# Local build of the logging proxy.
# Forwards Anthropic API traffic and writes one SQLite DB per project
# under /data/<project>.db.
FROM python:3.12-alpine

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY proxy.py .
COPY migrations/ ./migrations/

RUN mkdir -p /data && chmod 777 /data

EXPOSE 8080

CMD ["python", "-u", "proxy.py"]
