import type { TranslationCommitPayload, TtsAudioPayload } from "./types";

export interface PendingCommitCollections {
  pendingCommits: Map<string, TranslationCommitPayload>;
  sentCommitIds: Set<string>;
  acknowledgedCommitNos: Set<number>;
  noAudioCommitNos: Set<number>;
  ttsByCommitNo: Map<number, TtsAudioPayload>;
}

export interface CommitTerminalIdentity {
  commitId: string;
  commitNo: number;
}

/** Terminates one exact pending commit and marks it as an ordered no-audio outcome. */
export function settleCommitWithoutAudio(
  collections: PendingCommitCollections,
  identity: CommitTerminalIdentity,
): boolean {
  const pending = collections.pendingCommits.get(identity.commitId);
  if (!pending || pending.commitNo !== identity.commitNo) return false;

  collections.pendingCommits.delete(identity.commitId);
  collections.sentCommitIds.delete(identity.commitId);
  collections.acknowledgedCommitNos.add(identity.commitNo);
  collections.noAudioCommitNos.add(identity.commitNo);
  collections.ttsByCommitNo.delete(identity.commitNo);

  return true;
}
