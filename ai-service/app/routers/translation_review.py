"""Internal endpoint for canonical classroom translation review."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.schemas.translation_review_schema import (
    TranslationReviewRequest,
    TranslationReviewResponse,
)
from app.services.translation_review_service import (
    TranslationReviewConfigurationError,
    TranslationReviewError,
    TranslationReviewService,
    get_translation_review_service,
)

router = APIRouter(prefix="/ai/realtime-translation", tags=["realtime-translation"])


@router.post("/review", response_model=TranslationReviewResponse)
async def review_translation(
    request: TranslationReviewRequest,
    service: TranslationReviewService = Depends(get_translation_review_service),
) -> TranslationReviewResponse:
    """Return canonical English or fail closed without exposing provider details."""

    try:
        return await service.review(request)
    except TranslationReviewConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="translation review is unavailable",
        ) from exc
    except TranslationReviewError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="translation could not be verified",
        ) from exc
