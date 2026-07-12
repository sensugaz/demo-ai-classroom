export type RealtimePhrasePhase =
  | "idle"
  | "streaming"
  | "closing"
  | "closed"
  | "committing"
  | "complete";

export interface RealtimePhraseLifecycle {
  generation: number;
  phase: RealtimePhrasePhase;
  commitConsumed: boolean;
}

export interface PhraseCommitDecision {
  lifecycle: RealtimePhraseLifecycle;
  shouldCommit: boolean;
}

export function createRealtimePhraseLifecycle(): RealtimePhraseLifecycle {
  return { generation: 0, phase: "idle", commitConsumed: false };
}

export function startRealtimePhraseCall(
  current: RealtimePhraseLifecycle,
): RealtimePhraseLifecycle {
  if (current.phase !== "idle" && current.phase !== "complete") return current;
  return {
    generation: current.generation + 1,
    phase: "streaming",
    commitConsumed: false,
  };
}

export function beginRealtimePhraseClose(
  current: RealtimePhraseLifecycle,
): RealtimePhraseLifecycle {
  if (current.phase !== "streaming") return current;
  return { ...current, phase: "closing" };
}

export function markRealtimePhraseClosed(
  current: RealtimePhraseLifecycle,
): RealtimePhraseLifecycle {
  if (current.phase !== "closing") return current;
  return { ...current, phase: "closed" };
}

export function shouldSchedulePhraseTimer(
  current: RealtimePhraseLifecycle,
): boolean {
  return current.phase === "streaming";
}

export function consumeClosedPhraseCommit(
  current: RealtimePhraseLifecycle,
): PhraseCommitDecision {
  if (current.phase !== "closed" || current.commitConsumed) {
    return { lifecycle: current, shouldCommit: false };
  }
  return {
    lifecycle: { ...current, phase: "committing", commitConsumed: true },
    shouldCommit: true,
  };
}

export function markRealtimePhraseCommitAcknowledged(
  current: RealtimePhraseLifecycle,
): RealtimePhraseLifecycle {
  if (current.phase !== "committing") return current;
  return { ...current, phase: "complete" };
}

export function abortRealtimePhraseCall(
  current: RealtimePhraseLifecycle,
): RealtimePhraseLifecycle {
  return { ...current, phase: "idle", commitConsumed: true };
}
