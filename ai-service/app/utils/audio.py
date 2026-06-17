"""Audio helpers: base64 decoding and optional temp-file persistence."""

from __future__ import annotations

import base64
import binascii
import os
import uuid


class AudioDecodeError(ValueError):
    """Raised when an audio base64 payload cannot be decoded."""


def decode_base64_audio(audio_base64: str) -> bytes:
    """Decode a base64-encoded audio payload into raw bytes.

    Tolerates an optional ``data:`` URI prefix (e.g.
    ``data:audio/webm;base64,....``) and missing padding.
    """

    if not audio_base64:
        raise AudioDecodeError("audioBase64 is empty")

    payload = audio_base64.strip()
    if payload.startswith("data:") and "," in payload:
        # Strip a data URI header if the client included one.
        payload = payload.split(",", 1)[1]

    # Restore any stripped padding so urlsafe/standard b64 both decode.
    missing_padding = len(payload) % 4
    if missing_padding:
        payload += "=" * (4 - missing_padding)

    try:
        return base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError) as exc:  # pragma: no cover - defensive
        raise AudioDecodeError(f"invalid base64 audio: {exc}") from exc


def write_temp_audio(audio_bytes: bytes, temp_dir: str, suffix: str = ".webm") -> str:
    """Persist raw audio bytes to a unique file under ``temp_dir``.

    Returns the absolute path. Useful for debugging or for codecs/tooling that
    require a file path. The STT path itself works directly on bytes, so this is
    optional and not on the hot path.
    """

    os.makedirs(temp_dir, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{suffix}"
    path = os.path.join(temp_dir, filename)
    with open(path, "wb") as fh:
        fh.write(audio_bytes)
    return path
