"""Exact vocabulary-extraction prompt template."""

from __future__ import annotations

VOCABULARY_PROMPT_TEMPLATE = """You are an English learning assistant for Thai students.

Extract useful English vocabulary from the classroom transcript.

Rules:
- Use the Thai transcript as the source of truth. The English translation is only
  a helper and may contain mistakes.
- Focus on concrete English words useful for kindergarten/primary Thai students.
- Include required glossary terms when they appear in the Thai transcript.
- Do not include noise words from mistaken speech recognition or mistranslation
  unless clearly part of the lesson content.
- Do not include too many basic words unless they are important to the lesson.
- Include pronunciation, meaning, part of speech, and examples.
- meaningTh must be in Thai.
- meaningEn must be in English.
- dictionarySource may be left empty. The system will add demo mock dictionary
  attribution after extraction.
- Return 3-12 words depending on transcript length. If the transcript is short,
  return a short accurate list.
- Return valid JSON only.
{{glossaryBlock}}

Thai Transcript:
{{fullThaiTranscript}}

English Translation:
{{fullEnglishTranslation}}

Return JSON: [ { "word":"","pronunciation":"","partOfSpeech":"","meaningTh":"","meaningEn":"","exampleSentenceEn":"","exampleSentenceTh":"","difficultyLevel":"beginner","dictionarySource":"" } ]
"""


def _render_glossary_block(glossary: list[tuple[str, str]] | None) -> str:
    if not glossary:
        return ""
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
        "\nRequired glossary terms. These MUST appear as vocabulary entries if "
        "they appear in the Thai transcript:\n"
        f"{lines}\n"
    )

def build_vocabulary_prompt(
    full_english_translation: str,
    full_thai_transcript: str = "",
    glossary: list[tuple[str, str]] | None = None,
) -> str:
    """Render the vocabulary prompt with transcript, translation, and glossary."""

    return (
        VOCABULARY_PROMPT_TEMPLATE
        .replace("{{glossaryBlock}}", _render_glossary_block(glossary))
        .replace("{{fullThaiTranscript}}", full_thai_transcript)
        .replace("{{fullEnglishTranslation}}", full_english_translation)
    )
