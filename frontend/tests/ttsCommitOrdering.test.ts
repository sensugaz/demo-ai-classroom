import assert from "node:assert/strict";
import test from "node:test";

import { readyTtsCommitNos } from "../lib/ttsCommitOrdering.ts";

test("does not discard an ACK while its TTS audio is still pending", () => {
  const acknowledged = new Set([1]);
  const noAudio = new Set<number>();

  assert.deepEqual(
    readyTtsCommitNos({
      acknowledgedCommitNos: acknowledged,
      audioCommitNos: new Set(),
      noAudioCommitNos: noAudio,
      smallestPendingCommitNo: Number.POSITIVE_INFINITY,
    }),
    [],
  );

  assert.deepEqual(
    readyTtsCommitNos({
      acknowledgedCommitNos: acknowledged,
      audioCommitNos: new Set([1]),
      noAudioCommitNos: noAudio,
      smallestPendingCommitNo: Number.POSITIVE_INFINITY,
    }),
    [1],
  );
});

test("lets a failed or duplicate TTS outcome unblock later audio", () => {
  assert.deepEqual(
    readyTtsCommitNos({
      acknowledgedCommitNos: new Set([1, 2]),
      audioCommitNos: new Set([2]),
      noAudioCommitNos: new Set([1]),
      smallestPendingCommitNo: Number.POSITIVE_INFINITY,
    }),
    [1, 2],
  );
});

test("treats a rejected translation as terminal no-audio", () => {
  assert.deepEqual(
    readyTtsCommitNos({
      acknowledgedCommitNos: new Set([3]),
      audioCommitNos: new Set(),
      noAudioCommitNos: new Set([3]),
      smallestPendingCommitNo: Number.POSITIVE_INFINITY,
    }),
    [3],
  );
});

test("does not play a later clip while an earlier ACK still waits for audio", () => {
  assert.deepEqual(
    readyTtsCommitNos({
      acknowledgedCommitNos: new Set([1, 2]),
      audioCommitNos: new Set([2]),
      noAudioCommitNos: new Set(),
      smallestPendingCommitNo: Number.POSITIVE_INFINITY,
    }),
    [],
  );
});
