"""Schemas for POST /ai/classroom/finalize.

Field names match the system contract EXACTLY so the Go backend can persist
the response straight into the MongoDB `classroom_summaries`,
`classroom_vocabularies`, and `classroom_flashcards` collections.
"""

from __future__ import annotations

from typing import List

from pydantic import BaseModel, Field


class FinalizeMessage(BaseModel):
    """One persisted classroom message used to build the finalization context."""

    sourceText: str = ""
    translatedText: str = ""


class FinalizeRequest(BaseModel):
    """All messages for a session, used to produce summary/vocab/flashcards."""

    sessionId: str = Field(..., min_length=1)
    messages: List[FinalizeMessage] = Field(default_factory=list)


class Summary(BaseModel):
    """Bilingual classroom summary."""

    summaryTh: str = ""
    summaryEn: str = ""
    keyPointsTh: List[str] = Field(default_factory=list)
    keyPointsEn: List[str] = Field(default_factory=list)


class Vocabulary(BaseModel):
    """A single English vocabulary entry for Thai learners."""

    word: str = ""
    pronunciation: str = ""
    partOfSpeech: str = ""
    meaningTh: str = ""
    meaningEn: str = ""
    exampleSentenceEn: str = ""
    exampleSentenceTh: str = ""
    difficultyLevel: str = "beginner"


class Flashcard(BaseModel):
    """A single review flashcard."""

    front: str = ""
    back: str = ""
    # type is one of: vocabulary | sentence | grammar
    type: str = "vocabulary"
    word: str = ""
    hintTh: str = ""
    exampleSentence: str = ""


class FinalizeResponse(BaseModel):
    """Aggregated finalization payload returned to the backend."""

    summary: Summary
    vocabularies: List[Vocabulary] = Field(default_factory=list)
    flashcards: List[Flashcard] = Field(default_factory=list)
