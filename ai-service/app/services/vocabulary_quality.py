"""Quality helpers for vocabulary extracted from classroom transcripts."""

from __future__ import annotations

from typing import Callable, Protocol

from app.services.mock_dictionary_source import mock_dictionary_source_for


class VocabularyLike(Protocol):
    word: str
    pronunciation: str
    partOfSpeech: str
    meaningTh: str
    meaningEn: str
    exampleSentenceEn: str
    exampleSentenceTh: str
    difficultyLevel: str
    dictionarySource: str


def _default_vocab_factory(**kwargs: str) -> VocabularyLike:
    from app.schemas.finalize_schema import Vocabulary

    return Vocabulary(**kwargs)


def required_vocabulary_from_terms(
    full_thai_transcript: str,
    terms: list[tuple[str, str]],
    vocab_factory: Callable[..., VocabularyLike] = _default_vocab_factory,
) -> list[VocabularyLike]:
    """Build generic vocabulary rows for dynamic protected terms."""

    rows: list[VocabularyLike] = []
    for th, en in terms:
        th = (th or "").strip()
        en = (en or "").strip()
        if not th or not en or th not in full_thai_transcript:
            continue
        rows.append(
            vocab_factory(
                word=en,
                pronunciation="",
                partOfSpeech="noun",
                meaningTh=th,
                meaningEn=en,
                exampleSentenceEn=f"The lesson includes {en}.",
                exampleSentenceTh=f"บทเรียนมีคำว่า {th}",
                difficultyLevel="beginner",
                dictionarySource=mock_dictionary_source_for(en),
            )
        )
    return rows


def sanitize_vocabulary(
    vocabularies: list[VocabularyLike],
    full_thai_transcript: str,
    terms: list[tuple[str, str]],
    vocab_factory: Callable[..., VocabularyLike] = _default_vocab_factory,
) -> list[VocabularyLike]:
    """Ensure dynamic protected terms are present and de-duplicate words."""

    required = required_vocabulary_from_terms(
        full_thai_transcript,
        terms,
        vocab_factory,
    )
    by_word: dict[str, VocabularyLike] = {}

    for vocab in vocabularies:
        word = (vocab.word or "").strip()
        if not word:
            continue
        by_word[word.lower()] = vocab

    for vocab in required:
        key = vocab.word.lower()
        existing = by_word.get(key)
        if existing is None:
            by_word[key] = vocab
            continue
        if not existing.meaningTh:
            existing.meaningTh = vocab.meaningTh
        if not existing.meaningEn:
            existing.meaningEn = vocab.meaningEn
        if not existing.exampleSentenceEn:
            existing.exampleSentenceEn = vocab.exampleSentenceEn
        if not existing.exampleSentenceTh:
            existing.exampleSentenceTh = vocab.exampleSentenceTh
        if not existing.dictionarySource:
            existing.dictionarySource = vocab.dictionarySource

    ordered: list[VocabularyLike] = []
    seen: set[str] = set()
    for vocab in required:
        key = vocab.word.lower()
        if key in by_word and key not in seen:
            ordered.append(by_word[key])
            seen.add(key)
    for key, vocab in by_word.items():
        if key not in seen:
            ordered.append(vocab)
            seen.add(key)
    return ordered
