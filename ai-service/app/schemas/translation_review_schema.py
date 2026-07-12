"""Schemas for canonical review of one live classroom translation."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class TranslationReviewRequest(BaseModel):
    """One untrusted Realtime candidate paired with its Thai source."""

    sessionId: str = Field(..., min_length=1, max_length=200)
    sourceText: str = Field(..., min_length=1, max_length=24_000)
    candidateTranslatedText: str = Field(..., min_length=1, max_length=24_000)
    contextNote: str = Field(default="", max_length=4_000)


class TranslationReviewResponse(BaseModel):
    """Canonical English safe for persistence, display, and TTS."""

    status: Literal["accepted", "corrected"]
    translatedText: str = Field(..., min_length=1, max_length=24_000)
