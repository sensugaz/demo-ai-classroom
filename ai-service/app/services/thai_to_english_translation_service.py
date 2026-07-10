"""Real Thai->English translation via an OpenAI-compatible LLM."""

from __future__ import annotations

import logging

from app.config import get_settings
from app.prompts.thai_to_english_translation_prompt import build_translation_prompt
from app.schemas.translate_schema import TranslateRequest, TranslateResponse
from app.services.classroom_term_glossary import merge_classroom_glossary
from app.services.translation_quality import (
    build_translation_audit_prompt,
    build_glossary_retry_prompt,
    find_missing_glossary_terms,
    parse_translation_audit,
)
from app.utils.llm import LLMError, chat, parse_json

logger = logging.getLogger(__name__)


class TranslationError(RuntimeError):
    """Raised when translation fails."""


def _clean_translation(raw: str) -> str:
    """Strip accidental wrapping the model may add (quotes/labels)."""

    text = raw.strip()
    # Some models echo "Output English:" — drop a trailing-style label prefix.
    lowered = text.lower()
    for label in ("output english:", "english:", "translation:"):
        if lowered.startswith(label):
            text = text[len(label):].strip()
            lowered = text.lower()
    # Remove surrounding matching quotes.
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        text = text[1:-1].strip()
    return text


class ThaiToEnglishTranslationService:
    """LLM-backed translator using the exact classroom-interpreter prompt."""

    async def _translate_with_accuracy_retry(
        self,
        prompt: str,
        source_text: str,
        context_note: str,
        glossary: list[tuple[str, str]],
        session_id: str,
        audit_mode: str,
    ) -> str:
        raw = await chat(prompt, temperature=0.0, max_tokens=192)
        translated = _clean_translation(raw)
        missing = find_missing_glossary_terms(source_text, translated, glossary)
        if not missing:
            return await self._maybe_audit_translation(
                source_text,
                translated,
                context_note,
                session_id,
                audit_mode,
                glossary_risk=False,
            )

        logger.warning(
            "Translation glossary coverage failed session=%s missing=%s",
            session_id,
            ",".join(term.th for term in missing),
        )
        retry_prompt = build_glossary_retry_prompt(prompt, translated, missing)
        try:
            retry_raw = await chat(retry_prompt, temperature=0.0, max_tokens=192)
        except LLMError:
            logger.exception("Translation accuracy retry failed session=%s", session_id)
            return await self._maybe_audit_translation(
                source_text,
                translated,
                context_note,
                session_id,
                audit_mode,
                glossary_risk=True,
            )

        retry_translated = _clean_translation(retry_raw)
        retry_missing = find_missing_glossary_terms(source_text, retry_translated, glossary)
        if retry_missing:
            logger.error(
                "Translation still missing glossary terms after retry session=%s missing=%s",
                session_id,
                ",".join(term.th for term in retry_missing),
            )
        return await self._maybe_audit_translation(
            source_text,
            retry_translated,
            context_note,
            session_id,
            audit_mode,
            glossary_risk=True,
        )

    async def _maybe_audit_translation(
        self,
        source_text: str,
        translated_text: str,
        context_note: str,
        session_id: str,
        audit_mode: str,
        glossary_risk: bool,
    ) -> str:
        audit_mode = (audit_mode or "glossary").strip().lower()
        if audit_mode == "always" or (audit_mode == "glossary" and glossary_risk):
            return await self._audit_translation(
                source_text,
                translated_text,
                context_note,
                session_id,
            )
        return translated_text

    async def _audit_translation(
        self,
        source_text: str,
        translated_text: str,
        context_note: str,
        session_id: str,
    ) -> str:
        audit_prompt = build_translation_audit_prompt(
            source_text,
            translated_text,
            context_note=context_note,
        )
        try:
            try:
                audit_raw = await chat(
                    audit_prompt,
                    temperature=0.0,
                    force_json=True,
                    max_tokens=512,
                )
            except LLMError:
                audit_raw = await chat(
                    audit_prompt,
                    temperature=0.0,
                    force_json=False,
                    max_tokens=512,
                )
            audit = parse_translation_audit(parse_json(audit_raw, expect="object"))
        except (LLMError, ValueError) as exc:
            logger.warning("Translation audit skipped session=%s: %s", session_id, exc)
            return translated_text

        if audit.is_accurate or not audit.corrected_translation:
            return translated_text

        logger.warning(
            "Translation audit corrected session=%s issues=%s",
            session_id,
            ",".join(audit.issues),
        )
        return _clean_translation(audit.corrected_translation)

    async def translate(self, request: TranslateRequest) -> TranslateResponse:
        settings = get_settings()
        glossary = merge_classroom_glossary(
            request.sourceText,
            request.contextNote,
            ((pair.th, pair.en) for pair in request.glossary),
        )
        prompt = build_translation_prompt(
            request.sourceText,
            context_note=request.contextNote,
            glossary=glossary,
        )

        try:
            # One short utterance per call; cap output so the model stops
            # promptly instead of over-generating, keeping live latency low.
            translated = await self._translate_with_accuracy_retry(
                prompt,
                request.sourceText,
                request.contextNote,
                glossary,
                request.sessionId,
                settings.TRANSLATION_AUDIT_MODE,
            )
        except LLMError as exc:
            logger.exception("Translation LLM call failed session=%s", request.sessionId)
            raise TranslationError(str(exc)) from exc

        logger.info(
            "Translate ok session=%s in=%d out=%d",
            request.sessionId,
            len(request.sourceText),
            len(translated),
        )

        return TranslateResponse(
            translatedText=translated,
            sourceLanguage="th-TH",
            targetLanguage="en-US",
        )


def get_translation_service() -> ThaiToEnglishTranslationService:
    """FastAPI dependency provider."""

    return ThaiToEnglishTranslationService()
