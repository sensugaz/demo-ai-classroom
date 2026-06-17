"""POST /ai/stt/th — Thai speech-to-text."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.schemas.stt_schema import SttRequest, SttResponse
from app.services.google_stt_service import (
    GoogleSttService,
    SttError,
    get_google_stt_service,
)
from app.utils.audio import AudioDecodeError

router = APIRouter(prefix="/ai/stt", tags=["stt"])


@router.post("/th", response_model=SttResponse)
async def transcribe_thai(
    request: SttRequest,
    service: GoogleSttService = Depends(get_google_stt_service),
) -> SttResponse:
    """Transcribe a single Thai WEBM/Opus audio chunk."""

    try:
        return await service.transcribe(request)
    except AudioDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    except SttError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        ) from exc
