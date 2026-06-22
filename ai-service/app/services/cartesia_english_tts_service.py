"""Real Cartesia English text-to-speech -> base64 mp3.

Uses the stable Cartesia REST endpoint POST https://api.cartesia.ai/tts/bytes
via httpx. This keeps us decoupled from any single SDK method signature while
still calling the real service. The endpoint returns raw audio bytes which we
base64-encode for transport to the backend/frontend.

On any Cartesia failure we raise ``TtsError``; the router maps this to HTTP 502
so the backend can treat TTS as non-fatal (translation is already delivered).
"""

from __future__ import annotations

import base64
import logging

import httpx

from app.config import get_settings
from app.schemas.tts_schema import TtsRequest, TtsResponse

logger = logging.getLogger(__name__)

CARTESIA_TTS_URL = "https://api.cartesia.ai/tts/bytes"
CARTESIA_VERSION = "2025-04-16"
# mp3 container; 44.1kHz / 128kbps is the recommended Sonic output for speech.
OUTPUT_SAMPLE_RATE = 44100
OUTPUT_BIT_RATE = 128000
REQUEST_TIMEOUT_SECONDS = 30.0

# Shared, connection-pooled client so we don't pay a TLS handshake on every TTS
# call (the cold-start cost). Built lazily; warmed at app startup.
_client: httpx.AsyncClient | None = None


def get_cartesia_client() -> httpx.AsyncClient:
    """Return the process-wide pooled httpx client (keep-alive connections)."""

    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT_SECONDS,
            limits=httpx.Limits(max_keepalive_connections=10, keepalive_expiry=60.0),
        )
    return _client


async def close_cartesia_client() -> None:
    """Close the pooled client on shutdown."""

    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


class TtsError(RuntimeError):
    """Raised when Cartesia TTS fails (router -> HTTP 502)."""


def _estimate_duration_ms(text: str) -> int:
    """Rough spoken-duration estimate from word count.

    ~150 words/minute (400ms/word) is a reasonable English speaking rate.
    Used only for UI hints; not authoritative.
    """

    words = max(1, len(text.split()))
    return int(words * 400)


class CartesiaEnglishTtsService:
    """Service wrapper around the Cartesia TTS bytes endpoint."""

    async def synthesize(self, request: TtsRequest) -> TtsResponse:
        settings = get_settings()

        if not settings.CARTESIA_API_KEY:
            raise TtsError("CARTESIA_API_KEY is not configured")
        if not settings.CARTESIA_VOICE_ID:
            raise TtsError("CARTESIA_VOICE_ID is not configured")

        headers = {
            "Cartesia-Version": CARTESIA_VERSION,
            "Authorization": f"Bearer {settings.CARTESIA_API_KEY}",
            "Content-Type": "application/json",
        }
        body = {
            "transcript": request.text,
            "model_id": settings.CARTESIA_MODEL,
            "voice": {"mode": "id", "id": settings.CARTESIA_VOICE_ID},
            "output_format": {
                "container": "mp3",
                "sample_rate": OUTPUT_SAMPLE_RATE,
                "bit_rate": OUTPUT_BIT_RATE,
            },
            # Language from CARTESIA_TTS_LANGUAGE (e.g. "en").
            "language": settings.CARTESIA_TTS_LANGUAGE,
        }

        try:
            client = get_cartesia_client()
            response = await client.post(
                CARTESIA_TTS_URL, headers=headers, json=body
            )
        except httpx.HTTPError as exc:
            logger.exception("Cartesia request error session=%s", request.sessionId)
            raise TtsError(f"cartesia request failed: {exc}") from exc

        if response.status_code != 200:
            detail = response.text[:300]
            logger.error(
                "Cartesia non-200 session=%s status=%s body=%s",
                request.sessionId,
                response.status_code,
                detail,
            )
            raise TtsError(
                f"cartesia returned {response.status_code}: {detail}"
            )

        audio_bytes = response.content
        if not audio_bytes:
            raise TtsError("cartesia returned empty audio")

        audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
        logger.info(
            "TTS ok session=%s model=%s bytes=%d",
            request.sessionId,
            settings.CARTESIA_MODEL,
            len(audio_bytes),
        )

        return TtsResponse(
            audioUrl="",
            audioBase64=audio_b64,
            language="en-US",
            durationMs=_estimate_duration_ms(request.text),
        )


def get_tts_service() -> CartesiaEnglishTtsService:
    """FastAPI dependency provider."""

    return CartesiaEnglishTtsService()
