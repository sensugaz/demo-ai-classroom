"use client";

/**
 * Auto-plays received English TTS clips, queued so they never overlap.
 * Autoplay blocks keep their clip queued for a user gesture; malformed or
 * unplayable clips are released and skipped so one failure cannot stall audio.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { TtsAudioEvent } from "@/hooks/useClassroomSocket";

interface EnglishAudioPlayerProps {
  latest: TtsAudioEvent | null;
}

interface AudioClip {
  id: number;
  base64: string;
  text: string;
  playbackRate: number;
}

interface QueueItem extends AudioClip {
  url: string;
}

function base64ToBlob(base64: string, mimeType = "audio/mpeg"): Blob {
  const byteChars = atob(base64);
  const byteNumbers = new Array<number>(byteChars.length);
  for (let i = 0; i < byteChars.length; i += 1) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
}

function normalizePlaybackRate(
  rate: number | undefined,
  speed: string | undefined,
): number {
  if (
    typeof rate === "number" &&
    Number.isFinite(rate) &&
    rate >= 0.5 &&
    rate <= 1.25
  ) {
    return rate;
  }
  switch (speed) {
    case "slow":
      return 0.72;
    case "fast":
      return 1;
    case "medium":
    default:
      return 0.86;
  }
}

function isNotAllowedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotAllowedError"
  );
}

export function EnglishAudioPlayer({ latest }: EnglishAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const activeItemRef = useRef<QueueItem | null>(null);
  const playingRef = useRef(false);
  const seenIdsRef = useRef<Set<number>>(new Set());
  const ownedUrlsRef = useRef<Set<string>>(new Set());
  const playNextRef = useRef<() => void>(() => {});
  const lastClipRef = useRef<AudioClip | null>(null);
  const failedClipRef = useRef<AudioClip | null>(null);

  const [needsGesture, setNeedsGesture] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const createQueueItem = useCallback((clip: AudioClip): QueueItem => {
    const blob = base64ToBlob(clip.base64);
    const url = URL.createObjectURL(blob);
    ownedUrlsRef.current.add(url);
    return { ...clip, url };
  }, []);

  const revokeUrl = useCallback((url: string) => {
    if (!ownedUrlsRef.current.delete(url)) return;
    URL.revokeObjectURL(url);
  }, []);

  const rememberFailure = useCallback((item: AudioClip, message: string) => {
    failedClipRef.current = item;
    setPlaybackError(message);
  }, []);

  const playNext = useCallback(() => {
    if (playingRef.current) return;
    const audio = audioRef.current;
    if (!audio) return;

    const next = queueRef.current.shift();
    if (!next) {
      setNowPlaying(null);
      return;
    }

    playingRef.current = true;
    activeItemRef.current = next;
    setNowPlaying(next.text);
    audio.src = next.url;
    audio.playbackRate = next.playbackRate;
    (
      audio as HTMLAudioElement & { preservesPitch?: boolean }
    ).preservesPitch = true;

    let settled = false;
    const detach = () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onMediaError);
    };
    const releaseCurrent = () => {
      activeItemRef.current = null;
      playingRef.current = false;
      setNowPlaying(null);
    };
    const skipFailedClip = (message: string) => {
      if (settled) return;
      settled = true;
      detach();
      revokeUrl(next.url);
      releaseCurrent();
      rememberFailure(next, message);
      playNextRef.current();
    };
    const onEnded = () => {
      if (settled) return;
      settled = true;
      detach();
      revokeUrl(next.url);
      releaseCurrent();
      playNextRef.current();
    };
    const onMediaError = () => {
      skipFailedClip("English audio could not be played.");
    };
    const handlePlayFailure = (error: unknown) => {
      if (settled) return;
      if (isNotAllowedError(error)) {
        settled = true;
        detach();
        releaseCurrent();
        queueRef.current.unshift(next);
        setNeedsGesture(true);
        return;
      }
      skipFailedClip("English audio playback failed.");
    };

    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onMediaError);
    try {
      void audio
        .play()
        .then(() => {
          failedClipRef.current = null;
          setPlaybackError(null);
          setNeedsGesture(false);
        })
        .catch(handlePlayFailure);
    } catch (error) {
      handlePlayFailure(error);
    }
  }, [rememberFailure, revokeUrl]);

  useEffect(() => {
    playNextRef.current = playNext;
  }, [playNext]);

  useEffect(() => {
    if (!latest || seenIdsRef.current.has(latest.id)) return;
    seenIdsRef.current.add(latest.id);

    const { audioBase64, text, playbackRate, speechSpeed } = latest.payload;
    if (!audioBase64) return;
    const clip: AudioClip = {
      id: latest.id,
      base64: audioBase64,
      text,
      playbackRate: normalizePlaybackRate(playbackRate, speechSpeed),
    };
    lastClipRef.current = clip;

    try {
      queueRef.current.push(createQueueItem(clip));
      if (!muted) {
        playNext();
      }
    } catch {
      rememberFailure(clip, "English audio could not be decoded.");
      playNext();
    }
  }, [createQueueItem, latest, muted, playNext, rememberFailure]);

  const handleEnableAudio = useCallback(() => {
    setNeedsGesture(false);
    playingRef.current = false;
    playNext();
  }, [playNext]);

  const handleRetryAudio = useCallback(() => {
    const failed = failedClipRef.current;
    if (!failed) return;
    try {
      queueRef.current.unshift(createQueueItem(failed));
      failedClipRef.current = null;
      setPlaybackError(null);
      if (!muted) {
        playNext();
      }
    } catch {
      setPlaybackError("English audio could not be decoded.");
    }
  }, [createQueueItem, muted, playNext]);

  const handleReplay = useCallback(() => {
    const last = lastClipRef.current;
    if (!last) return;
    try {
      queueRef.current.unshift(
        createQueueItem({ ...last, id: -Date.now() }),
      );
      if (!muted) {
        playNext();
      }
    } catch {
      rememberFailure(last, "English audio could not be decoded.");
    }
  }, [createQueueItem, muted, playNext, rememberFailure]);

  const handleToggleMute = useCallback(() => {
    setMuted((previous) => {
      const next = !previous;
      const audio = audioRef.current;
      if (audio) {
        audio.muted = next;
      }
      if (!next) {
        playNext();
      }
      return next;
    });
  }, [playNext]);

  useEffect(() => {
    const queue = queueRef.current;
    const ownedUrls = ownedUrlsRef.current;
    const audio = audioRef.current;
    return () => {
      audio?.pause();
      queue.length = 0;
      activeItemRef.current = null;
      playingRef.current = false;
      for (const url of ownedUrls) {
        URL.revokeObjectURL(url);
      }
      ownedUrls.clear();
    };
  }, []);

  const isPlaying = Boolean(nowPlaying) && !muted;

  return (
    <section
      aria-label="English audio playback"
      className="flex items-center justify-between gap-3 rounded-none bg-surface px-3 py-2 ring-1 ring-line"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-none ${
            isPlaying ? "bg-clay-600 text-canvas" : "text-ink ring-1 ring-ink"
          }`}
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M11 5 6 9H2v6h4l5 4V5Z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8 8 0 0 1 0 12"
            />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="font-display text-[0.7rem] font-extrabold uppercase tracking-wide text-ink">
            English audio
          </p>
          <p
            className={`truncate text-xs ${
              playbackError ? "text-[#9a2b1c]" : "text-ink-faint"
            }`}
            aria-live="polite"
          >
            {muted
              ? "Muted"
              : playbackError
                ? playbackError
                : nowPlaying
                  ? `Playing: ${nowPlaying}`
                  : "Auto-plays translation"}
          </p>
        </div>
      </div>

      {needsGesture && !muted ? (
        <button
          type="button"
          onClick={handleEnableAudio}
          className="min-h-[44px] shrink-0 rounded-none bg-ink px-4 font-display text-xs font-extrabold uppercase tracking-wide text-canvas transition hover:bg-brand-700"
        >
          Enable audio
        </button>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          {playbackError ? (
            <button
              type="button"
              onClick={handleRetryAudio}
              className="min-h-[40px] rounded-none px-3 font-display text-xs font-extrabold uppercase tracking-wide text-[#9a2b1c] ring-1 ring-[#9a2b1c] transition hover:bg-[#9a2b1c]/10"
            >
              Retry audio
            </button>
          ) : (
            <button
              type="button"
              onClick={handleReplay}
              aria-label="Replay last line"
              className="grid h-10 w-10 place-items-center rounded-none text-ink ring-1 ring-ink transition hover:bg-canvas-soft"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4"
                />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={handleToggleMute}
            aria-pressed={muted}
            className="min-h-[40px] rounded-none px-3 font-display text-xs font-extrabold uppercase tracking-wide text-ink ring-1 ring-ink transition hover:bg-canvas-soft"
          >
            {muted ? "Unmute" : "Mute"}
          </button>
        </div>
      )}

      <audio ref={audioRef} className="hidden" preload="auto" />
    </section>
  );
}

export default EnglishAudioPlayer;
