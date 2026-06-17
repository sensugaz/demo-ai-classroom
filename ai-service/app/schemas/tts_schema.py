"""Schemas for POST /ai/tts/en (English text-to-speech via Cartesia)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class TtsRequest(BaseModel):
    """Synthesize English speech for a translated utterance."""

    sessionId: str = Field(..., min_length=1)
    text: str = Field(..., min_length=1)


class TtsResponse(BaseModel):
    """Synthesized audio as base64. `audioUrl` is intentionally empty: the
    backend forwards `audioBase64` directly to the frontend over WebSocket.
    """

    audioUrl: str = ""
    audioBase64: str
    language: str = "en-US"
    durationMs: int = 0
