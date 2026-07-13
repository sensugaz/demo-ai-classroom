import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticPhraseCommitEnabled,
  HOLD_RELEASE_HARD_CAP_MS,
  HOLD_RELEASE_QUIET_MS,
  holdQuiescenceSchedule,
  holdResumeDecision,
  planHoldRelease,
} from "../lib/holdReleasePolicy.ts";

test("HOLD releases by disabling the track and committing without closing", () => {
  assert.deepEqual(planHoldRelease("ptt", true), {
    action: "commit-now",
    disableTrack: true,
    closeSession: false,
    waitForSave: true,
    waitForQuiescence: true,
  });
});

test("release before capture becomes active is an idempotent no-op", () => {
  assert.deepEqual(planHoldRelease("ptt", false), {
    action: "noop",
    disableTrack: true,
    closeSession: false,
    waitForSave: false,
    waitForQuiescence: false,
  });
});

test("LIVE keeps the explicit close-based pause path", () => {
  assert.deepEqual(planHoldRelease("live", true), {
    action: "pause-session",
    disableTrack: true,
    closeSession: true,
    waitForSave: true,
    waitForQuiescence: false,
  });
});

test("only LIVE schedules silence and maximum-window commits", () => {
  assert.equal(automaticPhraseCommitEnabled("live"), true);
  assert.equal(automaticPhraseCommitEnabled("ptt"), false);
});

test("late HOLD deltas reset quiet time without extending the hard cap", () => {
  assert.deepEqual(
    holdQuiescenceSchedule({ releasedAt: 1_000, lastDeltaAt: 1_250, now: 1_300 }),
    {
      dirtyNow: false,
      hardDelayMs: HOLD_RELEASE_HARD_CAP_MS - 300,
      quietDelayMs: HOLD_RELEASE_QUIET_MS - 50,
    },
  );
});

test("the hard cap forces reconnect instead of reusing a noisy HOLD call", () => {
  assert.equal(
    holdQuiescenceSchedule({ releasedAt: 1_000, lastDeltaAt: 2_900, now: 3_000 })
      .dirtyNow,
    true,
  );
  assert.equal(
    holdResumeDecision({
      saveDrained: true,
      quiescenceSettled: true,
      connectionDirty: true,
    }),
    "reconnect",
  );
});

test("resume waits for both canonical save and the late-delta barrier", () => {
  assert.equal(
    holdResumeDecision({
      saveDrained: false,
      quiescenceSettled: true,
      connectionDirty: false,
    }),
    "wait",
  );
  assert.equal(
    holdResumeDecision({
      saveDrained: true,
      quiescenceSettled: false,
      connectionDirty: false,
    }),
    "wait",
  );
  assert.equal(
    holdResumeDecision({
      saveDrained: true,
      quiescenceSettled: true,
      connectionDirty: false,
    }),
    "reuse",
  );
});
