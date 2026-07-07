"""ai-service FastAPI application entrypoint.

Wires up structured logging, CORS, settings, the /health probe, and the four
AI routers (stt, translate, tts, finalize).
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.routers import finalize, stt, translate, tts

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("ai-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize settings on startup and surface key config (without secrets)."""

    settings = get_settings()

    # Ensure the google credentials env var is visible to the google-auth lib.
    # pydantic-settings reads it, but the client reads os.environ directly, so
    # mirror it back if it is only present in the .env-loaded Settings.
    if settings.GOOGLE_APPLICATION_CREDENTIALS and not os.environ.get(
        "GOOGLE_APPLICATION_CREDENTIALS"
    ):
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = (
            settings.GOOGLE_APPLICATION_CREDENTIALS
        )

    # Ensure scratch/cache dirs exist.
    os.makedirs(settings.TEMP_AUDIO_DIR, exist_ok=True)
    os.makedirs(settings.FLASHCARD_IMAGE_DIR, exist_ok=True)
    _prune_flashcard_cache(settings)

    logger.info(
        "ai-service starting: port=%s stt_lang=%s llm_model=%s "
        "llm_base_url=%s cartesia_lang=%s temp_dir=%s image_cache=%s",
        settings.APP_PORT,
        settings.GOOGLE_STT_LANGUAGE_CODE,
        settings.LLM_MODEL or "<unset>",
        settings.LLM_BASE_URL or "<default>",
        settings.CARTESIA_TTS_LANGUAGE,
        settings.TEMP_AUDIO_DIR,
        settings.FLASHCARD_IMAGE_DIR,
    )

    # Warm up provider clients so the FIRST real request isn't slow (cold start:
    # auth-token mint, gRPC channel, TLS handshakes). All best-effort — a failure
    # here must never block startup; the first request just pays the cost instead.
    await _warmup(settings)

    yield

    # Release pooled connections.
    try:
        from app.services.cartesia_english_tts_service import close_cartesia_client

        await close_cartesia_client()
    except Exception:  # noqa: BLE001
        pass
    logger.info("ai-service shutting down")


async def _warmup(settings) -> None:
    """Pre-initialize provider clients and pre-mint auth so the 1st call is fast."""

    # 1) Google STT: build the cached SpeechClient (opens the gRPC channel) and
    #    pre-mint an access token so the first recognize doesn't pay the auth RTT.
    try:
        from app.services.google_stt_service import _get_speech_client

        _get_speech_client()
        from google.auth import default as google_auth_default
        from google.auth.transport.requests import Request as GoogleAuthRequest

        creds, _ = google_auth_default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        creds.refresh(GoogleAuthRequest())
        logger.info("warmup: google stt client + auth ready")
    except Exception as exc:  # noqa: BLE001
        logger.warning("warmup: google stt skipped (%s)", exc)

    # 2) LLM: a 1-token completion warms TLS + auth + connection pool to OpenRouter.
    if settings.LLM_API_KEY and settings.LLM_MODEL:
        try:
            from app.utils.llm import chat

            await chat("hi", max_tokens=1)
            logger.info("warmup: llm connection ready")
        except Exception as exc:  # noqa: BLE001
            logger.warning("warmup: llm skipped (%s)", exc)

    # 3) Cartesia: build the shared pooled httpx client (keep-alive across calls).
    try:
        from app.services.cartesia_english_tts_service import get_cartesia_client

        get_cartesia_client()
        logger.info("warmup: cartesia client ready")
    except Exception as exc:  # noqa: BLE001
        logger.warning("warmup: cartesia skipped (%s)", exc)


def _prune_flashcard_cache(settings) -> None:
    """Remove stale generated images so the cache volume has a simple bound."""

    ttl_hours = max(0, settings.FLASHCARD_IMAGE_CACHE_TTL_HOURS)
    if ttl_hours == 0:
        return

    image_dir = Path(settings.FLASHCARD_IMAGE_DIR)
    cutoff = time.time() - (ttl_hours * 60 * 60)
    removed = 0
    for path in image_dir.iterdir():
        if not path.is_file() or path.suffix.lower() not in {
            ".webp",
            ".png",
            ".jpg",
            ".jpeg",
        }:
            continue
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError as exc:
            logger.warning("flashcard cache prune skipped file=%s error=%s", path.name, exc)

    if removed:
        logger.info("flashcard cache pruned files=%d ttl_hours=%d", removed, ttl_hours)


app = FastAPI(
    title="ai-service",
    description="Thai->English classroom translator AI backend",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS: the service is called server-to-server by the backend, but permissive
# CORS keeps local dev frictionless. Tighten origins in production as needed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers.
app.include_router(stt.router)
app.include_router(translate.router)
app.include_router(tts.router)
app.include_router(finalize.router)
os.makedirs(get_settings().FLASHCARD_IMAGE_DIR, exist_ok=True)
app.mount(
    "/ai/assets/flashcards",
    StaticFiles(directory=get_settings().FLASHCARD_IMAGE_DIR),
    name="flashcard-images",
)


@app.get("/health", tags=["health"])
async def health() -> dict[str, str]:
    """Liveness probe. Matches the system HTTP contract exactly."""

    return {"status": "ok", "service": "ai-service"}
