"""Real Thai->English translation via an OpenAI-compatible LLM."""

from __future__ import annotations

import logging

from app.prompts.thai_to_english_translation_prompt import build_translation_prompt
from app.schemas.translate_schema import TranslateRequest, TranslateResponse
from app.utils.llm import LLMError, chat

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

    async def translate(self, request: TranslateRequest) -> TranslateResponse:
        glossary = [(pair.th, pair.en) for pair in request.glossary]
        prompt = build_translation_prompt(
            request.sourceText,
            context_note=request.contextNote,
            glossary=glossary,
        )

        try:
            # One short utterance per call; cap output so the model stops
            # promptly instead of over-generating, keeping live latency low.
            raw = await chat(prompt, temperature=0.2, max_tokens=1024)
        except LLMError as exc:
            logger.exception("Translation LLM call failed session=%s", request.sessionId)
            raise TranslationError(str(exc)) from exc

        translated = _clean_translation(raw)
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
