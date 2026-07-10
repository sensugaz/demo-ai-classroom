"""ai-service FastAPI application entrypoint.

Wires up structured logging, settings, the /health probe, and AI routers.
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.routers import finalize, realtime_translation, tts

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("ai-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize settings on startup and surface key config (without secrets)."""

    settings = get_settings()

    # Ensure the image cache directory exists.
    os.makedirs(settings.FLASHCARD_IMAGE_DIR, exist_ok=True)
    _prune_flashcard_cache(settings)

    logger.info(
        "ai-service starting: port=%s realtime_model=%s llm_model=%s "
        "llm_base_url=%s cartesia_lang=%s image_cache=%s",
        settings.APP_PORT,
        "gpt-realtime-translate",
        settings.LLM_MODEL or "<unset>",
        settings.LLM_BASE_URL or "<default>",
        settings.CARTESIA_TTS_LANGUAGE,
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
    try:
        from app.services.openai_realtime_translation_service import (
            close_realtime_translation_client,
        )

        await close_realtime_translation_client()
    except Exception:  # noqa: BLE001
        pass
    logger.info("ai-service shutting down")


async def _warmup(settings) -> None:
    """Pre-initialize pooled provider clients so the first call is fast."""

    # A 1-token completion warms TLS + auth + connection pool to OpenRouter.
    if settings.LLM_API_KEY and settings.LLM_MODEL:
        try:
            from app.utils.llm import chat

            await chat("hi", max_tokens=1)
            logger.info("warmup: llm connection ready")
        except Exception as exc:  # noqa: BLE001
            logger.warning("warmup: llm skipped (%s)", exc)

    # Build the shared Cartesia httpx client for keep-alive across calls.
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

# Routers.
app.include_router(realtime_translation.router)
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
