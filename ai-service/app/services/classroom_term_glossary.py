"""Term-pair helpers for classroom translation guidance.

This module intentionally does not contain a fixed vocabulary list. Term pairs
come from teacher-provided context, the rolling session glossary, or the dynamic
term extractor that reads the Thai transcript.
"""

from __future__ import annotations

from collections.abc import Iterable


def classroom_glossary_for(
    source_text: str,
    context_note: str = "",
) -> list[tuple[str, str]]:
    """Return built-in glossary pairs for a text.

    Kept as a compatibility shim; the product should not rely on hardcoded terms.
    Dynamic transcript terms are produced by ``term_extraction_service``.
    """

    _ = source_text, context_note
    return []


def merge_classroom_glossary(
    source_text: str,
    context_note: str,
    request_glossary: Iterable[tuple[str, str]],
) -> list[tuple[str, str]]:
    """Return cleaned request/session glossary pairs with later values winning."""

    _ = source_text, context_note
    seen: dict[str, str] = {}
    for th, en in request_glossary:
        th = (th or "").strip()
        en = (en or "").strip()
        if th and en:
            seen[th] = en
    return list(seen.items())
