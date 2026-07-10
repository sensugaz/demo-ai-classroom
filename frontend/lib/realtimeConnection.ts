interface ConnectionAttemptState {
  mounted: boolean;
  closing: boolean;
  currentGeneration: number;
  attemptGeneration: number;
}

export function isConnectionAttemptCurrent(
  state: ConnectionAttemptState,
): boolean {
  return (
    state.mounted &&
    !state.closing &&
    state.currentGeneration === state.attemptGeneration
  );
}
