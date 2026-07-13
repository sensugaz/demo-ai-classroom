import type {
  TranslationProgressPayload,
  TranslationProgressStage,
} from "./types";

export type PhraseJourneyStage = "queued" | TranslationProgressStage;

export type AudioPlayerPhase =
  | "idle"
  | "queued"
  | "ready"
  | "playing"
  | "ended"
  | "blocked"
  | "muted-queued"
  | "playback-error";

export type CommitAudioPhase = Exclude<
  AudioPlayerPhase,
  "idle" | "ended" | "playback-error"
> | "none";

export interface CommitIdentity {
  commitId: string;
  commitNo: number;
}

export interface AudioClipIdentity extends CommitIdentity {
  playbackId: string;
}

export type AudioPlayerLifecycleEvent =
  | { phase: "idle" }
  | (AudioClipIdentity & {
      phase: Exclude<AudioPlayerPhase, "idle">;
    });

export interface AudioLifecycleState {
  phase: AudioPlayerPhase;
  playbackId: string | null;
  commitId: string | null;
  commitNo: number | null;
}

export interface PhraseJourneyCommit extends CommitIdentity {
  stage: PhraseJourneyStage;
  audioPhase: CommitAudioPhase;
  playbackId: string | null;
}

export type PhraseJourneyFailure =
  | "review-rejection"
  | "commit-failure"
  | "tts-failure"
  | "playback-error";

export interface PhraseJourneyNotice extends CommitIdentity {
  status: PhraseJourneyFailure;
}

export interface PhraseJourneyState {
  commits: Readonly<Record<string, PhraseJourneyCommit>>;
  terminalCommits: Readonly<
    Record<string, { commitNo: number; replayable: boolean }>
  >;
  closedPlaybackIds: Readonly<Record<string, true>>;
  audio: AudioLifecycleState;
  notice: PhraseJourneyNotice | null;
}

export type PhraseJourneyStatus =
  | "ready"
  | "listening"
  | "finalizing"
  | PhraseJourneyStage
  | "audio-ready"
  | "playing"
  | "blocked"
  | "muted"
  | PhraseJourneyFailure;

export interface PhraseJourneySelection {
  status: PhraseJourneyStatus;
  step: 0 | 1 | 2 | 3 | 4;
  commitNo: number | null;
  isFailure: boolean;
}

export type PhraseJourneyAction =
  | ({ type: "queue" } & CommitIdentity)
  | { type: "progress"; payload: TranslationProgressPayload }
  | ({ type: "committed"; duplicate: boolean } & CommitIdentity)
  | ({ type: "rejected" } & CommitIdentity)
  | ({ type: "commit-failed" } & CommitIdentity)
  | ({ type: "tts-failed" } & CommitIdentity)
  | { type: "audio"; event: AudioPlayerLifecycleEvent }
  | { type: "reset" };

const IDLE_AUDIO: AudioLifecycleState = {
  phase: "idle",
  playbackId: null,
  commitId: null,
  commitNo: null,
};

const STAGE_RANK: Record<PhraseJourneyStage, number> = {
  queued: 0,
  reviewing: 1,
  persisting: 2,
  synthesizing: 3,
};

const STATUS_STEP: Record<PhraseJourneyStatus, 0 | 1 | 2 | 3 | 4> = {
  ready: 0,
  listening: 0,
  finalizing: 0,
  queued: 1,
  reviewing: 1,
  "review-rejection": 1,
  persisting: 2,
  "commit-failure": 2,
  synthesizing: 3,
  "tts-failure": 3,
  "audio-ready": 4,
  playing: 4,
  blocked: 4,
  muted: 4,
  "playback-error": 4,
};

const FAILURE_STATUSES = new Set<PhraseJourneyStatus>([
  "review-rejection",
  "commit-failure",
  "tts-failure",
  "playback-error",
]);

export function createPhraseJourneyState(): PhraseJourneyState {
  return {
    commits: {},
    terminalCommits: {},
    closedPlaybackIds: {},
    audio: IDLE_AUDIO,
    notice: null,
  };
}

function isValidIdentity(identity: CommitIdentity): boolean {
  return (
    identity.commitId.trim().length > 0 &&
    Number.isSafeInteger(identity.commitNo) &&
    identity.commitNo > 0
  );
}

function isProgressStage(stage: unknown): stage is TranslationProgressStage {
  return stage === "reviewing" || stage === "persisting" || stage === "synthesizing";
}

function matchesIdentity(
  commit: CommitIdentity | undefined,
  identity: CommitIdentity,
): boolean {
  return Boolean(
    commit &&
      commit.commitId === identity.commitId &&
      commit.commitNo === identity.commitNo,
  );
}

function withAdvancedStage(
  state: PhraseJourneyState,
  identity: CommitIdentity,
  stage: PhraseJourneyStage,
): PhraseJourneyState {
  const current = state.commits[identity.commitId];
  if (!current || !matchesIdentity(current, identity)) return state;
  if (STAGE_RANK[stage] <= STAGE_RANK[current.stage]) return state;
  return {
    ...state,
    commits: {
      ...state.commits,
      [identity.commitId]: { ...current, stage },
    },
  };
}

function withoutCommit(
  state: PhraseJourneyState,
  identity: CommitIdentity,
  noticeStatus?: PhraseJourneyFailure,
  replayable = false,
): PhraseJourneyState {
  if (state.terminalCommits[identity.commitId] !== undefined) return state;
  const current = state.commits[identity.commitId];
  if (!matchesIdentity(current, identity)) return state;

  const commits = { ...state.commits };
  delete commits[identity.commitId];
  return {
    ...state,
    commits,
    terminalCommits: {
      ...state.terminalCommits,
      [identity.commitId]: { commitNo: identity.commitNo, replayable },
    },
    notice: noticeStatus ? { ...identity, status: noticeStatus } : state.notice,
  };
}

/**
 * Models only observable media lifecycle. A queued clip cannot displace a clip
 * that the browser has confirmed is currently playing, and ended/error are
 * absorbing for one playback attempt.
 */
export function advanceAudioLifecycle(
  current: AudioLifecycleState,
  event: AudioPlayerLifecycleEvent,
): AudioLifecycleState {
  if (event.phase === "idle") return IDLE_AUDIO;
  if (!isValidIdentity(event) || event.playbackId.trim().length === 0) return current;

  const samePlayback = current.playbackId === event.playbackId;
  if (
    samePlayback &&
    (current.phase === "ended" || current.phase === "playback-error")
  ) {
    return current;
  }
  if (
    current.phase === "playing" &&
    ((!samePlayback &&
      (event.phase === "queued" || event.phase === "muted-queued")) ||
      (samePlayback &&
        (event.phase === "queued" ||
          event.phase === "ready" ||
          event.phase === "blocked" ||
          event.phase === "muted-queued")))
  ) {
    return current;
  }
  if (samePlayback && current.phase === "ready" && event.phase === "queued") {
    return current;
  }

  return {
    phase: event.phase,
    playbackId: event.playbackId,
    commitId: event.commitId,
    commitNo: event.commitNo,
  };
}

function commitAudioPhase(
  event: Exclude<AudioPlayerLifecycleEvent, { phase: "idle" }>,
): CommitAudioPhase | null {
  switch (event.phase) {
    case "queued":
    case "ready":
    case "playing":
    case "blocked":
    case "muted-queued":
      return event.phase;
    case "ended":
    case "playback-error":
      return null;
  }
}

function reduceAudioEvent(
  state: PhraseJourneyState,
  event: AudioPlayerLifecycleEvent,
): PhraseJourneyState {
  if (event.phase === "idle") {
    const nextAudio = advanceAudioLifecycle(state.audio, event);
    return nextAudio === state.audio ? state : { ...state, audio: nextAudio };
  }

  const identity: CommitIdentity = event;
  if (state.closedPlaybackIds[event.playbackId]) return state;

  const current = state.commits[event.commitId];
  const terminal = state.terminalCommits[event.commitId];
  const continuesKnownPlayback =
    state.audio.playbackId === event.playbackId &&
    state.audio.commitId === event.commitId &&
    state.audio.commitNo === event.commitNo;
  const startsReplay =
    terminal?.commitNo === event.commitNo &&
    terminal.replayable &&
    (event.phase === "queued" || event.phase === "muted-queued");
  if (!matchesIdentity(current, identity) && !continuesKnownPlayback && !startsReplay) {
    return state;
  }

  const nextAudio = advanceAudioLifecycle(state.audio, event);
  const clearsMatchingNotice =
    event.phase !== "playback-error" &&
    matchesIdentity(state.notice ?? undefined, identity);
  let nextState: PhraseJourneyState = {
    ...state,
    audio: nextAudio,
    notice: clearsMatchingNotice ? null : state.notice,
  };

  if (event.phase === "playback-error") {
    nextState = {
      ...nextState,
      closedPlaybackIds: {
        ...nextState.closedPlaybackIds,
        [event.playbackId]: true,
      },
    };
    return withoutCommit(nextState, identity, "playback-error", true);
  }
  if (event.phase === "ended") {
    nextState = {
      ...nextState,
      closedPlaybackIds: {
        ...nextState.closedPlaybackIds,
        [event.playbackId]: true,
      },
    };
    return withoutCommit(nextState, identity, undefined, true);
  }

  const phase = commitAudioPhase(event);
  if (!phase || !current || !matchesIdentity(current, event)) return nextState;
  nextState = {
    ...nextState,
    commits: {
      ...nextState.commits,
      [event.commitId]: {
        ...current,
        audioPhase: phase,
        playbackId: event.playbackId,
      },
    },
  };
  return nextState;
}

export function phraseJourneyReducer(
  state: PhraseJourneyState,
  action: PhraseJourneyAction,
): PhraseJourneyState {
  switch (action.type) {
    case "queue": {
      if (!isValidIdentity(action)) return state;
      if (state.terminalCommits[action.commitId] !== undefined) return state;
      const current = state.commits[action.commitId];
      if (current) return state;
      return {
        ...state,
        commits: {
          ...state.commits,
          [action.commitId]: {
            commitId: action.commitId,
            commitNo: action.commitNo,
            stage: "queued",
            audioPhase: "none",
            playbackId: null,
          },
        },
        notice: null,
      };
    }
    case "progress": {
      const { payload } = action;
      if (!isValidIdentity(payload) || !isProgressStage(payload.stage)) return state;
      return withAdvancedStage(state, payload, payload.stage);
    }
    case "committed":
      // ACK publishes canonical text before TTS is necessarily terminal. Keep
      // both new and duplicate commits on VOICE until TTS/playback advances it.
      return withAdvancedStage(state, action, "synthesizing");
    case "rejected":
      return withoutCommit(state, action, "review-rejection");
    case "commit-failed":
      return withoutCommit(state, action, "commit-failure");
    case "tts-failed":
      return withoutCommit(state, action, "tts-failure");
    case "audio":
      return reduceAudioEvent(state, action.event);
    case "reset":
      return createPhraseJourneyState();
  }
}

function oldestUnresolvedCommit(
  commits: Readonly<Record<string, PhraseJourneyCommit>>,
): PhraseJourneyCommit | null {
  let oldest: PhraseJourneyCommit | null = null;
  for (const commit of Object.values(commits)) {
    if (!oldest || commit.commitNo < oldest.commitNo) oldest = commit;
  }
  return oldest;
}

function statusForAudioPhase(phase: CommitAudioPhase): PhraseJourneyStatus | null {
  switch (phase) {
    case "queued":
    case "ready":
      return "audio-ready";
    case "playing":
      return "playing";
    case "blocked":
      return "blocked";
    case "muted-queued":
      return "muted";
    case "none":
      return null;
  }
}

function selection(
  status: PhraseJourneyStatus,
  commitNo: number | null,
): PhraseJourneySelection {
  return {
    status,
    step: STATUS_STEP[status],
    commitNo,
    isFailure: FAILURE_STATUSES.has(status),
  };
}

/** Selects the one Phrase Journey message that should be visible right now. */
export function selectPhraseJourney(
  state: PhraseJourneyState,
  options: { finalizing: boolean; listening?: boolean },
): PhraseJourneySelection {
  if (state.audio.phase === "playing") {
    return selection("playing", state.audio.commitNo);
  }

  const oldest = oldestUnresolvedCommit(state.commits);
  if (oldest) {
    const audioStatus = statusForAudioPhase(oldest.audioPhase);
    return selection(audioStatus ?? oldest.stage, oldest.commitNo);
  }

  if (state.audio.phase !== "idle" && state.audio.phase !== "ended") {
    const globalStatus: Partial<Record<AudioPlayerPhase, PhraseJourneyStatus>> = {
      queued: "audio-ready",
      ready: "audio-ready",
      blocked: "blocked",
      "muted-queued": "muted",
      "playback-error": "playback-error",
    };
    const status = globalStatus[state.audio.phase];
    if (status) return selection(status, state.audio.commitNo);
  }

  if (state.notice) return selection(state.notice.status, state.notice.commitNo);
  if (options.finalizing) return selection("finalizing", null);
  if (options.listening) return selection("listening", null);
  return selection("ready", null);
}
