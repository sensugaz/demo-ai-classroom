import assert from "node:assert/strict";
import test from "node:test";

import { runEndClassFlow } from "../lib/endClassFlow.ts";
import { isConnectionAttemptCurrent } from "../lib/realtimeConnection.ts";

test("invalidates a microphone permission result after End Class starts", () => {
  assert.equal(
    isConnectionAttemptCurrent({
      mounted: true,
      closing: true,
      currentGeneration: 2,
      attemptGeneration: 1,
    }),
    false,
  );
});

test("awaits finalization before navigating to results", async () => {
  const calls: string[] = [];
  await runEndClassFlow({
    closeRealtime: async () => {
      calls.push("close");
    },
    waitForCommitDrain: async () => {
      calls.push("drain");
      return true;
    },
    endSession: async () => {
      calls.push("end");
    },
    navigate: () => {
      calls.push("navigate");
    },
  });

  assert.deepEqual(calls, ["close", "drain", "end", "navigate"]);
});

test("does not navigate when finalization fails", async () => {
  let navigated = false;
  await assert.rejects(
    runEndClassFlow({
      closeRealtime: async () => {},
      waitForCommitDrain: async () => true,
      endSession: async () => {
        throw new Error("finalize failed");
      },
      navigate: () => {
        navigated = true;
      },
    }),
    /finalize failed/,
  );
  assert.equal(navigated, false);
});
