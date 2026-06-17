"""LLM helpers: AsyncOpenAI client factory, chat wrapper, JSON parsing.

The whole AI pipeline (translation, summary, vocabulary, flashcards) speaks to
an OpenAI-compatible Chat Completions endpoint. This module centralizes:

* client construction (api_key / model / optional base_url),
* a thin async ``chat()`` wrapper, and
* robust JSON parsing that survives code fences and stray prose.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Any, Optional, Union

from openai import AsyncOpenAI

from app.config import get_settings


class LLMError(RuntimeError):
    """Raised for LLM invocation/transport failures."""


class LLMConfigError(LLMError):
    """Raised for hard LLM misconfiguration (missing api key / model).

    A subclass of LLMError so callers that catch LLMError still handle it, but
    distinguishable for callers that must surface config errors (HTTP 502)
    rather than degrade gracefully.
    """


class LLMParseError(ValueError):
    """Raised when an LLM response cannot be parsed as expected JSON."""


@lru_cache(maxsize=1)
def get_llm_client() -> AsyncOpenAI:
    """Return a cached AsyncOpenAI client built from settings.

    ``base_url`` defaults to OpenRouter (https://openrouter.ai/api/v1); override
    LLM_BASE_URL for any other OpenAI-compatible gateway. OpenRouter attribution
    headers (HTTP-Referer / X-Title) are attached when configured and are
    harmlessly ignored by other gateways.
    """

    settings = get_settings()
    if not settings.LLM_API_KEY:
        raise LLMConfigError("LLM_API_KEY is not configured")

    kwargs: dict[str, Any] = {"api_key": settings.LLM_API_KEY}
    if settings.LLM_BASE_URL:
        kwargs["base_url"] = settings.LLM_BASE_URL

    default_headers: dict[str, str] = {}
    if settings.LLM_HTTP_REFERER:
        default_headers["HTTP-Referer"] = settings.LLM_HTTP_REFERER
    if settings.LLM_APP_TITLE:
        default_headers["X-Title"] = settings.LLM_APP_TITLE
    if default_headers:
        kwargs["default_headers"] = default_headers

    return AsyncOpenAI(**kwargs)


async def chat(
    prompt: str,
    *,
    temperature: float = 0.2,
    force_json: bool = False,
    system: Optional[str] = None,
    max_tokens: Optional[int] = None,
) -> str:
    """Send a single-prompt chat completion and return the text content.

    Args:
        prompt: The user prompt (already fully rendered).
        temperature: Sampling temperature.
        force_json: When True, request ``response_format={"type":"json_object"}``.
            Gateways that don't support it raise; callers that may hit such a
            gateway should keep ``force_json=False`` and rely on ``parse_json``.
        system: Optional system message prepended to the conversation.
        max_tokens: Optional cap on completion length. Raise it for long-form
            output (e.g. a detailed lecture summary) so the model is not cut off.
    """

    settings = get_settings()
    if not settings.LLM_MODEL:
        raise LLMConfigError("LLM_MODEL is not configured")

    client = get_llm_client()

    messages: list[dict[str, str]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    request_kwargs: dict[str, Any] = {
        "model": settings.LLM_MODEL,
        "messages": messages,
        "temperature": temperature,
    }
    if max_tokens is not None:
        request_kwargs["max_tokens"] = max_tokens
    if force_json:
        request_kwargs["response_format"] = {"type": "json_object"}

    try:
        completion = await client.chat.completions.create(**request_kwargs)
    except Exception as exc:  # noqa: BLE001 - normalize all SDK/transport errors
        raise LLMError(f"LLM request failed: {exc}") from exc

    if not completion.choices:
        raise LLMError("LLM returned no choices")

    content = completion.choices[0].message.content
    if content is None:
        raise LLMError("LLM returned empty content")
    return content.strip()


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def _strip_code_fences(text: str) -> str:
    """Remove a leading/trailing Markdown code fence if present."""

    stripped = text.strip()
    if stripped.startswith("```"):
        # Drop the opening fence line and any trailing fence.
        stripped = _FENCE_RE.sub("", stripped)
        # The regex above only handles single-line fences cleanly; do a second
        # defensive pass for multi-line ```json ... ``` blocks.
        if stripped.startswith("```"):
            lines = stripped.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip().startswith("```"):
                lines = lines[:-1]
            stripped = "\n".join(lines)
    return stripped.strip()


def _extract_json_blob(text: str, expect: str) -> str:
    """Best-effort extraction of the first JSON object/array in ``text``.

    ``expect`` is "object" or "array". Falls back to scanning for the matching
    opening/closing bracket pair when the response wraps JSON in prose.
    """

    open_ch, close_ch = ("{", "}") if expect == "object" else ("[", "]")
    start = text.find(open_ch)
    end = text.rfind(close_ch)
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


def parse_json(
    text: str, *, expect: str = "object"
) -> Union[dict[str, Any], list[Any]]:
    """Robustly parse an LLM response into a dict or list.

    Handles Markdown code fences and surrounding prose. ``expect`` selects the
    JSON shape ("object" or "array") for the fallback bracket-scan.
    """

    if expect not in ("object", "array"):
        raise ValueError("expect must be 'object' or 'array'")

    cleaned = _strip_code_fences(text)

    # First attempt: parse the cleaned text directly.
    for candidate in (cleaned, _extract_json_blob(cleaned, expect)):
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if expect == "object" and isinstance(parsed, dict):
            return parsed
        if expect == "array" and isinstance(parsed, list):
            return parsed

    raise LLMParseError(
        f"could not parse LLM response as JSON {expect}: {text[:300]!r}"
    )
