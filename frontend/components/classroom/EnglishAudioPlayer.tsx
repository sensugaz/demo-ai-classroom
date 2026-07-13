"use client";

/**
 * Auto-plays English TTS clips in order. Playback state is reported from the
 * media element's real lifecycle; receiving a clip only means it is queued.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { TtsAudioEvent } from "@/hooks/useClassroomSocket";
import type {
  AudioPlayerLifecycleEvent,
  AudioPlayerPhase,
} from "@/lib/phraseJourney";

interface EnglishAudioPlayerProps {
  latest: TtsAudioEvent | null;
  onLifecycleChange?: (event: AudioPlayerLifecycleEvent) => void;
}

interface AudioClip {
  base64: string;
  text: string;
  playbackRate: number;
  commitId: string;
  commitNo: number;
}

interface QueueItem extends AudioClip {
  playbackId: string;
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

export function EnglishAudioPlayer({
  latest,
  onLifecycleChange,
}: EnglishAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const activeItemRef = useRef<QueueItem | null>(null);
  const busyRef = useRef(false);
  const playingRef = useRef(false);
  const mutedRef = useRef(false);
  const seenIdsRef = useRef<Set<number>>(new Set());
  const ownedUrlsRef = useRef<Set<string>>(new Set());
  const playNextRef = useRef<() => void>(() => {});
  const detachActiveListenersRef = useRef<() => void>(() => {});
  const lastClipRef = useRef<AudioClip | null>(null);
  const failedClipRef = useRef<AudioClip | null>(null);
  const playbackAttemptRef = useRef(0);
  const onLifecycleChangeRef = useRef(onLifecycleChange);

  const [needsGesture, setNeedsGesture] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [playerPhase, setPlayerPhase] = useState<AudioPlayerPhase>("idle");

  useEffect(() => {
    onLifecycleChangeRef.current = onLifecycleChange;
  }, [onLifecycleChange]);

  const emitLifecycle = useCallback((event: AudioPlayerLifecycleEvent) => {
    onLifecycleChangeRef.current?.(event);
  }, []);

  const nextPlaybackId = useCallback((commitId: string) => {
    playbackAttemptRef.current += 1;
    return `${commitId}:playback:${playbackAttemptRef.current}`;
  }, []);

  const createQueueItem = useCallback(
    (clip: AudioClip, playbackId: string): QueueItem => {
      const blob = base64ToBlob(clip.base64);
      const url = URL.createObjectURL(blob);
      ownedUrlsRef.current.add(url);
      return { ...clip, playbackId, url };
    },
    [],
  );

  const revokeUrl = useCallback((url: string) => {
    if (!ownedUrlsRef.current.delete(url)) return;
    URL.revokeObjectURL(url);
  }, []);

  const emitItemPhase = useCallback(
    (item: QueueItem, phase: Exclude<AudioPlayerPhase, "idle">) => {
      emitLifecycle({
        phase,
        playbackId: item.playbackId,
        commitId: item.commitId,
        commitNo: item.commitNo,
      });
    },
    [emitLifecycle],
  );

  const rememberFailure = useCallback((clip: AudioClip, message: string) => {
    failedClipRef.current = clip;
    setPlaybackError(message);
    setPlayerPhase("playback-error");
  }, []);

  const markQueued = useCallback(
    (item: QueueItem) => {
      const phase = mutedRef.current ? "muted-queued" : "queued";
      if (!playingRef.current) setPlayerPhase(phase);
      emitItemPhase(item, phase);
    },
    [emitItemPhase],
  );

  const playNext = useCallback(() => {
    if (busyRef.current || mutedRef.current) return;
    const audio = audioRef.current;
    if (!audio) return;

    const next = queueRef.current.shift();
    if (!next) {
      activeItemRef.current = null;
      playingRef.current = false;
      setNowPlaying(null);
      setPlayerPhase("idle");
      emitLifecycle({ phase: "idle" });
      return;
    }

    busyRef.current = true;
    playingRef.current = false;
    activeItemRef.current = next;
    setNowPlaying(null);
    setPlayerPhase("queued");

    let settled = false;
    const detach = () => {
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onMediaError);
      if (detachActiveListenersRef.current === detach) {
        detachActiveListenersRef.current = () => {};
      }
    };
    const releaseCurrent = () => {
      activeItemRef.current = null;
      busyRef.current = false;
      playingRef.current = false;
      setNowPlaying(null);
    };
    const skipFailedClip = (message: string) => {
      if (settled) return;
      settled = true;
      detach();
      emitItemPhase(next, "playback-error");
      revokeUrl(next.url);
      releaseCurrent();
      rememberFailure(next, message);
      if (queueRef.current.length > 0) playNextRef.current();
    };
    const onCanPlay = () => {
      if (settled || playingRef.current) return;
      setPlayerPhase("ready");
      emitItemPhase(next, "ready");
    };
    const onPlaying = () => {
      if (settled) return;
      playingRef.current = true;
      failedClipRef.current = null;
      setPlaybackError(null);
      setNeedsGesture(false);
      setNowPlaying(next.text);
      setPlayerPhase("playing");
      emitItemPhase(next, "playing");
    };
    const onEnded = () => {
      if (settled) return;
      settled = true;
      detach();
      emitItemPhase(next, "ended");
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
        setPlayerPhase("blocked");
        emitItemPhase(next, "blocked");
        return;
      }
      skipFailedClip("English audio playback failed.");
    };

    detachActiveListenersRef.current = detach;
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onMediaError);
    audio.src = next.url;
    audio.playbackRate = next.playbackRate;
    (
      audio as HTMLAudioElement & { preservesPitch?: boolean }
    ).preservesPitch = true;
    audio.load();

    try {
      void audio.play().catch(handlePlayFailure);
    } catch (error) {
      handlePlayFailure(error);
    }
  }, [emitItemPhase, emitLifecycle, rememberFailure, revokeUrl]);

  useEffect(() => {
    playNextRef.current = playNext;
  }, [playNext]);

  useEffect(() => {
    if (!latest || seenIdsRef.current.has(latest.id)) return;
    seenIdsRef.current.add(latest.id);

    const {
      audioBase64,
      text,
      playbackRate,
      speechSpeed,
      commitId,
      commitNo,
    } = latest.payload;
    if (!audioBase64) return;
    const clip: AudioClip = {
      base64: audioBase64,
      text,
      playbackRate: normalizePlaybackRate(playbackRate, speechSpeed),
      commitId,
      commitNo,
    };
    lastClipRef.current = clip;
    const playbackId = nextPlaybackId(commitId);

    try {
      const item = createQueueItem(clip, playbackId);
      queueRef.current.push(item);
      markQueued(item);
      if (!mutedRef.current) playNext();
    } catch {
      rememberFailure(clip, "English audio could not be decoded.");
      emitLifecycle({
        phase: "playback-error",
        playbackId,
        commitId,
        commitNo,
      });
    }
  }, [
    createQueueItem,
    emitLifecycle,
    latest,
    markQueued,
    nextPlaybackId,
    playNext,
    rememberFailure,
  ]);

  const enqueueAgain = useCallback(
    (clip: AudioClip, atFront: boolean) => {
      const playbackId = nextPlaybackId(clip.commitId);
      try {
        const item = createQueueItem(clip, playbackId);
        if (atFront) queueRef.current.unshift(item);
        else queueRef.current.push(item);
        markQueued(item);
        if (!mutedRef.current) playNext();
        return true;
      } catch {
        rememberFailure(clip, "English audio could not be decoded.");
        emitLifecycle({
          phase: "playback-error",
          playbackId,
          commitId: clip.commitId,
          commitNo: clip.commitNo,
        });
        return false;
      }
    },
    [
      createQueueItem,
      emitLifecycle,
      markQueued,
      nextPlaybackId,
      playNext,
      rememberFailure,
    ],
  );

  const handleEnableAudio = useCallback(() => {
    setNeedsGesture(false);
    playNext();
  }, [playNext]);

  const handleRetryAudio = useCallback(() => {
    const failed = failedClipRef.current;
    if (!failed) return;
    failedClipRef.current = null;
    setPlaybackError(null);
    enqueueAgain(failed, true);
  }, [enqueueAgain]);

  const handleReplay = useCallback(() => {
    const last = lastClipRef.current;
    if (!last) return;
    enqueueAgain(last, true);
  }, [enqueueAgain]);

  const handleToggleMute = useCallback(() => {
    setMuted((previous) => {
      const next = !previous;
      mutedRef.current = next;
      const audio = audioRef.current;
      if (audio) audio.muted = next;

      if (next) {
        if (queueRef.current.length > 0) {
          setPlayerPhase("muted-queued");
          for (const item of queueRef.current) {
            emitItemPhase(item, "muted-queued");
          }
        }
      } else {
        for (const item of queueRef.current) {
          emitItemPhase(item, "queued");
        }
        playNextRef.current();
      }
      return next;
    });
  }, [emitItemPhase]);

  useEffect(() => {
    const queue = queueRef.current;
    const ownedUrls = ownedUrlsRef.current;
    const audio = audioRef.current;
    return () => {
      detachActiveListenersRef.current();
      audio?.pause();
      if (audio) audio.removeAttribute("src");
      queue.length = 0;
      activeItemRef.current = null;
      busyRef.current = false;
      playingRef.current = false;
      for (const url of ownedUrls) URL.revokeObjectURL(url);
      ownedUrls.clear();
    };
  }, []);

  const isPlaying = playerPhase === "playing" && !muted;
  const statusText = muted
    ? playerPhase === "muted-queued"
      ? "Muted · audio waiting"
      : "Muted"
    : playbackError
      ? playbackError
      : needsGesture
        ? "Tap to enable audio"
        : playerPhase === "playing" && nowPlaying
          ? `Playing: ${nowPlaying}`
          : playerPhase === "ready"
            ? "English audio ready"
            : playerPhase === "queued"
              ? "English audio queued"
              : "Auto-plays translation";

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
            role={playbackError ? "alert" : undefined}
            className={`truncate text-xs ${
              playbackError ? "text-[#9a2b1c]" : "text-ink-faint"
            }`}
          >
            {statusText}
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
                aria-hidden="true"
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
