const TERMINAL_PUNCTUATION = /[.!?\u2026\u3002\uff01\uff1f]\s*$/u;

export const DEFAULT_PHRASE_DEBOUNCE_MS = 800;
export const PUNCTUATED_PHRASE_DEBOUNCE_MS = 250;
export const DEFAULT_PHRASE_MAX_WINDOW_MS = 4000;
export const ALIGNMENT_SKEW_TOLERANCE_MS = 300;

export interface TimedTranscriptDelta {
  text: string;
  elapsedMs: number;
}

export interface AlignedTranscriptPhrase {
  sourceText: string;
  translatedText: string;
  sourceElapsedMs: number;
  targetElapsedMs: number;
  remainingSource: TimedTranscriptDelta[];
  remainingTarget: TimedTranscriptDelta[];
}

/** Realtime transcript deltas are append-only and already contain their spacing. */
export function appendTranscriptDelta(current: string, delta: string): string {
  return current + delta;
}

export function phraseDebounceMs(outputText: string): number {
  return TERMINAL_PUNCTUATION.test(outputText)
    ? PUNCTUATED_PHRASE_DEBOUNCE_MS
    : DEFAULT_PHRASE_DEBOUNCE_MS;
}

export function normalizeCommittedText(text: string): string {
  return text.trim();
}

function lastElapsed(deltas: TimedTranscriptDelta[]): number {
  return deltas.reduce((latest, delta) => Math.max(latest, delta.elapsedMs), 0);
}

/**
 * Split independent source/target streams at their shared audio time. This
 * keeps a faster source transcript from leaking words into an older English
 * phrase while preserving every unaligned delta for the next commit.
 */
export function takeAlignedTranscriptPhrase(
  source: TimedTranscriptDelta[],
  target: TimedTranscriptDelta[],
  flushAll = false,
): AlignedTranscriptPhrase {
  const empty: AlignedTranscriptPhrase = {
    sourceText: "",
    translatedText: "",
    sourceElapsedMs: 0,
    targetElapsedMs: 0,
    remainingSource: source,
    remainingTarget: target,
  };
  if (source.length === 0 || target.length === 0) return empty;

  const sourceLatest = lastElapsed(source);
  const targetLatest = lastElapsed(target);
  const hasAlignment =
    sourceLatest > 0 &&
    targetLatest > 0 &&
    source.every((delta) => delta.elapsedMs > 0) &&
    target.every((delta) => delta.elapsedMs > 0);

  if (!hasAlignment || flushAll) {
    return {
      sourceText: source.map((delta) => delta.text).join(""),
      translatedText: target.map((delta) => delta.text).join(""),
      sourceElapsedMs: sourceLatest,
      targetElapsedMs: targetLatest,
      remainingSource: [],
      remainingTarget: [],
    };
  }

  const cutoffMs = Math.min(sourceLatest, targetLatest);
  const committedSource = source.filter((delta) => delta.elapsedMs <= cutoffMs);
  const committedTarget = target.filter((delta) => delta.elapsedMs <= cutoffMs);
  const firstSource = source[0];
  const firstTarget = target[0];
  if (
    committedSource.length === 0 &&
    firstSource &&
    firstSource.elapsedMs - cutoffMs <= ALIGNMENT_SKEW_TOLERANCE_MS
  ) {
    committedSource.push(firstSource);
  }
  if (
    committedTarget.length === 0 &&
    firstTarget &&
    firstTarget.elapsedMs - cutoffMs <= ALIGNMENT_SKEW_TOLERANCE_MS
  ) {
    committedTarget.push(firstTarget);
  }
  if (committedSource.length === 0 || committedTarget.length === 0) return empty;

  const committedSourceSet = new Set(committedSource);
  const committedTargetSet = new Set(committedTarget);

  return {
    sourceText: committedSource.map((delta) => delta.text).join(""),
    translatedText: committedTarget.map((delta) => delta.text).join(""),
    sourceElapsedMs: lastElapsed(committedSource),
    targetElapsedMs: lastElapsed(committedTarget),
    remainingSource: source.filter((delta) => !committedSourceSet.has(delta)),
    remainingTarget: target.filter((delta) => !committedTargetSet.has(delta)),
  };
}
