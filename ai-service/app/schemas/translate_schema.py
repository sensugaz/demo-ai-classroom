"""Schemas for POST /ai/translate/th-to-en."""

from __future__ import annotations

from pydantic import BaseModel, Field


class TranslateRequest(BaseModel):
    """Translate a single Thai utterance into English."""

    sessionId: str = Field(..., min_length=1)
    sourceText: str = Field(..., min_length=1)


class TranslateResponse(BaseModel):
    """English translation result. Language pair is fixed by the system spec."""

    translatedText: str
    sourceLanguage: str = "th-TH"
    targetLanguage: str = "en-US"
