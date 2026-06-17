"""POST /ai/translate/th-to-en — Thai to English translation."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.schemas.translate_schema import TranslateRequest, TranslateResponse
from app.services.thai_to_english_translation_service import (
    ThaiToEnglishTranslationService,
    TranslationError,
    get_translation_service,
)

router = APIRouter(prefix="/ai/translate", tags=["translate"])


@router.post("/th-to-en", response_model=TranslateResponse)
async def translate_th_to_en(
    request: TranslateRequest,
    service: ThaiToEnglishTranslationService = Depends(get_translation_service),
) -> TranslateResponse:
    """Translate a Thai utterance to English via the LLM."""

    try:
        return await service.translate(request)
    except TranslationError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        ) from exc
