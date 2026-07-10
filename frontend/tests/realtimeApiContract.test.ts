import assert from "node:assert/strict";
import test from "node:test";

import { api } from "../lib/api.ts";

test("requests the backend Realtime Translation client-secret endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedMethod = "";

  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedMethod = init?.method ?? "GET";
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          clientSecret: "temporary-secret",
          expiresAt: 1_800_000_000,
          translationSessionId: "sess_translation",
          lastCommitNo: 4,
          model: "gpt-realtime-translate",
          targetLanguage: "en-US",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const result = await api.createRealtimeToken("classroom/one");
    assert.equal(
      requestedUrl,
      "http://localhost:3001/api/classroom-sessions/classroom%2Fone/realtime-translation/client-secret",
    );
    assert.equal(requestedMethod, "POST");
    assert.equal(result.clientSecret, "temporary-secret");
    assert.equal(result.translationSessionId, "sess_translation");
    assert.equal(result.lastCommitNo, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
