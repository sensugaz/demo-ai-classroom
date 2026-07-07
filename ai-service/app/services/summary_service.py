"""Real LLM-backed bilingual classroom summary."""

from __future__ import annotations

import logging
import json
from typing import Any

from app.prompts.summary_prompt import build_summary_prompt
from app.schemas.finalize_schema import Summary
from app.services.summary_quality import (
    build_summary_audit_prompt,
    build_conservative_summary_fields,
    build_summary_retry_prompt,
    find_summary_quality_issues,
    parse_summary_audit,
)
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

    async def _call_summary_llm(self, prompt: str, max_tokens: int) -> str:
        try:
            return await chat(
                prompt, temperature=0.2, force_json=True, max_tokens=max_tokens
            )
        except LLMConfigError:
            # Hard misconfiguration: do not retry.
            raise
        except LLMError:
            # Gateway/model may not support response_format -> retry plain.
            return await chat(
                prompt, temperature=0.2, force_json=False, max_tokens=max_tokens
            )

    def _summary_from_dict(self, data: dict[str, Any]) -> Summary:
        assert isinstance(data, dict)  # narrow for type-checkers
        return Summary(
            summaryTh=str(data.get("summaryTh", "")).strip(),
            summaryEn=str(data.get("summaryEn", "")).strip(),
            keyPointsTh=_as_str_list(data.get("keyPointsTh")),
            keyPointsEn=_as_str_list(data.get("keyPointsEn")),
        )

    def _parse_summary(self, raw: str) -> Summary:
        data = parse_json(raw, expect="object")
        assert isinstance(data, dict)
        return self._summary_from_dict(data)

    async def generate(
        self,
        full_thai_transcript: str,
        full_english_translation: str,
        glossary: list[tuple[str, str]] | None = None,
    ) -> Summary:
        glossary = glossary or []
        prompt = build_summary_prompt(
            full_thai_transcript,
            full_english_translation,
            glossary=glossary,
        )

        # Long-form lecture summary: allow a large completion so detailed
        # multi-paragraph Thai + English summaries are not cut off.
        max_tokens = 6000
        try:
            raw = await self._call_summary_llm(prompt, max_tokens)
        except LLMConfigError as exc:
            logger.error("Summary LLM not configured: %s", exc)
            raise SummaryError(str(exc), config_error=True) from exc
        except LLMError as exc:
            logger.exception("Summary LLM call failed")
            raise SummaryError(str(exc)) from exc

        try:
            summary = self._parse_summary(raw)
        except ValueError as exc:
            logger.error("Summary JSON parse failed: %s", raw[:300])
            raise SummaryError(f"could not parse summary JSON: {exc}") from exc

        issues = find_summary_quality_issues(full_thai_transcript, summary, glossary)
        if issues:
            logger.warning(
                "Summary term coverage failed issues=%s",
                ",".join(issue.code for issue in issues),
            )
            retry_prompt = build_summary_retry_prompt(
                prompt,
                json.dumps(summary.model_dump(), ensure_ascii=False),
                issues,
            )
            try:
                retry_raw = await self._call_summary_llm(retry_prompt, max_tokens)
                summary = self._parse_summary(retry_raw)
            except (LLMError, ValueError) as exc:
                logger.warning("Summary term retry failed: %s", exc)
                return Summary(
                    **build_conservative_summary_fields(full_thai_transcript, glossary)
                )

        audit_prompt = build_summary_audit_prompt(
            full_thai_transcript,
            full_english_translation,
            json.dumps(summary.model_dump(), ensure_ascii=False),
            glossary,
        )
        try:
            audit_raw = await self._call_summary_llm(audit_prompt, max_tokens)
            audit = parse_summary_audit(parse_json(audit_raw, expect="object"))
        except (LLMError, ValueError) as exc:
            logger.warning("Summary audit skipped: %s", exc)
            audit = None

        if audit is not None and not audit.is_faithful and audit.corrected_summary:
            logger.warning(
                "Summary audit corrected issues=%s",
                ",".join(audit.issues),
            )
            summary = self._summary_from_dict(audit.corrected_summary)

        final_issues = find_summary_quality_issues(
            full_thai_transcript, summary, glossary
        )
        if final_issues:
            logger.error(
                "Summary still failed deterministic quality after audit issues=%s",
                ",".join(issue.code for issue in final_issues),
            )
            return Summary(
                **build_conservative_summary_fields(full_thai_transcript, glossary)
            )
        return summary


def get_summary_service() -> SummaryService:
    """Provider for use by the finalize router/service."""

    return SummaryService()
