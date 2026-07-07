"""Accuracy checks for live Thai->English classroom translation."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class MissingGlossaryTerm:
    """A required Thai term whose English rendering is absent from output."""

    th: str
    en: str


@dataclass(frozen=True)
class TranslationAuditResult:
    """LLM audit result for one Thai->English translation."""

    is_accurate: bool
    corrected_translation: str = ""
    issues: tuple[str, ...] = ()


def _normalize_english(text: str) -> str:
    text = (text or "").lower()
    text = text.replace("-", " ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _pluralize_last_word(term: str) -> str:
    parts = term.split()
    if not parts:
        return term
    last = parts[-1]
    if last.endswith(("s", "x", "ch", "sh")):
        parts[-1] = f"{last}es"
    elif last.endswith("y") and len(last) > 1 and last[-2] not in "aeiou":
        parts[-1] = f"{last[:-1]}ies"
    else:
        parts[-1] = f"{last}s"
    return " ".join(parts)


def _english_variants(term: str) -> set[str]:
    normalized = _normalize_english(term)
    if not normalized:
        return set()
    variants = {normalized, _pluralize_last_word(normalized)}
    if " " in normalized:
        variants.add(normalized.replace(" ", ""))
    return {variant for variant in variants if variant}


def _contains_english_term(translated_text: str, expected_en: str) -> bool:
    normalized_output = f" {_normalize_english(translated_text)} "
    return any(f" {variant} " in normalized_output for variant in _english_variants(expected_en))


def find_missing_glossary_terms(
    source_text: str,
    translated_text: str,
    glossary: Iterable[tuple[str, str]],
) -> list[MissingGlossaryTerm]:
    """Find glossary terms spoken in Thai that are missing from the translation.

    The glossary is de-duplicated by Thai term with later entries winning, which
    matches prompt rendering and lets session-specific terms override defaults.
    """

    source = source_text or ""
    required: dict[str, str] = {}
    for th, en in glossary:
        th = (th or "").strip()
        en = (en or "").strip()
        if th and en and th in source:
            required[th] = en
    return [
        MissingGlossaryTerm(th=th, en=en)
        for th, en in required.items()
        if not _contains_english_term(translated_text, en)
    ]


def build_glossary_retry_prompt(
    original_prompt: str,
    previous_translation: str,
    missing_terms: Iterable[MissingGlossaryTerm],
) -> str:
    """Build a stricter correction prompt after the first translation failed QA."""

    missing_lines = "\n".join(f"- {term.th} => {term.en}" for term in missing_terms)
    return (
        f"{original_prompt.rstrip()}\n\n"
        "Accuracy check failed. The previous English output omitted required "
        "classroom vocabulary that appeared in the Thai input.\n"
        "Previous English output:\n"
        f"{previous_translation.strip()}\n\n"
        "Required terms that MUST appear in the corrected English output:\n"
        f"{missing_lines}\n\n"
        "Rewrite the English translation as a natural sentence for children. "
        "Include every required English term exactly as listed above unless normal "
        "pluralization is grammatically needed. Output only the corrected English."
    )


TRANSLATION_AUDIT_PROMPT_TEMPLATE = """You are a strict bilingual Thai-to-English accuracy reviewer for a children's classroom.

Check whether the English translation faithfully preserves the Thai input.

Rules:
- Use the Thai input as the source of truth.
- Detect omitted content, mistranslated terms, wrong subjects/objects, wrong
  quantities, and invented details.
- Pay special attention to compact Thai noun phrases with no spaces; if they
  contain several meaningful content terms, the English must include all of them.
- Do not merge adjacent Thai content terms into one modifier phrase unless the
  Thai clearly says one modifies the other. When unsure, preserve them as
  separate items joined with "and".
- If the translation is accurate, keep it.
- If it is inaccurate, rewrite one natural English sentence suitable for children.
- Do not explain in the corrected translation.
- Return valid JSON only.

Thai input:
{{sourceText}}

English translation to review:
{{translatedText}}

Optional lesson context:
{{contextNote}}

Return JSON:
{
  "isAccurate": true,
  "correctedTranslation": "",
  "issues": []
}
"""


def build_translation_audit_prompt(
    source_text: str,
    translated_text: str,
    context_note: str = "",
) -> str:
    """Render a generic translation-faithfulness audit prompt."""

    return (
        TRANSLATION_AUDIT_PROMPT_TEMPLATE
        .replace("{{sourceText}}", source_text)
        .replace("{{translatedText}}", translated_text)
        .replace("{{contextNote}}", context_note)
    )


def parse_translation_audit(raw: Any) -> TranslationAuditResult:
    """Coerce parsed audit JSON into a typed result."""

    data = raw if isinstance(raw, dict) else {}
    is_accurate = bool(data.get("isAccurate", False))
    corrected = str(data.get("correctedTranslation", "")).strip()
    raw_issues = data.get("issues", [])
    issues: tuple[str, ...]
    if isinstance(raw_issues, list):
        issues = tuple(str(issue).strip() for issue in raw_issues if str(issue).strip())
    else:
        issues = ()
    return TranslationAuditResult(
        is_accurate=is_accurate,
        corrected_translation=corrected,
        issues=issues,
    )
