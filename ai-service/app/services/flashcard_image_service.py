"""Generate and cache child-friendly flashcard images."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import os
import re
from pathlib import Path

import httpx

from app.config import get_settings
from app.schemas.finalize_schema import Flashcard, Vocabulary

logger = logging.getLogger(__name__)

STYLE_VERSION = "kindergarten-v1"
REQUEST_TIMEOUT_SECONDS = 75.0
_WORD_SAFE = re.compile(r"[^a-z0-9]+")


class FlashcardImageService:
    """Best-effort image generator with a disk cache."""

    async def attach_images(
        self,
        session_id: str,
        flashcards: list[Flashcard],
        vocabularies: list[Vocabulary],
    ) -> list[Flashcard]:
        settings = get_settings()
        api_key = settings.OPENAI_API_KEY
        max_images = max(0, settings.FLASHCARD_IMAGE_MAX_PER_SESSION)
        if not flashcards:
            return flashcards

        vocab_by_word = {
            v.word.strip().lower(): v
            for v in vocabularies
            if v.word.strip()
        }
        candidates: list[Flashcard] = []
        for card in flashcards:
            if card.type == "vocabulary" and (card.word or card.front):
                candidates.append(card)
            else:
                card.imageUrl = ""
                card.imageStatus = "skipped"

        if not candidates:
            return flashcards
        if max_images == 0:
            for card in candidates:
                card.imageUrl = ""
                card.imageStatus = "skipped"
            return flashcards

        selected = candidates[:max_images]
        for card in candidates[max_images:]:
            card.imageUrl = ""
            card.imageStatus = "skipped"

        image_dir = Path(settings.FLASHCARD_IMAGE_DIR)
        image_dir.mkdir(parents=True, exist_ok=True)

        async def ensure_image(card: Flashcard) -> None:
            vocab = vocab_by_word.get((card.word or card.front).strip().lower())
            filename = self._filename(card, vocab, settings.FLASHCARD_IMAGE_MODEL)
            path = image_dir / filename
            card.imageUrl = self._public_url(session_id, filename)
            card.imageStatus = "pending"
            if path.exists():
                card.imageStatus = "ready"
                return
            if not api_key:
                card.imageUrl = ""
                card.imageStatus = "skipped"
                return

            try:
                image_bytes = await self._generate_image(card, vocab, api_key)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "flashcard image skipped session=%s word=%s error=%s",
                    session_id,
                    card.word or card.front,
                    exc,
                )
                card.imageUrl = ""
                card.imageStatus = "failed"
                return

            await asyncio.to_thread(path.write_bytes, image_bytes)
            card.imageStatus = "ready"
            logger.info(
                "flashcard image cached session=%s word=%s file=%s",
                session_id,
                card.word or card.front,
                filename,
            )

        await asyncio.gather(*(ensure_image(card) for card in selected))

        return flashcards

    async def _generate_image(
        self,
        card: Flashcard,
        vocab: Vocabulary | None,
        api_key: str,
    ) -> bytes:
        settings = get_settings()
        body = {
            "model": settings.FLASHCARD_IMAGE_MODEL,
            "prompt": self._prompt(card, vocab),
            "size": settings.FLASHCARD_IMAGE_SIZE,
            "quality": settings.FLASHCARD_IMAGE_QUALITY,
            "output_format": settings.FLASHCARD_IMAGE_OUTPUT_FORMAT,
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        url = settings.FLASHCARD_IMAGE_BASE_URL.rstrip("/") + "/images/generations"

        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(url, headers=headers, json=body)
        if response.status_code >= 400:
            raise RuntimeError(
                f"image API returned {response.status_code}: {response.text[:300]}"
            )

        payload = response.json()
        data = payload.get("data") or []
        if not data or not isinstance(data[0], dict):
            raise RuntimeError("image API returned no image data")

        image_b64 = data[0].get("b64_json")
        if not image_b64:
            raise RuntimeError("image API response missing b64_json")
        return base64.b64decode(image_b64)

    def _prompt(self, card: Flashcard, vocab: Vocabulary | None) -> str:
        word = (card.word or card.front).strip()
        meaning_en = (vocab.meaningEn if vocab else "").strip()
        meaning_th = (vocab.meaningTh if vocab else card.hintTh).strip()
        return (
            "Create one kindergarten flashcard image for children aged 3-6.\n"
            f"Word/concept: {word}\n"
            f"English meaning: {meaning_en or card.back}\n"
            f"Thai hint: {meaning_th}\n"
            "Style: warm children's book illustration, simple rounded shapes, "
            "soft cheerful colors, friendly and safe for kindergarten, clear "
            "single subject, no scary details.\n"
            "Composition: centered object or scene, large subject, uncluttered "
            "light background, easy to understand at small size.\n"
            "Constraints: no text, no letters, no watermark, no logo, no brand, "
            "no photorealistic people, no clutter."
        )

    def _filename(
        self,
        card: Flashcard,
        vocab: Vocabulary | None,
        model: str,
    ) -> str:
        word = (card.word or card.front or "card").strip().lower()
        meaning = ""
        if vocab is not None:
            meaning = f"{vocab.meaningEn}|{vocab.meaningTh}"
        key = "|".join([STYLE_VERSION, model, word, meaning])
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
        safe_word = _WORD_SAFE.sub("-", word).strip("-")[:36] or "card"
        ext = get_settings().FLASHCARD_IMAGE_OUTPUT_FORMAT.lower()
        if ext == "jpeg":
            ext = "jpg"
        return f"{safe_word}-{digest}.{ext}"

    def _public_url(self, session_id: str, filename: str) -> str:
        safe_session = session_id.strip()
        safe_file = os.path.basename(filename)
        return f"/api/classroom-sessions/{safe_session}/flashcard-images/{safe_file}"


def get_flashcard_image_service() -> FlashcardImageService:
    """Provider for use by the finalize router."""

    return FlashcardImageService()
