"""POST /ai/tts/en — English text-to-speech via Cartesia.

On Cartesia failure we return HTTP 502 so the backend can treat TTS as
non-fatal (the translation has already been delivered to the client).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.schemas.tts_schema import TtsRequest, TtsResponse
from app.services.cartesia_english_tts_service import (
    CartesiaEnglishTtsService,
    TtsError,
    get_tts_service,
)

router = APIRouter(prefix="/ai/tts", tags=["tts"])


@router.post("/en", response_model=TtsResponse)
async def synthesize_english(
    request: TtsRequest,
    service: CartesiaEnglishTtsService = Depends(get_tts_service),
) -> TtsResponse:
    """Synthesize English speech and return base64 mp3 audio."""

    try:
        return await service.synthesize(request)
    except TtsError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        ) from exc
