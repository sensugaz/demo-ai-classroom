interface EndClassFlowOptions {
  closeRealtime: (timeoutMs: number) => Promise<void>;
  waitForCommitDrain: (timeoutMs: number) => Promise<boolean>;
  endSession: () => Promise<unknown>;
  navigate: () => void;
  timeoutMs?: number;
}

export async function runEndClassFlow(
  options: EndClassFlowOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  await options.closeRealtime(timeoutMs);
  if (!(await options.waitForCommitDrain(timeoutMs))) {
    throw new Error(
      "The final translation has not been saved yet. Reconnect and retry End Class.",
    );
  }
  await options.endSession();
  options.navigate();
}
