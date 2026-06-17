"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import EnglishAudioPlayer from "@/components/classroom/EnglishAudioPlayer";
import EnglishTranslationPanel from "@/components/classroom/EnglishTranslationPanel";
import LiveThaiTranscript from "@/components/classroom/LiveThaiTranscript";
import SessionStatus from "@/components/classroom/SessionStatus";
import { useClassroomSession } from "@/hooks/useClassroomSession";
import { useClassroomSocket } from "@/hooks/useClassroomSocket";
import { useMicLevel } from "@/hooks/useMicLevel";
import { useMicrophoneRecorder } from "@/hooks/useMicrophoneRecorder";
import type { ClassroomSession, ConnectionStatus, RecordingMode } from "@/lib/types";

const CONN_BAR: Record<ConnectionStatus, string> = {
  open: "bg-live",
  connecting: "bg-reconnect",
  reconnecting: "bg-reconnect",
  closed: "bg-lost animate-seam-blink",
};

export default function LiveSessionPage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const sessionId = params?.sessionId ?? "";

  const { getSession, endSession: endSessionRest } = useClassroomSession();

  const [session, setSession] = useState<ClassroomSession | null>(null);
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [mode, setMode] = useState<RecordingMode>("live");
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [endArmed, setEndArmed] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const micRef = useRef<HTMLButtonElement | null>(null);
  const startRef = useRef<number | null>(null);
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load session metadata once.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setSessionLoading(true);
    getSession(sessionId)
      .then((s) => {
        if (!cancelled) {
          setSession(s);
          setSessionLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSessionLoadError(
          error instanceof Error ? error.message : "Could not load this session.",
        );
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, getSession]);

  // Elapsed class timer (starts on first mount of this live session).
  useEffect(() => {
    if (startRef.current === null) startRef.current = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const {
    connectionStatus,
    pipelineStatus,
    transcripts,
    translations,
    ttsAudio,
    lastError,
    completed,
    sendAudioChunk,
    endSession: endSessionWs,
    reconnect,
  } = useClassroomSocket({ sessionId, enabled: Boolean(sessionId) });

  const handleSegment = useCallback(
    (segment: { base64: string; mimeType: "audio/webm"; sequenceNo: number }) => {
      sendAudioChunk({
        audio: segment.base64,
        mimeType: segment.mimeType,
        sequenceNo: segment.sequenceNo,
      });
    },
    [sendAudioChunk],
  );

  const {
    status: recorderStatus,
    isRecording,
    isSupported,
    error: recorderError,
    start,
    stop,
  } = useMicrophoneRecorder({ mode, onSegment: handleSegment, onStream: setMicStream });

  // VU ring fed by a single rAF loop writing --level on the mic element (no re-render).
  useMicLevel(micStream, micRef, isRecording);

  const handleModeChange = useCallback(
    (next: RecordingMode) => {
      if (next === mode) return;
      stop();
      setMode(next);
    },
    [mode, stop],
  );

  const pttDownRef = useRef(false);
  const handlePttDown = useCallback(() => {
    if (pttDownRef.current || isRecording) return;
    pttDownRef.current = true;
    void start();
  }, [isRecording, start]);
  const handlePttUp = useCallback(() => {
    if (!pttDownRef.current) return;
    pttDownRef.current = false;
    stop();
  }, [stop]);

  const navigatedRef = useRef(false);
  useEffect(() => {
    if (completed && !navigatedRef.current) {
      navigatedRef.current = true;
      stop();
      router.push(`/classroom/${encodeURIComponent(sessionId)}/result`);
    }
  }, [completed, router, sessionId, stop]);

  const handleEnd = useCallback(() => {
    setEnding(true);
    stop();
    // Finalize runs in the background on the server (a goroutine). Don't make the
    // teacher wait on a "wrapping up" spinner — fire the end request and go
    // straight to the results page, which auto-refreshes until artifacts land.
    endSessionWs();
    void endSessionRest(sessionId).catch(() => {});
    navigatedRef.current = true;
    router.push(`/classroom/${encodeURIComponent(sessionId)}/result`);
  }, [endSessionRest, endSessionWs, sessionId, stop, router]);

  // Two-tap confirm so a teacher never ends class by accident mid-lesson.
  const handleEndTap = useCallback(() => {
    if (ending || pipelineStatus === "completed") return;
    if (endArmed) {
      if (endTimerRef.current) clearTimeout(endTimerRef.current);
      setEndArmed(false);
      void handleEnd();
    } else {
      setEndArmed(true);
      endTimerRef.current = setTimeout(() => setEndArmed(false), 3000);
    }
  }, [ending, pipelineStatus, endArmed, handleEnd]);

  const disconnected =
    connectionStatus === "closed" || connectionStatus === "reconnecting";
  const controlsDisabled =
    ending || pipelineStatus === "processing" || pipelineStatus === "completed";
  const micDisabled =
    !isSupported || controlsDisabled || recorderStatus === "requesting";

  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(
    elapsed % 60,
  ).padStart(2, "0")}`;

  const micLabel =
    mode === "live"
      ? isRecording
        ? "TAP TO PAUSE"
        : recorderStatus === "requesting"
          ? "REQUESTING…"
          : "TAP TO SPEAK"
      : isRecording
        ? "RELEASE TO SEND"
        : "HOLD TO TALK";
  const micLabelTh =
    mode === "live"
      ? isRecording
        ? "แตะเพื่อหยุด"
        : "แตะเพื่อพูด"
      : "กดค้างเพื่อพูด";

  const micHandlers =
    mode === "live"
      ? {
          onClick: () => {
            if (micDisabled) return;
            if (isRecording) stop();
            else void start();
          },
        }
      : {
          onPointerDown: handlePttDown,
          onPointerUp: handlePttUp,
          onPointerLeave: handlePttUp,
          onPointerCancel: handlePttUp,
          onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              if (!e.repeat) handlePttDown();
            }
          },
          onKeyUp: (e: React.KeyboardEvent) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              handlePttUp();
            }
          },
        };

  return (
    <main className="flex h-[100svh] flex-col overflow-hidden bg-canvas">
      {/* Top connection bar — peripheral state cue. */}
      <div
        className={`h-1.5 w-full shrink-0 ${CONN_BAR[connectionStatus]}`}
        role="status"
        aria-label={`Connection ${connectionStatus}`}
      />

      {/* Sign-bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b-[3px] border-seam px-3 md:h-16 md:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Link
            href="/classroom"
            aria-label="All sessions"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-none text-ink ring-1 ring-line transition hover:bg-canvas-soft"
          >
            <span aria-hidden="true" className="text-lg">←</span>
          </Link>
          {sessionLoading ? (
            <div className="h-6 w-40 animate-pulse rounded-none bg-line" />
          ) : (
            <h1 className="truncate font-display text-[clamp(0.95rem,4.5vw,1.5rem)] font-black uppercase tracking-tight text-ink">
              {session?.classroomName ?? "Live classroom"}
            </h1>
          )}
        </div>

        <div className="hidden shrink-0 font-display text-2xl font-black tabular-nums text-ink md:block landscape:text-[clamp(1.5rem,3.5vw,2.75rem)]">
          {clock}
        </div>

        <div className="flex shrink-0 items-center gap-2 md:gap-3">
          <SessionStatus pipelineStatus={pipelineStatus} />
          <button
            type="button"
            onClick={handleEndTap}
            disabled={ending || pipelineStatus === "completed"}
            className={`min-h-[44px] rounded-none px-3 font-display text-xs font-extrabold uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50 md:px-5 md:text-sm ${
              endArmed
                ? "bg-[#9a2b1c] text-canvas"
                : "text-[#9a2b1c] ring-2 ring-[#9a2b1c] hover:bg-[#9a2b1c]/10"
            }`}
          >
            {ending ? "ENDING…" : endArmed ? "TAP AGAIN" : "END CLASS"}
          </button>
        </div>
      </header>

      {/* Full-bleed notice strips */}
      <div aria-live="polite" className="shrink-0 empty:hidden">
        {sessionLoadError && (
          <p role="alert" className="w-full bg-[#b3251f] px-4 py-2 text-sm font-medium text-canvas">
            {sessionLoadError}
          </p>
        )}
        {!isSupported && (
          <p role="alert" className="w-full bg-[#c98a18] px-4 py-2 text-sm font-medium text-canvas">
            Microphone recording is not supported here. Use a recent Chrome, Edge,
            or Firefox over HTTPS or localhost.
          </p>
        )}
        {recorderStatus === "denied" && (
          <p role="alert" className="w-full bg-[#b3251f] px-4 py-2 text-sm font-medium text-canvas">
            Microphone access denied. Enable mic permission for this site, then tap
            the mic again.
          </p>
        )}
        {recorderError && recorderStatus !== "denied" && (
          <p role="alert" className="w-full bg-[#b3251f] px-4 py-2 text-sm font-medium text-canvas">
            {recorderError}
          </p>
        )}
        {disconnected && (
          <div className="flex w-full flex-wrap items-center justify-between gap-2 bg-[#c98a18] px-4 py-2 text-sm font-medium text-canvas">
            <span>
              {connectionStatus === "reconnecting"
                ? "Reconnecting to the classroom server…"
                : "Disconnected from the classroom server."}
            </span>
            {connectionStatus === "closed" && (
              <button
                type="button"
                onClick={reconnect}
                className="min-h-[36px] rounded-none bg-ink px-3 font-display text-xs font-extrabold uppercase tracking-wide text-canvas"
              >
                Reconnect
              </button>
            )}
          </div>
        )}
        {lastError && lastError.code === "TTS_FAILED" && (
          <p className="w-full bg-canvas-soft px-4 py-2 text-sm text-ink-soft">
            English audio could not be generated for the latest line — the
            translation was still delivered.
          </p>
        )}
        {lastError && lastError.code !== "TTS_FAILED" && (
          <p role="alert" className="w-full bg-[#b3251f] px-4 py-2 text-sm font-medium text-canvas">
            {lastError.message}
          </p>
        )}
      </div>

      {/* Language board */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="grid h-full grid-rows-2 landscape:grid-cols-2 landscape:grid-rows-1">
          <div className="relative min-h-0 overflow-hidden border-b-[3px] border-seam landscape:border-b-0 landscape:border-r-[3px]">
            <LiveThaiTranscript lines={transcripts} />
          </div>
          <div className="relative min-h-0 overflow-hidden">
            <EnglishTranslationPanel lines={translations} />
          </div>
        </div>

        {/* Mic cluster — overlaid bottom-center, straddling the seam. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="pointer-events-auto w-full max-w-md">
            <EnglishAudioPlayer latest={ttsAudio} />
          </div>

          <div className="pointer-events-auto flex items-center gap-2">
            <div
              className="inline-flex rounded-none bg-surface ring-1 ring-line"
              role="group"
              aria-label="Microphone mode"
            >
              {(
                [
                  { value: "live", label: "LIVE" },
                  { value: "ptt", label: "HOLD" },
                ] as const
              ).map((opt) => {
                const active = mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleModeChange(opt.value)}
                    disabled={controlsDisabled}
                    aria-pressed={active}
                    className={`min-h-[36px] rounded-none px-3 font-display text-xs font-extrabold uppercase tracking-wide transition disabled:opacity-50 ${
                      active ? "bg-ink text-canvas" : "text-ink-soft hover:text-ink"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <span className="font-display text-lg font-black tabular-nums text-ink md:hidden">
              {clock}
            </span>
          </div>

          <div className="pointer-events-auto flex flex-col items-center gap-1.5">
            <div className="relative">
              {isRecording && (
                <span
                  className="absolute inset-0 rounded-full bg-brand-400 animate-mic-ring"
                  aria-hidden="true"
                />
              )}
              <button
                ref={micRef}
                type="button"
                {...micHandlers}
                disabled={micDisabled}
                aria-pressed={isRecording}
                aria-label={micLabel}
                className={`relative grid h-[88px] w-[88px] touch-none select-none place-items-center rounded-full text-canvas shadow-lg transition disabled:cursor-not-allowed disabled:opacity-50 md:h-28 md:w-28 landscape:h-32 landscape:w-32 ${
                  isRecording ? "mic-vu bg-brand-600" : "bg-ink hover:bg-brand-700"
                }`}
              >
                {isRecording ? (
                  <span className="h-7 w-7 rounded-[3px] bg-canvas md:h-9 md:w-9" aria-hidden="true" />
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    className="h-9 w-9 md:h-11 md:w-11"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden="true"
                  >
                    <rect x="9" y="3" width="6" height="11" rx="3" />
                    <path strokeLinecap="round" d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                  </svg>
                )}
              </button>
            </div>
            <span className="font-display text-xs font-extrabold uppercase tracking-wide text-ink">
              {micLabel}
            </span>
            <span lang="th" className="font-thai text-[0.7rem] text-ink-soft">
              {micLabelTh}
            </span>
          </div>
        </div>
      </div>
    </main>
  );
}
