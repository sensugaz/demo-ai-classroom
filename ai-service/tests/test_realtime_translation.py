from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from app.schemas.realtime_translation_schema import (
    RealtimeTranslationClientSecretRequest,
)
from app.services.openai_realtime_translation_service import (
    CLIENT_SECRET_TTL_SECONDS,
    CLIENT_SECRET_URL,
    OpenAIRealtimeTranslationService,
    RealtimeTranslationConfigurationError,
    RealtimeTranslationError,
)


class RealtimeTranslationServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_mints_fixed_english_translation_secret(self):
        captured: dict[str, object] = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["authorization"] = request.headers.get("Authorization")
            captured["safety"] = request.headers.get("OpenAI-Safety-Identifier")
            captured["body"] = request.content.decode("utf-8")

            return httpx.Response(
                200,
                json={
                    "value": "ek_test",
                    "expires_at": 1_800_000_000,
                    "session": {"id": "sess_translation"},
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        service = OpenAIRealtimeTranslationService(client)

        with patch(
            "app.services.openai_realtime_translation_service.get_settings",
            return_value=SimpleNamespace(OPENAI_API_KEY="server-only-key"),
        ):
            result = await service.mint_client_secret(
                RealtimeTranslationClientSecretRequest(sessionId="classroom-1")
            )

        self.assertEqual(CLIENT_SECRET_URL, captured["url"])
        self.assertEqual("Bearer server-only-key", captured["authorization"])
        self.assertEqual(64, len(str(captured["safety"])))
        self.assertNotIn("server-only-key", str(captured["body"]))
        self.assertIn('"model":"gpt-realtime-translate"', captured["body"])
        self.assertIn('"model":"gpt-realtime-whisper"', captured["body"])
        self.assertIn('"language":"en"', captured["body"])
        self.assertIn(f'"seconds":{CLIENT_SECRET_TTL_SECONDS}', captured["body"])
        self.assertEqual("ek_test", result.clientSecret)
        self.assertEqual("sess_translation", result.translationSessionId)
        self.assertEqual("en-US", result.targetLanguage)

    async def test_missing_server_key_is_rejected_before_network(self):
        called = False

        async def handler(_: httpx.Request) -> httpx.Response:
            nonlocal called
            called = True

            return httpx.Response(200, json={})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        service = OpenAIRealtimeTranslationService(client)

        with patch(
            "app.services.openai_realtime_translation_service.get_settings",
            return_value=SimpleNamespace(OPENAI_API_KEY=""),
        ):
            with self.assertRaises(RealtimeTranslationConfigurationError):
                await service.mint_client_secret(
                    RealtimeTranslationClientSecretRequest(sessionId="classroom-1")
                )

        self.assertFalse(called)

    async def test_upstream_body_and_key_are_not_exposed(self):
        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(401, text="sensitive upstream body")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        service = OpenAIRealtimeTranslationService(client)

        with patch(
            "app.services.openai_realtime_translation_service.get_settings",
            return_value=SimpleNamespace(OPENAI_API_KEY="server-only-key"),
        ):
            with self.assertRaises(RealtimeTranslationError) as raised:
                await service.mint_client_secret(
                    RealtimeTranslationClientSecretRequest(sessionId="classroom-1")
                )

        message = str(raised.exception)
        self.assertNotIn("sensitive upstream body", message)
        self.assertNotIn("server-only-key", message)


if __name__ == "__main__":
    unittest.main()
