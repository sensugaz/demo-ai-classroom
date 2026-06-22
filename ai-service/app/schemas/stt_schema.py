"""Schemas for POST /ai/stt/th (Thai speech-to-text)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class SttRequest(BaseModel):
    """Per-chunk STT request.

    Each `audioBase64` payload is a self-contained WEBM/Opus blob (the frontend
    restarts MediaRecorder per segment so every blob carries its own header).
    """

    sessionId: str = Field(..., min_length=1)
    audioBase64: str = Field(..., min_length=1)
    mimeType: str = "audio/webm"
    sequenceNo: int = Field(..., ge=0)
    # Lesson topic / synopsis used as speech-adaptation phrase hints so expected
    # terms are recognized correctly instead of misheard look-alikes.
    contextNote: str = ""


class SttResponse(BaseModel):
    """Transcription result for a single chunk."""

    sessionId: str
    text: str
    language: str = "th-TH"
    # Backend primarily emits transcript:final per chunk; sync recognize always
    # yields a final result, so isFinal defaults to True.
    isFinal: bool = True
    confidence: float = 0.0
