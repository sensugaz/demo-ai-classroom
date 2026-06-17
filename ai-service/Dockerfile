FROM python:3.12-slim

# System deps: wget for the healthcheck. No build toolchain required for the
# pinned wheels, but keep the image lean.
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first to leverage Docker layer caching.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Application code.
COPY app /app/app

# Temp audio dir (matches TEMP_AUDIO_DIR default) and a place for mounted
# Google credentials (GOOGLE_APPLICATION_CREDENTIALS=/app/credentials/...).
RUN mkdir -p /tmp/audio /app/credentials

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    APP_PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
