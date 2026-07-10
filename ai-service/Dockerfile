FROM python:3.12-slim

# System deps: wget for the healthcheck. No build toolchain required for the
# pinned wheels, but keep the image lean.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first to leverage Docker layer caching.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Application code.
COPY app /app/app

# Run the network service without root privileges. The app user owns only its
# generated-image cache.
RUN addgroup --system app \
    && adduser --system --ingroup app app \
    && mkdir -p /tmp/flashcard-images \
    && chown -R app:app /tmp/flashcard-images /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    APP_PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8000/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
