import assert from "node:assert/strict";
import test from "node:test";

import {
  abortRealtimePhraseCall,
  beginRealtimePhraseClose,
  consumeClosedPhraseCommit,
  createRealtimePhraseLifecycle,
  markRealtimePhraseCommitAcknowledged,
  markRealtimePhraseClosed,
  shouldSchedulePhraseTimer,
  startRealtimePhraseCall,
} from "../lib/realtimePhraseLifecycle.ts";

test("suppresses timers while closing and consumes one commit after session.closed", () => {
  let lifecycle = startRealtimePhraseCall(createRealtimePhraseLifecycle());
  assert.equal(shouldSchedulePhraseTimer(lifecycle), true);

  lifecycle = beginRealtimePhraseClose(lifecycle);
  assert.equal(shouldSchedulePhraseTimer(lifecycle), false);

  // Trailing transcript deltas are buffered during this phase, but cannot re-arm timers.
  lifecycle = markRealtimePhraseClosed(lifecycle);
  const firstCommit = consumeClosedPhraseCommit(lifecycle);
  assert.equal(firstCommit.shouldCommit, true);
  assert.equal(firstCommit.lifecycle.phase, "committing");

  const duplicateCommit = consumeClosedPhraseCommit(firstCommit.lifecycle);
  assert.equal(duplicateCommit.shouldCommit, false);
});

test("does not start the next call before the previous commit is acknowledged", () => {
  let lifecycle = startRealtimePhraseCall(createRealtimePhraseLifecycle());
  lifecycle = beginRealtimePhraseClose(lifecycle);
  lifecycle = markRealtimePhraseClosed(lifecycle);
  lifecycle = consumeClosedPhraseCommit(lifecycle).lifecycle;

  const blockedStart = startRealtimePhraseCall(lifecycle);
  assert.equal(blockedStart.generation, lifecycle.generation);
  assert.equal(blockedStart.phase, "committing");

  lifecycle = markRealtimePhraseCommitAcknowledged(lifecycle);
  lifecycle = startRealtimePhraseCall(lifecycle);
  assert.equal(lifecycle.phase, "streaming");
  assert.equal(lifecycle.generation, blockedStart.generation + 1);
});

test("starts the next call in a fresh generation", () => {
  let lifecycle = startRealtimePhraseCall(createRealtimePhraseLifecycle());
  const firstGeneration = lifecycle.generation;
  lifecycle = abortRealtimePhraseCall(lifecycle);
  lifecycle = startRealtimePhraseCall(lifecycle);

  assert.equal(lifecycle.generation, firstGeneration + 1);
  assert.equal(lifecycle.phase, "streaming");
  assert.equal(lifecycle.commitConsumed, false);
  assert.equal(shouldSchedulePhraseTimer(lifecycle), true);
});
