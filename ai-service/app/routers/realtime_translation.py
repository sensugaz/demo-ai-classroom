"""Internal endpoint for OpenAI Realtime Translation client secrets."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.schemas.realtime_translation_schema import (
    RealtimeTranslationClientSecretRequest,
    RealtimeTranslationClientSecretResponse,
)
from app.services.openai_realtime_translation_service import (
    OpenAIRealtimeTranslationService,
    RealtimeTranslationConfigurationError,
    RealtimeTranslationError,
    get_realtime_translation_service,
)

router = APIRouter(prefix="/ai/realtime-translation", tags=["realtime-translation"])


@router.post(
    "/client-secret", response_model=RealtimeTranslationClientSecretResponse
)
async def create_realtime_translation_client_secret(
    request: RealtimeTranslationClientSecretRequest,
    service: OpenAIRealtimeTranslationService = Depends(
        get_realtime_translation_service
    ),
) -> RealtimeTranslationClientSecretResponse:
    """Mint a short-lived credential for one validated classroom session."""

    try:
        return await service.mint_client_secret(request)
    except RealtimeTranslationConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    except RealtimeTranslationError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        ) from exc
