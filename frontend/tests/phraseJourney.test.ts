import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceAudioLifecycle,
  createPhraseJourneyState,
  phraseJourneyReducer,
  selectPhraseJourney,
} from "../lib/phraseJourney.ts";
import type {
  AudioLifecycleState,
  AudioPlayerLifecycleEvent,
  PhraseJourneyState,
} from "../lib/phraseJourney.ts";

function queue(
  state: PhraseJourneyState,
  commitId: string,
  commitNo: number,
): PhraseJourneyState {
  return phraseJourneyReducer(state, { type: "queue", commitId, commitNo });
}

function audio(
  state: PhraseJourneyState,
  event: AudioPlayerLifecycleEvent,
): PhraseJourneyState {
  return phraseJourneyReducer(state, { type: "audio", event });
}

test("accepts skipped and repeated stages while ignoring per-commit regressions", () => {
  let state = queue(createPhraseJourneyState(), "commit-1", 1);

  state = phraseJourneyReducer(state, {
    type: "progress",
    payload: {
      sessionId: "session-1",
      commitId: "commit-1",
      commitNo: 1,
      stage: "persisting",
    },
  });
  assert.equal(state.commits["commit-1"]?.stage, "persisting");

  const repeated = phraseJourneyReducer(state, {
    type: "progress",
    payload: {
      sessionId: "session-1",
      commitId: "commit-1",
      commitNo: 1,
      stage: "persisting",
    },
  });
  assert.equal(repeated, state);

  const regressed = phraseJourneyReducer(state, {
    type: "progress",
    payload: {
      sessionId: "session-1",
      commitId: "commit-1",
      commitNo: 1,
      stage: "reviewing",
    },
  });
  assert.equal(regressed, state);

  state = phraseJourneyReducer(state, {
    type: "progress",
    payload: {
      sessionId: "session-1",
      commitId: "commit-1",
      commitNo: 1,
      stage: "synthesizing",
    },
  });
  assert.equal(state.commits["commit-1"]?.stage, "synthesizing");
});

test("ignores stale progress and shows the oldest unresolved commit", () => {
  let state = queue(createPhraseJourneyState(), "commit-2", 2);
  state = queue(state, "commit-1", 1);
  state = phraseJourneyReducer(state, {
    type: "progress",
    payload: {
      sessionId: "session-1",
      commitId: "commit-2",
      commitNo: 2,
      stage: "synthesizing",
    },
  });

  const unknown = phraseJourneyReducer(state, {
    type: "progress",
    payload: {
      sessionId: "session-1",
      commitId: "missing",
      commitNo: 3,
      stage: "reviewing",
    },
  });
  assert.equal(unknown, state);

  const mismatched = phraseJourneyReducer(state, {
    type: "progress",
    payload: {
      sessionId: "session-1",
      commitId: "commit-1",
      commitNo: 99,
      stage: "synthesizing",
    },
  });
  assert.equal(mismatched, state);
  assert.deepEqual(selectPhraseJourney(state, { finalizing: false }), {
    status: "queued",
    step: 1,
    commitNo: 1,
    isFailure: false,
  });

  state = audio(state, {
    phase: "playing",
    playbackId: "play-2",
    commitId: "commit-2",
    commitNo: 2,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "playing");
  assert.equal(selectPhraseJourney(state, { finalizing: false }).commitNo, 2);
});

test("terminal outcomes clean up commits and absorb late events", () => {
  let state = queue(createPhraseJourneyState(), "commit-1", 1);
  state = phraseJourneyReducer(state, {
    type: "rejected",
    commitId: "commit-1",
    commitNo: 1,
  });

  assert.equal(state.commits["commit-1"], undefined);
  assert.deepEqual(state.terminalCommits["commit-1"], {
    commitNo: 1,
    replayable: false,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "review-rejection");

  const lateProgress = phraseJourneyReducer(state, {
    type: "progress",
    payload: {
      sessionId: "session-1",
      commitId: "commit-1",
      commitNo: 1,
      stage: "synthesizing",
    },
  });
  assert.equal(lateProgress, state);
  assert.equal(queue(state, "commit-1", 1), state);

  state = queue(state, "commit-2", 2);
  assert.equal(state.notice, null);
  state = audio(state, {
    phase: "queued",
    playbackId: "play-2",
    commitId: "commit-2",
    commitNo: 2,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "audio-ready");
  state = audio(state, {
    phase: "ended",
    playbackId: "play-2",
    commitId: "commit-2",
    commitNo: 2,
  });
  assert.equal(state.commits["commit-2"], undefined);
  assert.deepEqual(state.terminalCommits["commit-2"], {
    commitNo: 2,
    replayable: true,
  });
});

test("audio arrival is ready, and only a playing event reports playing", () => {
  let state = queue(createPhraseJourneyState(), "commit-1", 1);
  state = audio(state, {
    phase: "queued",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "audio-ready");

  state = audio(state, {
    phase: "ready",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "audio-ready");

  state = audio(state, {
    phase: "blocked",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "blocked");

  state = audio(state, {
    phase: "playing",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "playing");
});

test("reports queued audio held by mute and terminal playback failure", () => {
  let state = queue(createPhraseJourneyState(), "commit-1", 1);
  state = audio(state, {
    phase: "muted-queued",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "muted");

  state = audio(state, {
    phase: "queued",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "audio-ready");

  state = audio(state, {
    phase: "playback-error",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(state.commits["commit-1"], undefined);
  assert.deepEqual(state.terminalCommits["commit-1"], {
    commitNo: 1,
    replayable: true,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "playback-error");
});

test("TTS failure is terminal and late synthesis progress stays ignored", () => {
  let state = queue(createPhraseJourneyState(), "commit-1", 1);
  state = phraseJourneyReducer(state, {
    type: "tts-failed",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "tts-failure");

  const stale = phraseJourneyReducer(state, {
    type: "progress",
    payload: {
      sessionId: "session-1",
      commitId: "commit-1",
      commitNo: 1,
      stage: "synthesizing",
    },
  });
  assert.equal(stale, state);
});

test("a fatal commit error terminates the journey with a save failure", () => {
  let state = queue(createPhraseJourneyState(), "commit-1", 1);
  state = phraseJourneyReducer(state, {
    type: "commit-failed",
    commitId: "commit-1",
    commitNo: 1,
  });

  assert.equal(state.commits["commit-1"], undefined);
  assert.equal(
    selectPhraseJourney(state, { finalizing: false }).status,
    "commit-failure",
  );
});

test("shows listening and finalizing while no committed phrase is active", () => {
  const state = createPhraseJourneyState();

  assert.equal(
    selectPhraseJourney(state, { finalizing: false, listening: true }).status,
    "listening",
  );
  assert.equal(
    selectPhraseJourney(state, { finalizing: true, listening: false }).status,
    "finalizing",
  );
});

test("a duplicate acknowledgement stays active until its audio ends", () => {
  let state = queue(createPhraseJourneyState(), "commit-1", 1);
  state = phraseJourneyReducer(state, {
    type: "progress",
    payload: {
      sessionId: "session-1",
      commitId: "commit-1",
      commitNo: 1,
      stage: "synthesizing",
    },
  });
  state = phraseJourneyReducer(state, {
    type: "committed",
    commitId: "commit-1",
    commitNo: 1,
    duplicate: true,
  });

  assert.equal(
    selectPhraseJourney(state, { finalizing: false }).status,
    "synthesizing",
  );

  state = audio(state, {
    phase: "queued",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(
    selectPhraseJourney(state, { finalizing: false }).status,
    "audio-ready",
  );

  state = audio(state, {
    phase: "ended",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "ready");
});

test("ignores stale playback events while allowing a new replay attempt", () => {
  let state = queue(createPhraseJourneyState(), "commit-1", 1);
  state = audio(state, {
    phase: "playing",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  state = audio(state, {
    phase: "ended",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });

  const stale = audio(state, {
    phase: "playing",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(stale, state);

  const unknown = audio(state, {
    phase: "playing",
    playbackId: "unknown-playback",
    commitId: "unknown-commit",
    commitNo: 99,
  });
  assert.equal(unknown, state);

  state = audio(state, {
    phase: "queued",
    playbackId: "play-2",
    commitId: "commit-1",
    commitNo: 1,
  });
  state = audio(state, {
    phase: "playing",
    playbackId: "play-2",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(selectPhraseJourney(state, { finalizing: false }).status, "playing");
});

test("audio lifecycle ignores regressions for an active or terminal attempt", () => {
  const idle: AudioLifecycleState = {
    phase: "idle",
    playbackId: null,
    commitId: null,
    commitNo: null,
  };
  const queued = advanceAudioLifecycle(idle, {
    phase: "queued",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  const ready = advanceAudioLifecycle(queued, {
    phase: "ready",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(
    advanceAudioLifecycle(ready, {
      phase: "queued",
      playbackId: "play-1",
      commitId: "commit-1",
      commitNo: 1,
    }),
    ready,
  );

  const playing = advanceAudioLifecycle(ready, {
    phase: "playing",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(
    advanceAudioLifecycle(playing, {
      phase: "queued",
      playbackId: "play-2",
      commitId: "commit-2",
      commitNo: 2,
    }),
    playing,
  );

  const ended = advanceAudioLifecycle(playing, {
    phase: "ended",
    playbackId: "play-1",
    commitId: "commit-1",
    commitNo: 1,
  });
  assert.equal(
    advanceAudioLifecycle(ended, {
      phase: "ready",
      playbackId: "play-1",
      commitId: "commit-1",
      commitNo: 1,
    }),
    ended,
  );
  assert.equal(advanceAudioLifecycle(ended, { phase: "idle" }).phase, "idle");
});
