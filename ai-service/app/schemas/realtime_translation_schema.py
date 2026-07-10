"""Schemas for minting OpenAI Realtime Translation client secrets."""

from __future__ import annotations

from pydantic import BaseModel, Field


class RealtimeTranslationClientSecretRequest(BaseModel):
    """Internal request from the Go backend for one classroom session."""

    sessionId: str = Field(..., min_length=1, max_length=200)


class RealtimeTranslationClientSecretResponse(BaseModel):
    """Whitelisted short-lived credentials returned to the Go backend."""

    clientSecret: str
    expiresAt: int
    translationSessionId: str
    model: str = "gpt-realtime-translate"
    targetLanguage: str = "en-US"
