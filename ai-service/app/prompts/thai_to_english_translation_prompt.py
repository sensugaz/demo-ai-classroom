"""Exact Thai->English translation prompt template.

The template uses the literal placeholder ``{{sourceText}}`` (double braces) so
it is rendered with a simple string replace, never str.format(), to avoid
clashing with any braces in the source text.

Two optional guidance blocks are injected when available:
- a lesson context note (topic / story synopsis) the teacher supplied up front, and
- a glossary of recently confirmed term translations,
so proper nouns and domain terms translate accurately and consistently.
"""

from __future__ import annotations

from typing import Iterable

TRANSLATION_PROMPT_TEMPLATE = """You are a classroom interpreter.

Translate Thai classroom speech into natural English.

Rules:
- Translate from Thai to English only.
- Keep the meaning accurate.
- Use clear English suitable for students.
- Do not add information that was not spoken.
- If the Thai sentence is incomplete, translate only the meaningful part.
- Preserve classroom tone.
- Translate Thai proper nouns, names, foods, and cultural terms to their correct,
  commonly-accepted English equivalents. Use the lesson context and the
  established translations above to disambiguate similar-sounding words.
- Do not explain.
- Do not return Thai.
- Output only the English translation.
{{contextBlock}}{{glossaryBlock}}
Input Thai:
{{sourceText}}

Output English:
"""


def _render_context_block(context_note: str) -> str:
    note = (context_note or "").strip()
    if not note:
        return ""
    return (
        "\nLesson context (use to disambiguate names and terms; do NOT translate "
        "this block, do not add its facts unless spoken):\n"
        f"{note}\n"
    )


def _render_glossary_block(glossary: Iterable[tuple[str, str]]) -> str:
    # Keep only pairs where both sides are present and de-duplicate by Thai term,
    # preserving the most recent rendering.
    seen: dict[str, str] = {}
    for th, en in glossary:
        th = (th or "").strip()
        en = (en or "").strip()
        if th and en:
            seen[th] = en
    if not seen:
        return ""
    lines = "\n".join(f"- {th} => {en}" for th, en in seen.items())
    return (
        "\nEstablished translations — reuse these EXACT English renderings for the "
        "same Thai terms so the lesson stays consistent:\n"
        f"{lines}\n"
    )


def build_translation_prompt(
    source_text: str,
    context_note: str = "",
    glossary: Iterable[tuple[str, str]] | None = None,
) -> str:
    """Render the translation prompt for ``source_text`` with optional guidance."""

    return (
        TRANSLATION_PROMPT_TEMPLATE
        .replace("{{contextBlock}}", _render_context_block(context_note))
        .replace("{{glossaryBlock}}", _render_glossary_block(glossary or []))
        .replace("{{sourceText}}", source_text)
    )
