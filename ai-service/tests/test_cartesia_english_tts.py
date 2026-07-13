from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.schemas.tts_schema import TtsRequest
from app.services.cartesia_english_tts_service import (
    CartesiaEnglishTtsService,
    SPEECH_PLAYBACK_RATES,
)


class CartesiaEnglishTtsServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_maps_speech_speed_to_client_playback_without_generation_config(self):
        settings = SimpleNamespace(
            CARTESIA_API_KEY="cartesia-key",
            CARTESIA_MODEL="sonic-3.5",
            CARTESIA_TTS_LANGUAGE="en",
            CARTESIA_VOICE_ID="fallback-voice",
            CARTESIA_VOICE_CHILD_GIRL_ID="girl-voice",
            CARTESIA_VOICE_CHILD_BOY_ID="boy-voice",
            CARTESIA_VOICE_ADULT_WOMAN_ID="woman-voice",
            CARTESIA_VOICE_ADULT_MAN_ID="man-voice",
        )

        for speech_speed, expected_rate in {
            "slow": 0.78,
            "medium": 0.86,
            "fast": 1.0,
        }.items():
            with self.subTest(speech_speed=speech_speed):
                client = SimpleNamespace(
                    post=AsyncMock(
                        return_value=SimpleNamespace(
                            status_code=200,
                            content=b"mp3-audio",
                            text="",
                        )
                    )
                )
                with (
                    patch(
                        "app.services.cartesia_english_tts_service.get_settings",
                        return_value=settings,
                    ),
                    patch(
                        "app.services.cartesia_english_tts_service.get_cartesia_client",
                        return_value=client,
                    ),
                ):
                    result = await CartesiaEnglishTtsService().synthesize(
                        TtsRequest(
                            sessionId="classroom-1",
                            text="Hello children",
                            voiceProfile="child_girl",
                            speechSpeed=speech_speed,
                        )
                    )

                request_body = client.post.await_args.kwargs["json"]
                self.assertNotIn("generation_config", request_body)
                self.assertEqual("sonic-3.5", request_body["model_id"])
                self.assertEqual("girl-voice", request_body["voice"]["id"])
                self.assertEqual(expected_rate, result.playbackRate)
                self.assertEqual(speech_speed, result.speechSpeed)

    def test_uses_exact_playback_rate_mapping(self):
        self.assertEqual(
            {"slow": 0.78, "medium": 0.86, "fast": 1.0},
            SPEECH_PLAYBACK_RATES,
        )


if __name__ == "__main__":
    unittest.main()
