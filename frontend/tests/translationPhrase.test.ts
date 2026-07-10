import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PHRASE_DEBOUNCE_MS,
  PUNCTUATED_PHRASE_DEBOUNCE_MS,
  appendTranscriptDelta,
  normalizeCommittedText,
  phraseDebounceMs,
  takeAlignedTranscriptPhrase,
} from "../lib/translationPhrase.ts";

test("appends realtime transcript deltas verbatim", () => {
  assert.equal(appendTranscriptDelta("Hello", " world"), "Hello world");
  assert.equal(appendTranscriptDelta("\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35", "\u0e04\u0e23\u0e31\u0e1a"), "\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35\u0e04\u0e23\u0e31\u0e1a");
});

test("uses a shorter settle window after terminal punctuation", () => {
  assert.equal(phraseDebounceMs("Finished."), PUNCTUATED_PHRASE_DEBOUNCE_MS);
  assert.equal(phraseDebounceMs("still speaking"), DEFAULT_PHRASE_DEBOUNCE_MS);
});

test("trims only when a phrase becomes a committed record", () => {
  assert.equal(normalizeCommittedText("  translated phrase  "), "translated phrase");
});

test("keeps faster source deltas for the next aligned phrase", () => {
  const phrase = takeAlignedTranscriptPhrase(
    [
      { text: "กาลครั้งหนึ่ง", elapsedMs: 900 },
      { text: " มีสวนดอกไม้", elapsedMs: 1800 },
    ],
    [{ text: "Once upon a time", elapsedMs: 1000 }],
  );

  assert.equal(phrase.sourceText, "กาลครั้งหนึ่ง");
  assert.equal(phrase.translatedText, "Once upon a time");
  assert.deepEqual(phrase.remainingSource, [
    { text: " มีสวนดอกไม้", elapsedMs: 1800 },
  ]);
  assert.deepEqual(phrase.remainingTarget, []);
});

test("commits a target delta within normal alignment skew", () => {
  const phrase = takeAlignedTranscriptPhrase(
    [{ text: "สวัสดี", elapsedMs: 900 }],
    [{ text: "Hello", elapsedMs: 1000 }],
  );

  assert.equal(phrase.sourceText, "สวัสดี");
  assert.equal(phrase.translatedText, "Hello");
  assert.deepEqual(phrase.remainingSource, []);
  assert.deepEqual(phrase.remainingTarget, []);
});
