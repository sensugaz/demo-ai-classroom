"""OpenAI Realtime Translation client-secret minting."""

from __future__ import annotations

import hashlib
import logging

import httpx

from app.config import get_settings
from app.schemas.realtime_translation_schema import (
    RealtimeTranslationClientSecretRequest,
    RealtimeTranslationClientSecretResponse,
)

logger = logging.getLogger(__name__)

CLIENT_SECRET_URL = "https://api.openai.com/v1/realtime/translations/client_secrets"
REALTIME_TRANSLATION_MODEL = "gpt-realtime-translate"
REALTIME_TRANSCRIPTION_MODEL = "gpt-realtime-whisper"
CLIENT_SECRET_TTL_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 15.0

_client: httpx.AsyncClient | None = None


class RealtimeTranslationConfigurationError(RuntimeError):
    """Raised when the server-only OpenAI credential is unavailable."""


class RealtimeTranslationError(RuntimeError):
    """Raised when OpenAI cannot mint a usable client secret."""


def get_realtime_translation_client() -> httpx.AsyncClient:
    """Return the shared connection-pooled OpenAI HTTP client."""

    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT_SECONDS,
            limits=httpx.Limits(max_keepalive_connections=10, keepalive_expiry=60.0),
        )

    return _client


async def close_realtime_translation_client() -> None:
    """Close the shared OpenAI client during application shutdown."""

    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


class OpenAIRealtimeTranslationService:
    """Mint short-lived browser credentials without exposing the server API key."""

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    async def mint_client_secret(
        self, request: RealtimeTranslationClientSecretRequest
    ) -> RealtimeTranslationClientSecretResponse:
        settings = get_settings()
        if not settings.OPENAI_API_KEY:
            raise RealtimeTranslationConfigurationError(
                "OPENAI_API_KEY is not configured"
            )

        safety_identifier = hashlib.sha256(request.sessionId.encode("utf-8")).hexdigest()
        body = {
            "expires_after": {
                "anchor": "created_at",
                "seconds": CLIENT_SECRET_TTL_SECONDS,
            },
            "session": {
                "model": REALTIME_TRANSLATION_MODEL,
                "audio": {
                    "input": {
                        "transcription": {"model": REALTIME_TRANSCRIPTION_MODEL},
                        "noise_reduction": {"type": "near_field"},
                    },
                    "output": {"language": "en"},
                },
            },
        }
        headers = {
            "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
            "Content-Type": "application/json",
            "OpenAI-Safety-Identifier": safety_identifier,
        }

        try:
            client = self._client or get_realtime_translation_client()
            response = await client.post(CLIENT_SECRET_URL, headers=headers, json=body)
        except httpx.HTTPError as exc:
            logger.warning(
                "realtime translation client-secret request failed session=%s error=%s",
                request.sessionId,
                type(exc).__name__,
            )
            raise RealtimeTranslationError(
                "OpenAI client-secret request failed"
            ) from exc

        if response.status_code != 200:
            logger.warning(
                "realtime translation client-secret rejected session=%s status=%s",
                request.sessionId,
                response.status_code,
            )
            raise RealtimeTranslationError(
                f"OpenAI client-secret request returned {response.status_code}"
            )

        try:
            payload = response.json()
            client_secret = payload["value"]
            expires_at = payload["expires_at"]
            translation_session_id = payload["session"]["id"]
        except (KeyError, TypeError, ValueError) as exc:
            logger.warning(
                "realtime translation client-secret response invalid session=%s",
                request.sessionId,
            )
            raise RealtimeTranslationError(
                "OpenAI returned an invalid client-secret response"
            ) from exc

        if not client_secret or not translation_session_id:
            raise RealtimeTranslationError(
                "OpenAI returned an incomplete client-secret response"
            )

        return RealtimeTranslationClientSecretResponse(
            clientSecret=str(client_secret),
            expiresAt=int(expires_at),
            translationSessionId=str(translation_session_id),
        )


def get_realtime_translation_service() -> OpenAIRealtimeTranslationService:
    """FastAPI dependency provider."""

    return OpenAIRealtimeTranslationService()
