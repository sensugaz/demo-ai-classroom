import assert from "node:assert/strict";
import test from "node:test";

import {
  beginPointerHold,
  endPointerHold,
} from "../lib/pushToTalkPointer.ts";

test("starts HOLD even when Safari rejects explicit pointer capture", () => {
  let began = 0;
  const target = {
    hasPointerCapture: () => false,
    setPointerCapture: () => {
      throw new DOMException("Unknown pointer", "NotFoundError");
    },
    releasePointerCapture: () => {},
  };

  assert.doesNotThrow(() => {
    beginPointerHold(target, 7, () => {
      began += 1;
    });
  });
  assert.equal(began, 1);
});

test("ends HOLD even when Safari already released pointer capture", () => {
  let ended = 0;
  const target = {
    hasPointerCapture: () => true,
    setPointerCapture: () => {},
    releasePointerCapture: () => {
      throw new DOMException("Unknown pointer", "NotFoundError");
    },
  };

  assert.doesNotThrow(() => {
    endPointerHold(target, 7, () => {
      ended += 1;
    });
  });
  assert.equal(ended, 1);
});
