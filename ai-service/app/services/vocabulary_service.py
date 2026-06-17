"""Real LLM-backed English vocabulary extraction for Thai learners."""

from __future__ import annotations

import logging
from typing import Any

from app.prompts.vocabulary_prompt import build_vocabulary_prompt
from app.schemas.finalize_schema import Vocabulary
from app.utils.llm import LLMConfigError, LLMError, chat, parse_json

logger = logging.getLogger(__name__)

_VALID_DIFFICULTY = {"beginner", "intermediate", "advanced"}


class VocabularyError(RuntimeError):
    """Raised when vocabulary extraction fails.

    ``config_error`` flags hard LLM misconfiguration (missing key/model).
    """

    def __init__(self, message: str, *, config_error: bool = False) -> None:
        super().__init__(message)
        self.config_error = config_error


def _coerce_vocabulary(item: Any) -> Vocabulary | None:
    """Map one raw JSON object to a Vocabulary, dropping empty/invalid rows."""

    if not isinstance(item, dict):
        return None

    word = str(item.get("word", "")).strip()
    if not word:
        return None

    difficulty = str(item.get("difficultyLevel", "beginner")).strip().lower()
    if difficulty not in _VALID_DIFFICULTY:
        difficulty = "beginner"

    return Vocabulary(
        word=word,
        pronunciation=str(item.get("pronunciation", "")).strip(),
        partOfSpeech=str(item.get("partOfSpeech", "")).strip(),
        meaningTh=str(item.get("meaningTh", "")).strip(),
        meaningEn=str(item.get("meaningEn", "")).strip(),
        exampleSentenceEn=str(item.get("exampleSentenceEn", "")).strip(),
        exampleSentenceTh=str(item.get("exampleSentenceTh", "")).strip(),
        difficultyLevel=difficulty,
    )


class VocabularyService:
    """Extract a JSON list of vocabulary entries from the English translation."""

    async def generate(self, full_english_translation: str) -> list[Vocabulary]:
        prompt = build_vocabulary_prompt(full_english_translation)

        try:
            raw = await chat(prompt, temperature=0.3, force_json=False)
        except LLMConfigError as exc:
            logger.error("Vocabulary LLM not configured: %s", exc)
            raise VocabularyError(str(exc), config_error=True) from exc
        except LLMError as exc:
            logger.exception("Vocabulary LLM call failed")
            raise VocabularyError(str(exc)) from exc

        try:
            data = parse_json(raw, expect="array")
        except ValueError as exc:
            logger.error("Vocabulary JSON parse failed: %s", raw[:300])
            raise VocabularyError(f"could not parse vocabulary JSON: {exc}") from exc

        assert isinstance(data, list)  # narrow for type-checkers
        vocab: list[Vocabulary] = []
        for item in data:
            coerced = _coerce_vocabulary(item)
            if coerced is not None:
                vocab.append(coerced)

        logger.info("Vocabulary ok count=%d", len(vocab))
        return vocab


def get_vocabulary_service() -> VocabularyService:
    """Provider for use by the finalize router/service."""

    return VocabularyService()
