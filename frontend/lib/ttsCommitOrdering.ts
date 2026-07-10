interface ReadyCommitInput {
  acknowledgedCommitNos: Iterable<number>;
  audioCommitNos: ReadonlySet<number>;
  noAudioCommitNos: ReadonlySet<number>;
  smallestPendingCommitNo: number;
}

/** A commit becomes playable only after its ACK and terminal TTS outcome. */
export function readyTtsCommitNos(input: ReadyCommitInput): number[] {
  const acknowledged = [...input.acknowledgedCommitNos]
    .filter((commitNo) => commitNo < input.smallestPendingCommitNo)
    .sort((left, right) => left - right);
  const ready: number[] = [];
  for (const commitNo of acknowledged) {
    if (
      !input.audioCommitNos.has(commitNo) &&
      !input.noAudioCommitNos.has(commitNo)
    ) {
      break;
    }
    ready.push(commitNo);
  }
  return ready;
}
