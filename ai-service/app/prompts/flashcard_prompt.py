"""Exact flashcard-generation prompt template.

Placeholders ``{{vocabularyJson}}``, ``{{fullThaiTranscript}}``, and
``{{fullEnglishTranslation}}`` are substituted via string replace.
"""

from __future__ import annotations

FLASHCARD_PROMPT_TEMPLATE = """You are an AI flash card generator for Thai students learning English.

Create flash cards from the English vocabulary and classroom conversation.

Rules:
- Front side should be short and clear.
- Back side should explain the answer in Thai and English when useful.
- Include vocabulary cards and sentence cards.
- Make cards useful for review.
- Use English on the front side when possible.
- Use Thai explanation on the back side.
- Return valid JSON only.

Vocabulary:
{{vocabularyJson}}

Thai Transcript:
{{fullThaiTranscript}}

English Translation:
{{fullEnglishTranslation}}

Return JSON: [ { "front":"","back":"","type":"vocabulary","word":"","hintTh":"","exampleSentence":"" } ]
"""


def build_flashcard_prompt(
    vocabulary_json: str,
    full_thai_transcript: str,
    full_english_translation: str,
) -> str:
    """Render the flashcard prompt with vocab JSON and transcripts."""

    return (
        FLASHCARD_PROMPT_TEMPLATE
        .replace("{{vocabularyJson}}", vocabulary_json)
        .replace("{{fullThaiTranscript}}", full_thai_transcript)
        .replace("{{fullEnglishTranslation}}", full_english_translation)
    )
