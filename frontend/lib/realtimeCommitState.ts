import type { TranslationCommitPayload } from "./types";

export type UnresolvedCommit = Readonly<TranslationCommitPayload>;

export interface RealtimeCommitState {
  readonly pendingSave: ReadonlyMap<string, UnresolvedCommit>;
  readonly acknowledgedAwaitingAudio: ReadonlyMap<string, UnresolvedCommit>;
}

export interface CommitIdentity {
  commitId: string;
  commitNo: number;
}

export type CommitLocation = "pending-save" | "awaiting-audio";

interface CommitTransition {
  state: RealtimeCommitState;
  location: CommitLocation | null;
}

function stateWith(
  pendingSave: ReadonlyMap<string, UnresolvedCommit>,
  acknowledgedAwaitingAudio: ReadonlyMap<string, UnresolvedCommit>,
): RealtimeCommitState {
  return Object.freeze({ pendingSave, acknowledgedAwaitingAudio });
}

export function createRealtimeCommitState(): RealtimeCommitState {
  return stateWith(new Map(), new Map());
}

export function queueRealtimeCommit(
  state: RealtimeCommitState,
  payload: TranslationCommitPayload,
): RealtimeCommitState {
  const pendingSave = new Map(state.pendingSave);
  pendingSave.set(payload.commitId, Object.freeze({ ...payload }));
  return stateWith(pendingSave, state.acknowledgedAwaitingAudio);
}

export function unresolvedCommitLocation(
  state: RealtimeCommitState,
  identity: CommitIdentity,
): CommitLocation | null {
  const pending = state.pendingSave.get(identity.commitId);
  if (pending?.commitNo === identity.commitNo) return "pending-save";

  const awaiting = state.acknowledgedAwaitingAudio.get(identity.commitId);
  return awaiting?.commitNo === identity.commitNo ? "awaiting-audio" : null;
}

export function unresolvedCommitById(
  state: RealtimeCommitState,
  commitId: string,
): UnresolvedCommit | undefined {
  return (
    state.pendingSave.get(commitId) ??
    state.acknowledgedAwaitingAudio.get(commitId)
  );
}

/** Moves one exact save ACK to the audio-waiting map as a single state update. */
export function acknowledgeRealtimeCommit(
  state: RealtimeCommitState,
  identity: CommitIdentity,
): CommitTransition {
  const location = unresolvedCommitLocation(state, identity);
  if (location !== "pending-save") return { state, location };

  const commit = state.pendingSave.get(identity.commitId);
  if (!commit) return { state, location: null };

  const pendingSave = new Map(state.pendingSave);
  const acknowledgedAwaitingAudio = new Map(
    state.acknowledgedAwaitingAudio,
  );
  pendingSave.delete(identity.commitId);
  acknowledgedAwaitingAudio.set(identity.commitId, commit);

  return {
    state: stateWith(pendingSave, acknowledgedAwaitingAudio),
    location,
  };
}

/**
 * Accepts a terminal TTS outcome for either unresolved phase. Audio before ACK
 * remains pending-save; audio after ACK completes the full commit lifecycle.
 */
export function settleRealtimeTts(
  state: RealtimeCommitState,
  identity: CommitIdentity,
): CommitTransition {
  const location = unresolvedCommitLocation(state, identity);
  if (location !== "awaiting-audio") return { state, location };

  const acknowledgedAwaitingAudio = new Map(
    state.acknowledgedAwaitingAudio,
  );
  acknowledgedAwaitingAudio.delete(identity.commitId);
  return {
    state: stateWith(state.pendingSave, acknowledgedAwaitingAudio),
    location,
  };
}

/** Removes an exact unresolved commit after a non-TTS terminal outcome. */
export function terminateRealtimeCommit(
  state: RealtimeCommitState,
  identity: CommitIdentity,
): CommitTransition {
  const location = unresolvedCommitLocation(state, identity);
  if (!location) return { state, location: null };

  const pendingSave = new Map(state.pendingSave);
  const acknowledgedAwaitingAudio = new Map(
    state.acknowledgedAwaitingAudio,
  );
  pendingSave.delete(identity.commitId);
  acknowledgedAwaitingAudio.delete(identity.commitId);
  return {
    state: stateWith(pendingSave, acknowledgedAwaitingAudio),
    location,
  };
}

export function unresolvedCommitsForResend(
  state: RealtimeCommitState,
): UnresolvedCommit[] {
  return [
    ...state.pendingSave.values(),
    ...state.acknowledgedAwaitingAudio.values(),
  ].sort((left, right) => left.commitNo - right.commitNo);
}

export function isSaveDrainComplete(state: RealtimeCommitState): boolean {
  return state.pendingSave.size === 0;
}

export function isCommitDrainComplete(state: RealtimeCommitState): boolean {
  return (
    state.pendingSave.size === 0 &&
    state.acknowledgedAwaitingAudio.size === 0
  );
}
