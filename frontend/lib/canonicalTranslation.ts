import type {
  TranslationCommitPayload,
  TranslationCommittedPayload,
  TranslationLine,
} from "./types";

export type TranslationReviewOutcomeStatus =
  | "pending"
  | "accepted"
  | "rejected";

export interface TranslationReviewOutcome {
  commitNo: number;
  status: TranslationReviewOutcomeStatus;
}

export function advanceTranslationReviewOutcome(
  current: TranslationReviewOutcome,
  commitNo: number,
  status: TranslationReviewOutcomeStatus,
): TranslationReviewOutcome {
  if (!Number.isSafeInteger(commitNo) || commitNo <= 0 || commitNo < current.commitNo) {
    return current;
  }

  return { commitNo, status };
}

export function isExpectedPendingCommit(
  pendingCommits: ReadonlyMap<string, TranslationCommitPayload>,
  event: { commitId: string; commitNo: number },
): boolean {
  const pending = pendingCommits.get(event.commitId);

  return Boolean(pending && pending.commitNo === event.commitNo);
}

/** Runtime guard for backend acknowledgements before text or audio is released. */
export function isCanonicalTranslationCommittedPayload(
  payload: unknown,
): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = payload as Partial<TranslationCommittedPayload>;
  const reviewStatus = candidate.reviewStatus;

  return (
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.trim().length > 0 &&
    typeof candidate.commitId === "string" &&
    candidate.commitId.trim().length > 0 &&
    typeof candidate.commitNo === "number" &&
    Number.isSafeInteger(candidate.commitNo) &&
    candidate.commitNo > 0 &&
    typeof candidate.sequenceNo === "number" &&
    Number.isSafeInteger(candidate.sequenceNo) &&
    candidate.sequenceNo > 0 &&
    (candidate.commitKind === "debounced" || candidate.commitKind === "final") &&
    typeof candidate.duplicate === "boolean" &&
    typeof candidate.sourceText === "string" &&
    candidate.sourceText.trim().length > 0 &&
    typeof candidate.translatedText === "string" &&
    candidate.translatedText.trim().length > 0 &&
    (reviewStatus === "accepted" || reviewStatus === "corrected")
  );
}

/** Insert or replace one backend-reviewed English line by commit identity. */
export function upsertCanonicalTranslation(
  lines: TranslationLine[],
  payload: TranslationCommittedPayload,
): TranslationLine[] {
  const canonical: TranslationLine = {
    id: payload.commitId,
    sequenceNo: payload.sequenceNo,
    sourceText: payload.sourceText.trim(),
    translatedText: payload.translatedText.trim(),
    isFinal: true,
  };
  const existingIndex = lines.findIndex((line) => line.id === payload.commitId);
  if (existingIndex < 0) {
    return [...lines, canonical].sort(
      (left, right) => (left.sequenceNo ?? 0) - (right.sequenceNo ?? 0),
    );
  }

  const next = [...lines];
  next[existingIndex] = canonical;
  return next;
}
