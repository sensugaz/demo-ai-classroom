import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceTranslationReviewOutcome,
  isCanonicalTranslationCommittedPayload,
  isExpectedPendingCommit,
  upsertCanonicalTranslation,
} from "../lib/canonicalTranslation.ts";
import type { TranslationCommittedPayload } from "../lib/types.ts";

function committed(
  overrides: Partial<TranslationCommittedPayload> = {},
): TranslationCommittedPayload {
  return {
    sessionId: "session-1",
    commitId: "translation-session:1",
    commitNo: 1,
    commitKind: "debounced",
    sequenceNo: 1,
    duplicate: false,
    sourceText: "มะยม มะขาม",
    translatedText: "Star gooseberry and tamarind.",
    reviewStatus: "corrected",
    ...overrides,
  };
}

test("publishes only the backend canonical translation", () => {
  const lines = upsertCanonicalTranslation([], committed());

  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line);
  assert.equal(line.translatedText, "Star gooseberry and tamarind.");
  assert.equal(line.sourceText, "มะยม มะขาม");
  assert.equal(line.isFinal, true);
});

test("duplicate acknowledgement replaces by commit id without adding a line", () => {
  const first = upsertCanonicalTranslation([], committed());
  const duplicate = upsertCanonicalTranslation(
    first,
    committed({ duplicate: true, translatedText: "Canonical retry." }),
  );

  assert.equal(duplicate.length, 1);
  const line = duplicate[0];
  assert.ok(line);
  assert.equal(line.translatedText, "Canonical retry.");
});

test("canonical lines remain ordered by backend sequence", () => {
  const second = committed({
    commitId: "translation-session:2",
    commitNo: 2,
    sequenceNo: 2,
    sourceText: "สอง",
    translatedText: "Two",
  });
  const lines = upsertCanonicalTranslation(
    upsertCanonicalTranslation([], second),
    committed(),
  );

  assert.deepEqual(
    lines.map((line) => line.sequenceNo),
    [1, 2],
  );
});

test("rejects unreviewed or incomplete runtime acknowledgements", () => {
  assert.equal(isCanonicalTranslationCommittedPayload(null), false);
  assert.equal(isCanonicalTranslationCommittedPayload({}), false);
  assert.equal(
    isCanonicalTranslationCommittedPayload(
      committed({ reviewStatus: "pending" as "accepted" }),
    ),
    false,
  );
  assert.equal(
    isCanonicalTranslationCommittedPayload(
      committed({ translatedText: "   " }),
    ),
    false,
  );
  assert.equal(
    isCanonicalTranslationCommittedPayload(committed({ sequenceNo: 0 })),
    false,
  );
});

test("an older success cannot erase a newer rejection", () => {
  const rejected = advanceTranslationReviewOutcome(
    { commitNo: 0, status: "accepted" },
    2,
    "rejected",
  );
  const delayedSuccess = advanceTranslationReviewOutcome(
    rejected,
    1,
    "accepted",
  );

  assert.deepEqual(delayedSuccess, { commitNo: 2, status: "rejected" });
});

test("a same or newer reviewed phrase clears a rejection", () => {
  const rejected = { commitNo: 2, status: "rejected" } as const;

  assert.deepEqual(
    advanceTranslationReviewOutcome(rejected, 2, "accepted"),
    { commitNo: 2, status: "accepted" },
  );
  assert.deepEqual(
    advanceTranslationReviewOutcome(rejected, 3, "pending"),
    { commitNo: 3, status: "pending" },
  );
});

test("post-reset frames are ignored when their commit is no longer pending", () => {
  const pending = new Map([
    [
      "translation-session:2",
      {
        sessionId: "session-1",
        translationSessionId: "translation-session",
        commitId: "translation-session:2",
        commitNo: 2,
        commitKind: "debounced" as const,
        sourceText: "สวัสดี",
        translatedText: "Hello",
        sourceElapsedMs: 100,
        targetElapsedMs: 120,
        voiceProfile: "child_girl" as const,
        speechSpeed: "slow" as const,
      },
    ],
  ]);

  assert.equal(
    isExpectedPendingCommit(pending, {
      commitId: "translation-session:2",
      commitNo: 2,
    }),
    true,
  );
  pending.clear();
  assert.equal(
    isExpectedPendingCommit(pending, {
      commitId: "translation-session:2",
      commitNo: 2,
    }),
    false,
  );
  assert.equal(
    isExpectedPendingCommit(
      new Map(),
      { commitId: "old-translation-session:2", commitNo: 2 },
    ),
    false,
  );
});
