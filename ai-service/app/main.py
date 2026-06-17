"""ai-service FastAPI application entrypoint.

Wires up structured logging, CORS, settings, the /health probe, and the four
AI routers (stt, translate, tts, finalize).
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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

    # Ensure the temp audio dir exists.
    os.makedirs(settings.TEMP_AUDIO_DIR, exist_ok=True)

    logger.info(
        "ai-service starting: port=%s stt_lang=%s llm_model=%s "
        "llm_base_url=%s cartesia_lang=%s temp_dir=%s",
        settings.APP_PORT,
        settings.GOOGLE_STT_LANGUAGE_CODE,
        settings.LLM_MODEL or "<unset>",
        settings.LLM_BASE_URL or "<default>",
        settings.CARTESIA_TTS_LANGUAGE,
        settings.TEMP_AUDIO_DIR,
    )
    yield
    logger.info("ai-service shutting down")


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


@app.get("/health", tags=["health"])
async def health() -> dict[str, str]:
    """Liveness probe. Matches the system HTTP contract exactly."""

    return {"status": "ok", "service": "ai-service"}
