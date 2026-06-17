"""Exact Thai->English translation prompt template.

The template uses the literal placeholder ``{{sourceText}}`` (double braces) so
it is rendered with a simple string replace, never str.format(), to avoid
clashing with any braces in the source text.
"""

from __future__ import annotations

TRANSLATION_PROMPT_TEMPLATE = """You are a classroom interpreter.

Translate Thai classroom speech into natural English.

Rules:
- Translate from Thai to English only.
- Keep the meaning accurate.
- Use clear English suitable for students.
- Do not add information that was not spoken.
- If the Thai sentence is incomplete, translate only the meaningful part.
- Preserve classroom tone.
- Do not explain.
- Do not return Thai.
- Output only the English translation.

Input Thai:
{{sourceText}}

Output English:
"""


def build_translation_prompt(source_text: str) -> str:
    """Render the translation prompt for ``source_text``."""

    return TRANSLATION_PROMPT_TEMPLATE.replace("{{sourceText}}", source_text)
