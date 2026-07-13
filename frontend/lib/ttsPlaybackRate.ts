import type { TtsSpeechSpeed } from "@/lib/types";

export const TTS_PLAYBACK_RATES: Readonly<Record<TtsSpeechSpeed, number>> = {
  slow: 0.78,
  medium: 0.86,
  fast: 1,
};

interface AudioPlaybackTarget {
  src: string;
  defaultPlaybackRate: number;
  playbackRate: number;
  preservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
  load: () => void;
}

function isSpeechSpeed(value: string | undefined): value is TtsSpeechSpeed {
  return value === "slow" || value === "medium" || value === "fast";
}

export function resolveTtsPlaybackRate(
  eventRate: number | undefined,
  eventSpeed: string | undefined,
  fallbackSpeed: TtsSpeechSpeed,
): number {
  if (
    typeof eventRate === "number" &&
    Number.isFinite(eventRate) &&
    eventRate >= 0.5 &&
    eventRate <= 1.25
  ) {
    return eventRate;
  }

  return TTS_PLAYBACK_RATES[
    isSpeechSpeed(eventSpeed) ? eventSpeed : fallbackSpeed
  ];
}

export function applyTtsPlaybackRate(
  audio: AudioPlaybackTarget,
  playbackRate: number,
): void {
  audio.defaultPlaybackRate = playbackRate;
  audio.playbackRate = playbackRate;
  audio.preservesPitch = true;
  audio.webkitPreservesPitch = true;
}

export function prepareTtsPlayback(
  audio: AudioPlaybackTarget,
  source: string,
  playbackRate: number,
): void {
  audio.src = source;
  audio.load();
  applyTtsPlaybackRate(audio, playbackRate);
}
