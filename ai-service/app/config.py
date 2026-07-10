"""Application settings loaded from environment variables.

Every ai-service env var from the system ENV contract is represented here.
Values are read once at startup via the cached `get_settings()` accessor.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Strongly typed view over the ai-service environment contract."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # --- Server ---
    APP_PORT: int = 8000

    # --- Cartesia Text-to-Speech ---
    CARTESIA_API_KEY: str = ""
    CARTESIA_VOICE_ID: str = ""
    CARTESIA_VOICE_CHILD_GIRL_ID: str = "32b3f3c5-7171-46aa-abe7-b598964aa793"
    CARTESIA_VOICE_CHILD_BOY_ID: str = "79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e"
    CARTESIA_VOICE_ADULT_WOMAN_ID: str = "f786b574-daa5-4673-aa0c-cbe3e8534c02"
    CARTESIA_VOICE_ADULT_MAN_ID: str = "47c38ca4-5f35-497b-b1a3-415245fb35e1"
    CARTESIA_TTS_LANGUAGE: str = "en"
    # Cartesia Sonic model id. sonic-3.5 is the latest Sonic model.
    CARTESIA_MODEL: str = "sonic-3.5"

    # --- LLM (OpenRouter; OpenAI-compatible Chat Completions) ---
    LLM_API_KEY: str = ""
    LLM_MODEL: str = ""
    # OpenAI-compatible base URL. Defaults to OpenRouter; override for any other
    # OpenAI-compatible gateway (or set to https://api.openai.com/v1 for OpenAI).
    LLM_BASE_URL: Optional[str] = "https://openrouter.ai/api/v1"
    # Optional OpenRouter attribution headers (used for app ranking on
    # openrouter.ai; ignored by other gateways).
    LLM_HTTP_REFERER: str = "http://localhost:3000"
    LLM_APP_TITLE: str = "AI Classroom"
    # --- OpenAI Realtime + flashcard image generation/cache ---
    # Realtime requires this key. If it is unavailable during finalization,
    # flashcards are returned without images and finalization still succeeds.
    OPENAI_API_KEY: str = ""
    FLASHCARD_IMAGE_BASE_URL: str = "https://api.openai.com/v1"
    FLASHCARD_IMAGE_MODEL: str = "gpt-image-2"
    FLASHCARD_IMAGE_SIZE: str = "1024x1024"
    FLASHCARD_IMAGE_OUTPUT_FORMAT: str = "webp"
    FLASHCARD_IMAGE_QUALITY: str = "low"
    FLASHCARD_IMAGE_DIR: str = "/tmp/flashcard-images"
    FLASHCARD_IMAGE_MAX_PER_SESSION: int = 8
    FLASHCARD_IMAGE_CACHE_TTL_HOURS: int = 720

    # --- Fixed language contract (never configurable per the system spec) ---
    SOURCE_LANGUAGE: str = "th-TH"
    TARGET_LANGUAGE: str = "en-US"
    TTS_OUTPUT_LANGUAGE: str = "en-US"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide cached Settings instance."""

    return Settings()
