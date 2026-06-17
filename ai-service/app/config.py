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

    # --- Google Speech-to-Text ---
    # Path to the mounted service-account JSON. The google-cloud-speech client
    # picks this up automatically when GOOGLE_APPLICATION_CREDENTIALS is set in
    # the process environment.
    GOOGLE_APPLICATION_CREDENTIALS: str = "/app/credentials/google-service-account.json"
    GOOGLE_STT_LANGUAGE_CODE: str = "th-TH"

    # --- Cartesia Text-to-Speech ---
    CARTESIA_API_KEY: str = ""
    CARTESIA_VOICE_ID: str = ""
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

    # --- Audio scratch space ---
    TEMP_AUDIO_DIR: str = "/tmp/audio"

    # --- Fixed language contract (never configurable per the system spec) ---
    SOURCE_LANGUAGE: str = "th-TH"
    TARGET_LANGUAGE: str = "en-US"
    TTS_OUTPUT_LANGUAGE: str = "en-US"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide cached Settings instance."""

    return Settings()
