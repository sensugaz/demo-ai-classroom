"""Dynamic protected-term extraction from Thai classroom transcripts."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from app.utils.llm import LLMConfigError, LLMError, chat, parse_json

logger = logging.getLogger(__name__)


class TermExtractionError(RuntimeError):
    """Raised when protected-term extraction fails."""

    def __init__(self, message: str, *, config_error: bool = False) -> None:
        super().__init__(message)
        self.config_error = config_error


@dataclass(frozen=True)
class ProtectedTerm:
    """One Thai term and its English rendering protected across artifacts."""

    th: str
    en: str
    kind: str = ""

    def pair(self) -> tuple[str, str]:
        return self.th, self.en

    @property
    def is_vocabulary_candidate(self) -> bool:
        return self.kind.strip().lower() not in {"person", "other"}


TERM_EXTRACTION_PROMPT_TEMPLATE = """You extract protected learning terms from a Thai classroom transcript.

Goal:
- Identify important content terms that must not be omitted or mistranslated in
  translation, summaries, vocabulary lists, and flashcards.

Rules:
- Use the Thai transcript as the source of truth. The English translation is only
  a helper and may contain mistakes.
- Extract terms dynamically from this transcript; do not rely on any fixed list.
- Include concrete nouns, named objects, plants, animals, foods, places, people,
  story characters, math/science/social-studies terms, and subject vocabulary.
- For compact Thai noun phrases with no spaces, split meaningful content terms
  when they refer to separate things.
- Ignore pronouns, filler, greetings, classroom management, title/genre/session
  framing words, and accidental transcription noise that is not lesson content.
- Give the natural English classroom rendering for each Thai term.
- Return 0-20 terms depending on transcript length.
- Return valid JSON only.

Thai Transcript:
{{fullThaiTranscript}}

English Translation (may be imperfect):
{{fullEnglishTranslation}}

Return JSON:
[{"th":"","en":"","kind":"object|concept|person|place|animal|plant|food|other"}]
"""


def build_term_extraction_prompt(
    full_thai_transcript: str,
    full_english_translation: str = "",
) -> str:
    """Render the dynamic protected-term extraction prompt."""

    return (
        TERM_EXTRACTION_PROMPT_TEMPLATE
        .replace("{{fullThaiTranscript}}", full_thai_transcript)
        .replace("{{fullEnglishTranslation}}", full_english_translation)
    )


def _coerce_term(item: Any) -> ProtectedTerm | None:
    if not isinstance(item, dict):
        return None
    th = str(item.get("th", "")).strip()
    en = str(item.get("en", "")).strip()
    kind = str(item.get("kind", "")).strip()
    if not th or not en:
        return None
    return ProtectedTerm(th=th, en=en, kind=kind)


def dedupe_term_pairs(terms: Iterable[tuple[str, str]]) -> list[tuple[str, str]]:
    """Clean and de-duplicate term pairs by Thai term with later entries winning."""

    seen: dict[str, str] = {}
    for th, en in terms:
        th = (th or "").strip()
        en = (en or "").strip()
        if th and en:
            seen[th] = en
    return list(seen.items())


class TermExtractionService:
    """Extract dynamic protected terms using the configured LLM."""

    async def extract_terms(
        self,
        full_thai_transcript: str,
        full_english_translation: str = "",
    ) -> list[ProtectedTerm]:
        if not (full_thai_transcript or "").strip():
            return []

        prompt = build_term_extraction_prompt(
            full_thai_transcript,
            full_english_translation,
        )
        try:
            try:
                raw = await chat(
                    prompt,
                    temperature=0.0,
                    force_json=True,
                    max_tokens=1200,
                )
            except LLMConfigError:
                raise
            except LLMError:
                raw = await chat(
                    prompt,
                    temperature=0.0,
                    force_json=False,
                    max_tokens=1200,
                )
        except LLMConfigError as exc:
            logger.error("Term extraction LLM not configured: %s", exc)
            raise TermExtractionError(str(exc), config_error=True) from exc
        except LLMError as exc:
            logger.warning("Term extraction LLM call failed: %s", exc)
            raise TermExtractionError(str(exc)) from exc

        try:
            data = parse_json(raw, expect="array")
        except ValueError as exc:
            logger.warning("Term extraction JSON parse failed: %s", raw[:300])
            raise TermExtractionError(f"could not parse term JSON: {exc}") from exc

        assert isinstance(data, list)
        terms_by_th: dict[str, ProtectedTerm] = {}
        for item in data:
            term = _coerce_term(item)
            if term is not None:
                terms_by_th[term.th] = term
        terms = list(terms_by_th.values())
        logger.info("Term extraction ok count=%d", len(terms))
        return terms

    async def extract(
        self,
        full_thai_transcript: str,
        full_english_translation: str = "",
    ) -> list[tuple[str, str]]:
        terms = await self.extract_terms(
            full_thai_transcript,
            full_english_translation,
        )
        return [term.pair() for term in terms]


def get_term_extraction_service() -> TermExtractionService:
    """Provider for use by finalization."""

    return TermExtractionService()
