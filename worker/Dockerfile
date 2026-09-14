# OPNinfer ingestion worker ("router"): claims pending `files` rows from the
# shared database, detects real types by magic bytes, prepares token-efficient
# content/metadata artifacts into each chat's storage pool, and calls the
# heavier engine containers (gotenberg / docling-serve / whisper) over HTTP.
FROM python:3.12-slim-bookworm

# libmagic — magic-byte detection; ffmpeg — ffprobe metadata + audio remux.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libmagic1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /worker
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Unbuffered logs so `docker compose logs -f worker` streams live.
ENV PYTHONUNBUFFERED=1
CMD ["python", "-m", "app.main"]
