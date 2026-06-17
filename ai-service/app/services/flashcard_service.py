"""Real LLM-backed flashcard generation from vocabulary + transcripts."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.prompts.flashcard_prompt import build_flashcard_prompt
from app.schemas.finalize_schema import Flashcard, Vocabulary
from app.utils.llm import LLMConfigError, LLMError, chat, parse_json

logger = logging.getLogger(__name__)

_VALID_TYPES = {"vocabulary", "sentence", "grammar"}


class FlashcardError(RuntimeError):
    """Raised when flashcard generation fails.

    ``config_error`` flags hard LLM misconfiguration (missing key/model).
    """

    def __init__(self, message: str, *, config_error: bool = False) -> None:
        super().__init__(message)
        self.config_error = config_error


def _vocab_to_compact_json(vocabularies: list[Vocabulary]) -> str:
    """Serialize vocab into a compact JSON list to feed the flashcard prompt."""

    payload = [
        {
            "word": v.word,
            "meaningTh": v.meaningTh,
            "meaningEn": v.meaningEn,
            "partOfSpeech": v.partOfSpeech,
            "exampleSentenceEn": v.exampleSentenceEn,
        }
        for v in vocabularies
    ]
    return json.dumps(payload, ensure_ascii=False)


def _coerce_flashcard(item: Any) -> Flashcard | None:
    """Map one raw JSON object to a Flashcard, dropping empty/invalid rows."""

    if not isinstance(item, dict):
        return None

    front = str(item.get("front", "")).strip()
    back = str(item.get("back", "")).strip()
    if not front and not back:
        return None

    card_type = str(item.get("type", "vocabulary")).strip().lower()
    if card_type not in _VALID_TYPES:
        card_type = "vocabulary"

    return Flashcard(
        front=front,
        back=back,
        type=card_type,
        word=str(item.get("word", "")).strip(),
        hintTh=str(item.get("hintTh", "")).strip(),
        exampleSentence=str(item.get("exampleSentence", "")).strip(),
    )


class FlashcardService:
    """Generate review flashcards from vocab + the full transcripts."""

    async def generate(
        self,
        vocabularies: list[Vocabulary],
        full_thai_transcript: str,
        full_english_translation: str,
    ) -> list[Flashcard]:
        vocabulary_json = _vocab_to_compact_json(vocabularies)
        prompt = build_flashcard_prompt(
            vocabulary_json, full_thai_transcript, full_english_translation
        )

        try:
            raw = await chat(prompt, temperature=0.4, force_json=False)
        except LLMConfigError as exc:
            logger.error("Flashcard LLM not configured: %s", exc)
            raise FlashcardError(str(exc), config_error=True) from exc
        except LLMError as exc:
            logger.exception("Flashcard LLM call failed")
            raise FlashcardError(str(exc)) from exc

        try:
            data = parse_json(raw, expect="array")
        except ValueError as exc:
            logger.error("Flashcard JSON parse failed: %s", raw[:300])
            raise FlashcardError(f"could not parse flashcard JSON: {exc}") from exc

        assert isinstance(data, list)  # narrow for type-checkers
        cards: list[Flashcard] = []
        for item in data:
            coerced = _coerce_flashcard(item)
            if coerced is not None:
                cards.append(coerced)

        logger.info("Flashcards ok count=%d", len(cards))
        return cards


def get_flashcard_service() -> FlashcardService:
    """Provider for use by the finalize router/service."""

    return FlashcardService()
