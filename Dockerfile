FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY sync.py server.py ./
COPY static ./static

# data/ is a volume: app.db, images/, photos/, sheet cache
VOLUME /app/data
ENV UVICORN_HOST=0.0.0.0 UVICORN_PORT=8123

EXPOSE 8123

# Sync the sheet on boot (offline-safe: reuses cache if download fails), then serve
CMD ["sh", "-c", "python3 sync.py --offline 2>/dev/null || python3 sync.py || true; uvicorn server:app --host ${UVICORN_HOST} --port ${UVICORN_PORT}"]
