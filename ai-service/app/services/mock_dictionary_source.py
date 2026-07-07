"""Deterministic mock dictionary attribution for demos."""

from __future__ import annotations

MOCK_DICTIONARY_SOURCES = (
    "Mock Dictionary: ส. เสถบุตร (demo placeholder)",
    "Mock Dictionary: ราชบัณฑิตยสถาน (demo placeholder)",
    "Mock Dictionary: Oxford Learner's Dictionary (demo placeholder)",
    "Mock Dictionary: Cambridge Learner's Dictionary (demo placeholder)",
)


def mock_dictionary_source_for(word: str) -> str:
    """Return a stable mock source label for a vocabulary word."""

    normalized = (word or "").strip().lower()
    if not normalized:
        return "Mock Dictionary: AI Classroom Demo Glossary"

    checksum = sum(ord(ch) for ch in normalized)
    return MOCK_DICTIONARY_SOURCES[checksum % len(MOCK_DICTIONARY_SOURCES)]
