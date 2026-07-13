import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeRealtimeCommit,
  createRealtimeCommitState,
  isCommitDrainComplete,
  isSaveDrainComplete,
  queueRealtimeCommit,
  settleRealtimeTts,
  unresolvedCommitLocation,
  unresolvedCommitsForResend,
} from "../lib/realtimeCommitState.ts";
import type { TranslationCommitPayload } from "../lib/types.ts";

function commit(commitNo: number): TranslationCommitPayload {
  return {
    sessionId: "session-1",
    translationSessionId: "translation-session-1",
    commitId: `commit-${commitNo}`,
    commitNo,
    commitKind: "debounced",
    sourceText: `source ${commitNo}`,
    translatedText: `translation ${commitNo}`,
    sourceElapsedMs: commitNo * 100,
    targetElapsedMs: commitNo * 120,
    voiceProfile: "child_girl",
    speechSpeed: "slow",
  };
}

test("ACK before audio moves the original payload and completes only the save drain", () => {
  const original = commit(1);
  let state = queueRealtimeCommit(createRealtimeCommitState(), original);
  const acknowledged = acknowledgeRealtimeCommit(state, original);
  state = acknowledged.state;

  assert.equal(acknowledged.location, "pending-save");
  assert.equal(state.pendingSave.size, 0);
  assert.deepEqual(state.acknowledgedAwaitingAudio.get(original.commitId), original);
  assert.equal(isSaveDrainComplete(state), true);
  assert.equal(isCommitDrainComplete(state), false);

  state = settleRealtimeTts(state, original).state;
  assert.equal(isCommitDrainComplete(state), true);
});

test("a duplicate ACK remains awaiting audio and is not a no-audio outcome", () => {
  const original = commit(1);
  let state = queueRealtimeCommit(createRealtimeCommitState(), original);
  state = acknowledgeRealtimeCommit(state, original).state;
  const duplicate = acknowledgeRealtimeCommit(state, original);

  assert.equal(duplicate.location, "awaiting-audio");
  assert.equal(duplicate.state, state);
  assert.equal(duplicate.state.acknowledgedAwaitingAudio.size, 1);
  assert.equal(isCommitDrainComplete(duplicate.state), false);
});

test("out-of-order audio keeps the earlier commit unresolved", () => {
  const first = commit(1);
  const second = commit(2);
  let state = queueRealtimeCommit(createRealtimeCommitState(), first);
  state = queueRealtimeCommit(state, second);
  state = acknowledgeRealtimeCommit(state, first).state;
  state = acknowledgeRealtimeCommit(state, second).state;

  state = settleRealtimeTts(state, second).state;
  assert.equal(unresolvedCommitLocation(state, first), "awaiting-audio");
  assert.equal(unresolvedCommitLocation(state, second), null);
  assert.equal(isCommitDrainComplete(state), false);

  state = settleRealtimeTts(state, first).state;
  assert.equal(isCommitDrainComplete(state), true);
});

test("reconnect resends pending and awaiting commits in commit order with original payloads", () => {
  const first = commit(1);
  const second = commit(2);
  let state = queueRealtimeCommit(createRealtimeCommitState(), second);
  state = queueRealtimeCommit(state, first);
  state = acknowledgeRealtimeCommit(state, first).state;

  assert.deepEqual(unresolvedCommitsForResend(state), [first, second]);
});

test("save and full drains have distinct completion conditions", () => {
  const original = commit(1);
  let state = queueRealtimeCommit(createRealtimeCommitState(), original);
  assert.equal(isSaveDrainComplete(state), false);
  assert.equal(isCommitDrainComplete(state), false);

  state = acknowledgeRealtimeCommit(state, original).state;
  assert.equal(isSaveDrainComplete(state), true);
  assert.equal(isCommitDrainComplete(state), false);

  state = settleRealtimeTts(state, original).state;
  assert.equal(isCommitDrainComplete(state), true);
});

test("reset state rejects stale ACK and TTS identities", () => {
  const stale = commit(1);
  let state = queueRealtimeCommit(createRealtimeCommitState(), stale);
  state = acknowledgeRealtimeCommit(state, stale).state;
  state = createRealtimeCommitState();

  assert.equal(unresolvedCommitLocation(state, stale), null);
  assert.equal(acknowledgeRealtimeCommit(state, stale).state, state);
  assert.equal(settleRealtimeTts(state, stale).state, state);
});
