"""Real LLM-backed bilingual classroom summary."""

from __future__ import annotations

import logging
from typing import Any

from app.prompts.summary_prompt import build_summary_prompt
from app.schemas.finalize_schema import Summary
from app.utils.llm import LLMConfigError, LLMError, chat, parse_json

logger = logging.getLogger(__name__)


class SummaryError(RuntimeError):
    """Raised when summary generation fails.

    ``config_error`` is True when the failure is a hard misconfiguration
    (missing LLM key/model) that the caller should surface rather than degrade.
    """

    def __init__(self, message: str, *, config_error: bool = False) -> None:
        super().__init__(message)
        self.config_error = config_error


def _as_str_list(value: Any) -> list[str]:
    """Coerce an arbitrary JSON value into a clean list[str]."""

    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


class SummaryService:
    """Generate a Thai+English summary with key points from transcripts."""

    async def generate(
        self, full_thai_transcript: str, full_english_translation: str
    ) -> Summary:
        prompt = build_summary_prompt(full_thai_transcript, full_english_translation)

        # Long-form lecture summary: allow a large completion so detailed
        # multi-paragraph Thai + English summaries are not cut off.
        max_tokens = 6000
        try:
            try:
                raw = await chat(
                    prompt, temperature=0.3, force_json=True, max_tokens=max_tokens
                )
            except LLMConfigError:
                # Hard misconfiguration: do not retry.
                raise
            except LLMError:
                # Gateway/model may not support response_format -> retry plain.
                raw = await chat(
                    prompt, temperature=0.3, force_json=False, max_tokens=max_tokens
                )
        except LLMConfigError as exc:
            logger.error("Summary LLM not configured: %s", exc)
            raise SummaryError(str(exc), config_error=True) from exc
        except LLMError as exc:
            logger.exception("Summary LLM call failed")
            raise SummaryError(str(exc)) from exc

        try:
            data = parse_json(raw, expect="object")
        except ValueError as exc:
            logger.error("Summary JSON parse failed: %s", raw[:300])
            raise SummaryError(f"could not parse summary JSON: {exc}") from exc

        assert isinstance(data, dict)  # narrow for type-checkers
        return Summary(
            summaryTh=str(data.get("summaryTh", "")).strip(),
            summaryEn=str(data.get("summaryEn", "")).strip(),
            keyPointsTh=_as_str_list(data.get("keyPointsTh")),
            keyPointsEn=_as_str_list(data.get("keyPointsEn")),
        )


def get_summary_service() -> SummaryService:
    """Provider for use by the finalize router/service."""

    return SummaryService()
