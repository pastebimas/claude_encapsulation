FROM python:3.12-slim

WORKDIR /app
COPY viewer.py .
COPY static/ static/

EXPOSE 8034
CMD ["python", "viewer.py"]
