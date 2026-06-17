"""Exact vocabulary-extraction prompt template.

Placeholder ``{{fullEnglishTranslation}}`` is substituted via string replace.
"""

from __future__ import annotations

VOCABULARY_PROMPT_TEMPLATE = """You are an English learning assistant for Thai students.

Extract useful English vocabulary from the English translation.

Rules:
- Focus on English words useful for Thai students.
- Include words that appeared in the English translation.
- Do not include too many basic words unless they are important.
- Include pronunciation, meaning, part of speech, and examples.
- meaningTh must be in Thai.
- meaningEn must be in English.
- Return 10-30 words depending on transcript length.
- Return valid JSON only.

English Translation:
{{fullEnglishTranslation}}

Return JSON: [ { "word":"","pronunciation":"","partOfSpeech":"","meaningTh":"","meaningEn":"","exampleSentenceEn":"","exampleSentenceTh":"","difficultyLevel":"beginner" } ]
"""


def build_vocabulary_prompt(full_english_translation: str) -> str:
    """Render the vocabulary prompt with the given English translation."""

    return VOCABULARY_PROMPT_TEMPLATE.replace(
        "{{fullEnglishTranslation}}", full_english_translation
    )
