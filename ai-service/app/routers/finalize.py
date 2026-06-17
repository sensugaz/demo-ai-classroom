"""POST /ai/classroom/finalize — build summary, vocabulary, and flashcards.

Pipeline:
  1. Assemble the full Thai transcript and English translation from messages.
  2. Run summary + vocabulary in parallel (independent of each other).
  3. Feed the extracted vocabulary into flashcard generation.

Each stage is best-effort: a transient downstream failure degrades to an empty
result so the session can still complete. A hard LLM misconfiguration
(missing key/model) surfaces as HTTP 502 instead, since retrying is pointless.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, status

from app.schemas.finalize_schema import (
    FinalizeRequest,
    FinalizeResponse,
    Flashcard,
    Summary,
    Vocabulary,
)
from app.services.flashcard_service import FlashcardError, get_flashcard_service
from app.services.summary_service import SummaryError, get_summary_service
from app.services.vocabulary_service import VocabularyError, get_vocabulary_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ai/classroom", tags=["finalize"])

# Service errors that carry a ``config_error`` flag.
_ConfigFlaggedError = (SummaryError, VocabularyError, FlashcardError)


def _is_config_error(exc: BaseException) -> bool:
    return isinstance(exc, _ConfigFlaggedError) and getattr(exc, "config_error", False)


def _build_transcripts(request: FinalizeRequest) -> tuple[str, str]:
    """Join all message texts into a Thai transcript and English translation."""

    thai_parts = [m.sourceText.strip() for m in request.messages if m.sourceText.strip()]
    english_parts = [
        m.translatedText.strip() for m in request.messages if m.translatedText.strip()
    ]
    return "\n".join(thai_parts), "\n".join(english_parts)


@router.post("/finalize", response_model=FinalizeResponse)
async def finalize_classroom(request: FinalizeRequest) -> FinalizeResponse:
    """Generate summary, vocabulary, and flashcards for a finished session."""

    full_thai, full_english = _build_transcripts(request)

    summary_service = get_summary_service()
    vocabulary_service = get_vocabulary_service()
    flashcard_service = get_flashcard_service()

    # Summary and vocabulary are independent -> run concurrently.
    summary_result, vocab_result = await asyncio.gather(
        summary_service.generate(full_thai, full_english),
        vocabulary_service.generate(full_english),
        return_exceptions=True,
    )

    # Hard config errors are unrecoverable -> 502.
    for result in (summary_result, vocab_result):
        if isinstance(result, BaseException) and _is_config_error(result):
            logger.error(
                "Finalize LLM config error session=%s: %s", request.sessionId, result
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail=str(result)
            )

    if isinstance(summary_result, Summary):
        summary = summary_result
    else:
        logger.warning(
            "Summary stage degraded session=%s: %s", request.sessionId, summary_result
        )
        summary = Summary()

    if isinstance(vocab_result, list):
        vocabularies: list[Vocabulary] = vocab_result
    else:
        logger.warning(
            "Vocabulary stage degraded session=%s: %s", request.sessionId, vocab_result
        )
        vocabularies = []

    # Flashcards depend on the extracted vocabulary.
    flashcards: list[Flashcard] = []
    try:
        flashcards = await flashcard_service.generate(
            vocabularies, full_thai, full_english
        )
    except FlashcardError as exc:
        if exc.config_error:
            logger.error(
                "Finalize flashcard config error session=%s: %s",
                request.sessionId,
                exc,
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
            ) from exc
        logger.warning(
            "Flashcard stage degraded session=%s: %s", request.sessionId, exc
        )
        flashcards = []

    logger.info(
        "Finalize done session=%s vocab=%d flashcards=%d",
        request.sessionId,
        len(vocabularies),
        len(flashcards),
    )

    return FinalizeResponse(
        summary=summary,
        vocabularies=vocabularies,
        flashcards=flashcards,
    )
