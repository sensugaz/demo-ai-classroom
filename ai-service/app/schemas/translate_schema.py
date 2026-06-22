"""Schemas for POST /ai/translate/th-to-en."""

from __future__ import annotations

from pydantic import BaseModel, Field


class TermPair(BaseModel):
    """One established Thai->English translation for consistency hints."""

    th: str = ""
    en: str = ""


class TranslateRequest(BaseModel):
    """Translate a single Thai utterance into English."""

    sessionId: str = Field(..., min_length=1)
    sourceText: str = Field(..., min_length=1)
    # Optional lesson topic / story synopsis used as background context.
    contextNote: str = ""
    # Recent confirmed pairs so the same term renders consistently.
    glossary: list[TermPair] = Field(default_factory=list)


class TranslateResponse(BaseModel):
    """English translation result. Language pair is fixed by the system spec."""

    translatedText: str
    sourceLanguage: str = "th-TH"
    targetLanguage: str = "en-US"
