"""Real Google Cloud Speech-to-Text (synchronous recognize) for Thai audio.

Each request carries a self-contained WEBM/Opus blob. We decode the base64
payload and run a single synchronous ``recognize`` call configured for
WEBM_OPUS @ 48kHz, th-TH, with automatic punctuation.

The blocking gRPC call is offloaded to a worker thread so it does not stall the
asyncio event loop.

Future enhancement (NOT a mock): interim/partial streaming via
``streaming_recognize`` to emit ``transcript:partial`` events mid-utterance.
That is out of scope for the per-chunk sync contract used today.
TODO(streaming): wire StreamingRecognize for interim partial transcripts.
"""

from __future__ import annotations

import asyncio
import logging
import re
from functools import lru_cache

from google.cloud import speech

from app.config import get_settings
from app.schemas.stt_schema import SttRequest, SttResponse
from app.utils.audio import decode_base64_audio

logger = logging.getLogger(__name__)


class SttError(RuntimeError):
    """Raised when speech recognition fails."""


@lru_cache(maxsize=1)
def _get_speech_client() -> speech.SpeechClient:
    """Cached SpeechClient.

    Credentials are resolved by the google-auth library from
    GOOGLE_APPLICATION_CREDENTIALS (set in the process environment via the
    container env / settings). We do not pass credentials explicitly.
    """

    return speech.SpeechClient()


# Boost applied to context phrases. Moderate value: biases toward expected terms
# without forcing them when the audio clearly says something else.
_PHRASE_BOOST = 15.0
# Google caps total adaptation; keep a sane ceiling on derived phrases.
_MAX_PHRASES = 400


def _build_phrases(context_note: str) -> list[str]:
    """Derive speech-adaptation phrase hints from the teacher's synopsis.

    Generic and content-driven: we tokenize the free-text note into words and
    short multi-word runs so the recognizer is biased toward the exact terms the
    lesson will use (names, foods, domain words) so mis-hears are handled from
    teacher-provided context instead of hardcoded vocabulary.
    """

    note = (context_note or "").strip()
    if not note:
        return []

    # Split on whitespace and common punctuation (works for space-separated Thai
    # terms and English alike). Keep the full note too as a sentence-level hint.
    raw = re.split(r"[\s,;.!?()\[\]{}\"'“”‘’·/|—–-]+", note)
    seen: dict[str, None] = {}
    for token in raw:
        token = token.strip()
        # Drop empties and 1-char fragments (too weak to bias usefully).
        if len(token) < 2:
            continue
        if token not in seen:
            seen[token] = None
        if len(seen) >= _MAX_PHRASES:
            break

    phrases = list(seen.keys())
    # A trimmed full-note phrase adds sequence-level context (capped length).
    if note and len(phrases) < _MAX_PHRASES:
        phrases.append(note[:200])
    return phrases


def _recognize_sync(
    audio_bytes: bytes, language_code: str, context_note: str = ""
) -> tuple[str, float, bool]:
    """Run a blocking synchronous recognize. Returns (text, confidence, is_final)."""

    client = _get_speech_client()

    phrases = _build_phrases(context_note)
    speech_contexts = (
        [speech.SpeechContext(phrases=phrases, boost=_PHRASE_BOOST)]
        if phrases
        else []
    )

    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
        sample_rate_hertz=48000,
        language_code=language_code,
        enable_automatic_punctuation=True,
        speech_contexts=speech_contexts,
    )
    audio = speech.RecognitionAudio(content=audio_bytes)

    response = client.recognize(config=config, audio=audio)

    # Concatenate the top alternative of each result. Sync recognize returns
    # final results only, so isFinal is always True here.
    text_parts: list[str] = []
    confidences: list[float] = []
    for result in response.results:
        if not result.alternatives:
            continue
        top = result.alternatives[0]
        if top.transcript:
            text_parts.append(top.transcript)
        # confidence may be 0.0 when not provided by the model.
        if top.confidence:
            confidences.append(top.confidence)

    text = " ".join(part.strip() for part in text_parts).strip()
    confidence = sum(confidences) / len(confidences) if confidences else 0.0
    return text, confidence, True


class GoogleSttService:
    """Service wrapper around Google sync speech recognition."""

    async def transcribe(self, request: SttRequest) -> SttResponse:
        settings = get_settings()
        audio_bytes = decode_base64_audio(request.audioBase64)

        if not audio_bytes:
            raise SttError("decoded audio is empty")

        try:
            text, confidence, is_final = await asyncio.to_thread(
                _recognize_sync,
                audio_bytes,
                settings.GOOGLE_STT_LANGUAGE_CODE,
                request.contextNote,
            )
        except Exception as exc:  # noqa: BLE001 - normalize gRPC/transport errors
            logger.exception(
                "STT failed for session=%s seq=%s", request.sessionId, request.sequenceNo
            )
            raise SttError(f"speech recognition failed: {exc}") from exc

        logger.info(
            "STT ok session=%s seq=%s chars=%d confidence=%.3f",
            request.sessionId,
            request.sequenceNo,
            len(text),
            confidence,
        )

        return SttResponse(
            sessionId=request.sessionId,
            text=text,
            language=settings.GOOGLE_STT_LANGUAGE_CODE,
            isFinal=is_final,
            confidence=confidence,
        )


def get_google_stt_service() -> GoogleSttService:
    """FastAPI dependency provider."""

    return GoogleSttService()
