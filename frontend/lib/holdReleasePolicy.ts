import type { RecordingMode } from "./types";

export const HOLD_RELEASE_QUIET_MS = 400;
export const HOLD_RELEASE_HARD_CAP_MS = 2_000;

export type HoldReleaseAction = "pause-session" | "noop" | "commit-now";

export interface HoldReleasePlan {
  action: HoldReleaseAction;
  disableTrack: boolean;
  closeSession: boolean;
  waitForSave: boolean;
  waitForQuiescence: boolean;
}

export function planHoldRelease(
  recordingMode: RecordingMode,
  captureActive: boolean,
): HoldReleasePlan {
  if (recordingMode !== "ptt") {
    return {
      action: "pause-session",
      disableTrack: true,
      closeSession: true,
      waitForSave: true,
      waitForQuiescence: false,
    };
  }
  if (!captureActive) {
    return {
      action: "noop",
      disableTrack: true,
      closeSession: false,
      waitForSave: false,
      waitForQuiescence: false,
    };
  }
  return {
    action: "commit-now",
    disableTrack: true,
    closeSession: false,
    waitForSave: true,
    waitForQuiescence: true,
  };
}

export function automaticPhraseCommitEnabled(
  recordingMode: RecordingMode,
): boolean {
  return recordingMode === "live";
}

export interface HoldQuiescenceSchedule {
  dirtyNow: boolean;
  hardDelayMs: number;
  quietDelayMs: number;
}

export function holdQuiescenceSchedule(input: {
  releasedAt: number;
  lastDeltaAt: number;
  now: number;
}): HoldQuiescenceSchedule {
  const hardDelayMs = Math.max(
    0,
    HOLD_RELEASE_HARD_CAP_MS - (input.now - input.releasedAt),
  );
  return {
    dirtyNow: hardDelayMs === 0,
    hardDelayMs,
    quietDelayMs: Math.max(
      0,
      HOLD_RELEASE_QUIET_MS - (input.now - input.lastDeltaAt),
    ),
  };
}

export type HoldResumeDecision = "wait" | "reuse" | "reconnect";

export function holdResumeDecision(input: {
  saveDrained: boolean;
  quiescenceSettled: boolean;
  connectionDirty: boolean;
}): HoldResumeDecision {
  if (!input.saveDrained || !input.quiescenceSettled) return "wait";
  return input.connectionDirty ? "reconnect" : "reuse";
}
