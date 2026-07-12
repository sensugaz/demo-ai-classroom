import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PHRASE_DEBOUNCE_MS,
  PUNCTUATED_PHRASE_DEBOUNCE_MS,
  appendTranscriptDelta,
  normalizeCommittedText,
  phraseDebounceMs,
  takeAlignedTranscriptPhrase,
  takeCompletedTranscriptPhrase,
  takeSettledTranscriptPhrase,
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

test("keeps a skewed continuous-live phrase open", () => {
  const source = [
    { text: "สวัสดี", elapsedMs: 800 },
    { text: " วันนี้มาเล่านิทาน", elapsedMs: 2200 },
  ];
  const target = [
    { text: "Hello, today I will tell a story.", elapsedMs: 1200 },
  ];
  const phrase = takeSettledTranscriptPhrase(source, target);

  assert.equal(phrase.sourceText, "");
  assert.equal(phrase.translatedText, "");
  assert.deepEqual(phrase.remainingSource, source);
  assert.deepEqual(phrase.remainingTarget, target);
});

test("keeps a continuous-live phrase open without timing metadata", () => {
  const source = [{ text: "สวัสดี", elapsedMs: 0 }];
  const target = [{ text: "Hello", elapsedMs: 0 }];
  const phrase = takeSettledTranscriptPhrase(source, target);

  assert.equal(phrase.sourceText, "");
  assert.equal(phrase.translatedText, "");
  assert.deepEqual(phrase.remainingSource, source);
  assert.deepEqual(phrase.remainingTarget, target);
});

test("finalizes consecutive closed calls with independent timestamp drift", () => {
  const first = takeCompletedTranscriptPhrase(
    [{ text: "ประโยคแรก", elapsedMs: 1000 }],
    [{ text: "The first sentence.", elapsedMs: 1200 }],
  );
  const second = takeCompletedTranscriptPhrase(
    [{ text: "ประโยคที่สอง", elapsedMs: 2600 }],
    [{ text: "The second sentence.", elapsedMs: 1900 }],
  );

  assert.equal(first.sourceText, "ประโยคแรก");
  assert.equal(first.translatedText, "The first sentence.");
  assert.equal(second.sourceText, "ประโยคที่สอง");
  assert.equal(second.translatedText, "The second sentence.");
  assert.deepEqual(second.remainingSource, []);
  assert.deepEqual(second.remainingTarget, []);
});

test("does not finalize a closed call with only one language", () => {
  const phrase = takeCompletedTranscriptPhrase(
    [{ text: "ยังไม่มีคำแปล", elapsedMs: 3200 }],
    [],
  );

  assert.equal(phrase.sourceText, "");
  assert.equal(phrase.translatedText, "");
  assert.equal(phrase.remainingSource.length, 1);
});

test("flushes the complete bilingual phrase after streams converge", () => {
  const phrase = takeSettledTranscriptPhrase(
    [
      { text: "สวัสดี", elapsedMs: 800 },
      { text: " วันนี้มาเล่านิทาน", elapsedMs: 1400 },
    ],
    [{ text: "Hello, today I will tell a story.", elapsedMs: 1600 }],
  );

  assert.equal(phrase.sourceText, "สวัสดี วันนี้มาเล่านิทาน");
  assert.equal(phrase.translatedText, "Hello, today I will tell a story.");
  assert.deepEqual(phrase.remainingSource, []);
  assert.deepEqual(phrase.remainingTarget, []);
});
