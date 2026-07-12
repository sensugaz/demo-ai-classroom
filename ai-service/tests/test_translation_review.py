from __future__ import annotations

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from app.schemas.translation_review_schema import TranslationReviewRequest
from app.schemas.translation_review_schema import TranslationReviewResponse
from app.routers.translation_review import router
from app.services.translation_review_service import (
    RESPONSES_URL,
    TRANSLATION_REVIEW_MODEL,
    TranslationReviewConfigurationError,
    TranslationReviewError,
    TranslationReviewService,
    get_translation_review_service,
)


def completed_response(translated_text: object) -> dict[str, object]:
    return {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": json.dumps({"translatedText": translated_text}),
                    }
                ],
            }
        ],
    }


class TranslationReviewServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_corrects_untrusted_candidate_using_source_and_context(self):
        captured: dict[str, object] = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["authorization"] = request.headers.get("Authorization")
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json=completed_response("Star gooseberry and tamarind."),
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        service = TranslationReviewService(client)
        request = TranslationReviewRequest(
            sessionId="classroom-1",
            sourceText="มะยม มะขาม",
            candidateTranslatedText='It is not "makha", "khai makham".',
            contextNote="บทเรียนเรื่องผลไม้",
        )

        with patch(
            "app.services.translation_review_service.get_settings",
            return_value=SimpleNamespace(OPENAI_API_KEY="server-only-key"),
        ):
            result = await service.review(request)

        body = captured["body"]
        assert isinstance(body, dict)
        self.assertEqual(RESPONSES_URL, captured["url"])
        self.assertEqual("Bearer server-only-key", captured["authorization"])
        self.assertEqual(TRANSLATION_REVIEW_MODEL, body["model"])
        self.assertEqual({"effort": "none"}, body["reasoning"])
        self.assertFalse(body["store"])
        self.assertNotIn("server-only-key", json.dumps(body))
        self.assertIn("มะยม มะขาม", str(body["input"]))
        self.assertIn("บทเรียนเรื่องผลไม้", str(body["input"]))
        self.assertEqual("corrected", result.status)
        self.assertEqual("Star gooseberry and tamarind.", result.translatedText)

    async def test_accepts_equivalent_candidate_without_marking_correction(self):
        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=completed_response("Hello!"))

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        service = TranslationReviewService(client)

        with patch(
            "app.services.translation_review_service.get_settings",
            return_value=SimpleNamespace(OPENAI_API_KEY="server-only-key"),
        ):
            result = await service.review(
                TranslationReviewRequest(
                    sessionId="classroom-1",
                    sourceText="สวัสดี",
                    candidateTranslatedText="Hello!",
                )
            )

        self.assertEqual("accepted", result.status)
        self.assertEqual("Hello!", result.translatedText)

    async def test_rejects_malformed_or_thai_canonical_output(self):
        responses = [
            {
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "not-json"}],
                    }
                ],
            },
            completed_response("มะขาม"),
        ]

        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=responses.pop(0))

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        service = TranslationReviewService(client)
        request = TranslationReviewRequest(
            sessionId="classroom-1",
            sourceText="มะขาม",
            candidateTranslatedText="tamarind",
        )

        with patch(
            "app.services.translation_review_service.get_settings",
            return_value=SimpleNamespace(OPENAI_API_KEY="server-only-key"),
        ):
            with self.assertRaises(TranslationReviewError):
                await service.review(request)
            with self.assertRaises(TranslationReviewError):
                await service.review(request)

    async def test_rejects_non_string_canonical_output(self):
        responses = [None, 42, ["Hello"], {"value": "Hello"}]

        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=completed_response(responses.pop(0)))

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        service = TranslationReviewService(client)
        request = TranslationReviewRequest(
            sessionId="classroom-1",
            sourceText="สวัสดี",
            candidateTranslatedText="Hello",
        )

        with patch(
            "app.services.translation_review_service.get_settings",
            return_value=SimpleNamespace(OPENAI_API_KEY="server-only-key"),
        ):
            for _ in range(4):
                with self.assertRaises(TranslationReviewError):
                    await service.review(request)

    async def test_provider_failure_is_generic_and_fail_closed(self):
        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="sensitive upstream details")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        service = TranslationReviewService(client)

        with patch(
            "app.services.translation_review_service.get_settings",
            return_value=SimpleNamespace(OPENAI_API_KEY="server-only-key"),
        ):
            with self.assertRaises(TranslationReviewError) as raised:
                await service.review(
                    TranslationReviewRequest(
                        sessionId="classroom-1",
                        sourceText="สวัสดี",
                        candidateTranslatedText="Hello",
                    )
                )

        self.assertNotIn("sensitive upstream details", str(raised.exception))
        self.assertNotIn("server-only-key", str(raised.exception))

    async def test_missing_openai_key_fails_before_network(self):
        called = False

        async def handler(_: httpx.Request) -> httpx.Response:
            nonlocal called
            called = True
            return httpx.Response(200, json=completed_response("Hello"))

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        service = TranslationReviewService(client)

        with patch(
            "app.services.translation_review_service.get_settings",
            return_value=SimpleNamespace(OPENAI_API_KEY=""),
        ):
            with self.assertRaises(TranslationReviewConfigurationError):
                await service.review(
                    TranslationReviewRequest(
                        sessionId="classroom-1",
                        sourceText="สวัสดี",
                        candidateTranslatedText="Hello",
                    )
                )

        self.assertFalse(called)


class TranslationReviewRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_route_returns_canonical_contract(self):
        class StubService:
            async def review(
                self, request: TranslationReviewRequest
            ) -> TranslationReviewResponse:
                self.request = request
                return TranslationReviewResponse(
                    status="corrected",
                    translatedText="Star gooseberry and tamarind.",
                )

        service = StubService()
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_translation_review_service] = lambda: service
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(client.aclose)

        response = await client.post(
            "/ai/realtime-translation/review",
            json={
                "sessionId": "classroom-1",
                "sourceText": "มะยม มะขาม",
                "candidateTranslatedText": "makha",
                "contextNote": "บทเรียนเรื่องผลไม้",
            },
        )

        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "status": "corrected",
                "translatedText": "Star gooseberry and tamarind.",
            },
            response.json(),
        )
        self.assertEqual("มะยม มะขาม", service.request.sourceText)

    async def test_route_hides_provider_failure(self):
        class FailingService:
            async def review(
                self, _: TranslationReviewRequest
            ) -> TranslationReviewResponse:
                raise TranslationReviewError("sensitive provider failure")

        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_translation_review_service] = FailingService
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(client.aclose)

        response = await client.post(
            "/ai/realtime-translation/review",
            json={
                "sessionId": "classroom-1",
                "sourceText": "สวัสดี",
                "candidateTranslatedText": "Hello",
            },
        )

        self.assertEqual(502, response.status_code)
        self.assertEqual(
            {"detail": "translation could not be verified"}, response.json()
        )
        self.assertNotIn("sensitive provider failure", response.text)


if __name__ == "__main__":
    unittest.main()
