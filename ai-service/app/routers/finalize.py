"""POST /ai/classroom/finalize — build summary, vocabulary, and flashcards.

Pipeline:
  1. Assemble the full Thai transcript and English translation from messages.
  2. Extract dynamic protected terms from the Thai transcript.
  3. Run summary + vocabulary in parallel using those protected terms.
  4. Feed the extracted vocabulary into flashcard generation.

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
    FlashcardImagesRequest,
    FlashcardImagesResponse,
    Flashcard,
    Summary,
    Vocabulary,
)
from app.services.flashcard_service import FlashcardError, get_flashcard_service
from app.services.flashcard_image_service import get_flashcard_image_service
from app.services.summary_service import SummaryError, get_summary_service
from app.services.term_extraction_service import (
    TermExtractionError,
    get_term_extraction_service,
)
from app.services.vocabulary_service import VocabularyError, get_vocabulary_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ai/classroom", tags=["finalize"])

# Service errors that carry a ``config_error`` flag.
_ConfigFlaggedError = (
    SummaryError,
    VocabularyError,
    FlashcardError,
    TermExtractionError,
)


def _is_config_error(exc: BaseException) -> bool:
    return isinstance(exc, _ConfigFlaggedError) and getattr(exc, "config_error", False)


def _build_transcripts(request: FinalizeRequest) -> tuple[str, str]:
    """Join all message texts into a Thai transcript and English translation."""

    thai_parts = [m.sourceText.strip() for m in request.messages if m.sourceText.strip()]
    english_parts = [
        m.translatedText.strip() for m in request.messages if m.translatedText.strip()
    ]
    return "\n".join(thai_parts), "\n".join(english_parts)


def _flashcard_image_counts(flashcards: list[Flashcard]) -> dict[str, int | str]:
    if not flashcards:
        return {
            "imageStatus": "skipped",
            "attemptedCount": 0,
            "readyCount": 0,
            "skippedCount": 0,
            "failedCount": 0,
        }

    attempted = 0
    ready = 0
    skipped = 0
    failed = 0
    pending = 0
    for card in flashcards:
        status_value = (card.imageStatus or "").strip().lower()
        if status_value == "ready":
            ready += 1
            attempted += 1
        elif status_value == "failed":
            failed += 1
            attempted += 1
        elif status_value == "pending":
            pending += 1
            attempted += 1
        elif status_value == "skipped":
            skipped += 1

    image_status = "ready"
    if pending:
        image_status = "pending"
    elif failed:
        image_status = "failed"
    elif skipped and not ready:
        image_status = "skipped"

    return {
        "imageStatus": image_status,
        "attemptedCount": attempted,
        "readyCount": ready,
        "skippedCount": skipped,
        "failedCount": failed,
    }


@router.post("/finalize", response_model=FinalizeResponse)
async def finalize_classroom(request: FinalizeRequest) -> FinalizeResponse:
    """Generate summary, vocabulary, and flashcards for a finished session."""

    full_thai, full_english = _build_transcripts(request)

    if not full_thai.strip():
        return FinalizeResponse(
            summary=Summary(),
            vocabularies=[],
            flashcards=[],
        )

    summary_service = get_summary_service()
    vocabulary_service = get_vocabulary_service()
    flashcard_service = get_flashcard_service()
    term_extraction_service = get_term_extraction_service()

    try:
        extracted_terms = await term_extraction_service.extract_terms(
            full_thai,
            full_english,
        )
    except TermExtractionError as exc:
        if exc.config_error:
            logger.error(
                "Finalize term extraction config error session=%s: %s",
                request.sessionId,
                exc,
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=str(exc),
            ) from exc
        logger.warning(
            "Term extraction degraded session=%s: %s",
            request.sessionId,
            exc,
        )
        extracted_terms = []

    protected_terms = [term.pair() for term in extracted_terms]
    vocabulary_terms = [
        term.pair() for term in extracted_terms if term.is_vocabulary_candidate
    ]

    # Summary and vocabulary are independent after protected terms are extracted.
    summary_result, vocab_result = await asyncio.gather(
        summary_service.generate(full_thai, full_english, protected_terms),
        vocabulary_service.generate(full_english, full_thai, vocabulary_terms),
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


@router.post("/flashcard-images", response_model=FlashcardImagesResponse)
async def generate_flashcard_images(
    request: FlashcardImagesRequest,
) -> FlashcardImagesResponse:
    """Generate/cache flashcard images as a best-effort background step."""

    flashcard_image_service = get_flashcard_image_service()
    try:
        flashcards = await flashcard_image_service.attach_images(
            request.sessionId, request.flashcards, request.vocabularies
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Flashcard image endpoint degraded session=%s: %s",
            request.sessionId,
            exc,
        )
        flashcards = []
        for card in request.flashcards:
            if card.type == "vocabulary" and (card.word or card.front):
                card.imageUrl = ""
                card.imageStatus = "failed"
            else:
                card.imageUrl = ""
                card.imageStatus = "skipped"
            flashcards.append(card)

    return FlashcardImagesResponse(
        flashcards=flashcards,
        **_flashcard_image_counts(flashcards),
    )
