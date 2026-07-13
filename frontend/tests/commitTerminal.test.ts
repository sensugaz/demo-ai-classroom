import assert from "node:assert/strict";
import test from "node:test";

import { settleCommitWithoutAudio } from "../lib/commitTerminal.ts";
import type { TranslationCommitPayload, TtsAudioPayload } from "../lib/types.ts";

function pendingCommit(commitId: string, commitNo: number): TranslationCommitPayload {
  return {
    sessionId: "session-1",
    translationSessionId: "translation-session-1",
    commitId,
    commitNo,
    commitKind: "debounced",
    sourceText: "สวัสดี",
    translatedText: "Hello",
    sourceElapsedMs: 100,
    targetElapsedMs: 120,
    voiceProfile: "child_girl",
    speechSpeed: "slow",
  };
}

test("a correlated fatal error settles pending state and unblocks audio ordering", () => {
  const commit = pendingCommit("commit-1", 1);
  const pendingCommits = new Map([[commit.commitId, commit]]);
  const sentCommitIds = new Set([commit.commitId]);
  const acknowledgedCommitNos = new Set<number>();
  const noAudioCommitNos = new Set<number>();
  const ttsByCommitNo = new Map<number, TtsAudioPayload>();

  assert.equal(
    settleCommitWithoutAudio(
      {
        pendingCommits,
        sentCommitIds,
        acknowledgedCommitNos,
        noAudioCommitNos,
        ttsByCommitNo,
      },
      commit,
    ),
    true,
  );
  assert.equal(pendingCommits.size, 0);
  assert.equal(sentCommitIds.size, 0);
  assert.deepEqual([...acknowledgedCommitNos], [1]);
  assert.deepEqual([...noAudioCommitNos], [1]);
});

test("a mismatched terminal error cannot settle another pending commit", () => {
  const commit = pendingCommit("commit-1", 1);
  const pendingCommits = new Map([[commit.commitId, commit]]);
  const collections = {
    pendingCommits,
    sentCommitIds: new Set([commit.commitId]),
    acknowledgedCommitNos: new Set<number>(),
    noAudioCommitNos: new Set<number>(),
    ttsByCommitNo: new Map<number, TtsAudioPayload>(),
  };

  assert.equal(
    settleCommitWithoutAudio(collections, {
      commitId: commit.commitId,
      commitNo: 2,
    }),
    false,
  );
  assert.equal(pendingCommits.size, 1);
  assert.equal(collections.sentCommitIds.has(commit.commitId), true);
});
