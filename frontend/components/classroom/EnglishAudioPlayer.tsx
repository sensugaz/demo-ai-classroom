"use client";

/**
 * Auto-plays received English TTS clips, queued so they never overlap.
 *
 * Each new id is decoded (base64 -> Blob -> object URL) and pushed onto a FIFO
 * queue; a single <audio> element drains the queue one clip at a time. Browsers
 * may block autoplay until a user gesture — we detect that and show a one-tap
 * "Enable audio" affordance. A teacher can Mute or Replay the last line at any
 * time without hunting menus.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { TtsAudioEvent } from "@/hooks/useClassroomSocket";

interface EnglishAudioPlayerProps {
  latest: TtsAudioEvent | null;
}

interface QueueItem {
  id: number;
  url: string;
  text: string;
}

function base64ToBlob(base64: string, mimeType = "audio/mpeg"): Blob {
  const byteChars = atob(base64);
  const byteNumbers = new Array<number>(byteChars.length);
  for (let i = 0; i < byteChars.length; i += 1) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
}

export function EnglishAudioPlayer({ latest }: EnglishAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const playingRef = useRef<boolean>(false);
  const seenIdsRef = useRef<Set<number>>(new Set());
  // Keep the last clip's raw payload so "Replay" can rebuild a fresh blob even
  // after the played URL was revoked.
  const lastClipRef = useRef<{ base64: string; text: string } | null>(null);

  const [needsGesture, setNeedsGesture] = useState<boolean>(false);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const [muted, setMuted] = useState<boolean>(false);

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
    setNowPlaying(next.text);
    audio.src = next.url;

    const cleanupUrl = () => {
      URL.revokeObjectURL(next.url);
    };

    const onEnded = () => {
      audio.removeEventListener("ended", onEnded);
      cleanupUrl();
      playingRef.current = false;
      playNext();
    };
    audio.addEventListener("ended", onEnded);

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.then === "function") {
      playPromise.catch(() => {
        audio.removeEventListener("ended", onEnded);
        queueRef.current.unshift(next);
        playingRef.current = false;
        setNowPlaying(null);
        setNeedsGesture(true);
      });
    }
  }, []);

  // Enqueue each newly-arrived clip.
  useEffect(() => {
    if (!latest) return;
    if (seenIdsRef.current.has(latest.id)) return;
    seenIdsRef.current.add(latest.id);

    const { audioBase64, text } = latest.payload;
    if (!audioBase64) return;
    lastClipRef.current = { base64: audioBase64, text };

    try {
      const blob = base64ToBlob(audioBase64);
      const url = URL.createObjectURL(blob);
      queueRef.current.push({ id: latest.id, url, text });
      if (!muted) {
        playNext();
      }
    } catch {
      // Ignore malformed base64 audio; pipeline continues without playback.
    }
  }, [latest, muted, playNext]);

  const handleEnableAudio = useCallback(() => {
    setNeedsGesture(false);
    playingRef.current = false;
    playNext();
  }, [playNext]);

  const handleReplay = useCallback(() => {
    const last = lastClipRef.current;
    if (!last) return;
    try {
      const blob = base64ToBlob(last.base64);
      const url = URL.createObjectURL(blob);
      // Replay jumps the queue so the teacher hears it immediately.
      queueRef.current.unshift({ id: -Date.now(), url, text: last.text });
      if (!muted) {
        playNext();
      }
    } catch {
      // ignore
    }
  }, [muted, playNext]);

  const handleToggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
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

  // Revoke any remaining object URLs on unmount.
  useEffect(() => {
    const queue = queueRef.current;
    return () => {
      for (const item of queue) {
        URL.revokeObjectURL(item.url);
      }
      queue.length = 0;
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
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5 6 9H2v6h4l5 4V5Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8 8 0 0 1 0 12" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="font-display text-[0.7rem] font-extrabold uppercase tracking-wide text-ink">
            English audio
          </p>
          <p className="truncate text-xs text-ink-faint" aria-live="polite">
            {muted
              ? "Muted"
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
          <button
            type="button"
            onClick={handleReplay}
            aria-label="Replay last line"
            className="grid h-10 w-10 place-items-center rounded-none text-ink ring-1 ring-ink transition hover:bg-canvas-soft"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4" />
            </svg>
          </button>
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
