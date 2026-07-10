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
import { useRealtimeTranslation } from "@/hooks/useRealtimeTranslation";
import { api } from "@/lib/api";
import { runEndClassFlow } from "@/lib/endClassFlow";
import type {
  ClassroomSession,
  ConnectionStatus,
  PipelineStatus,
  RecordingMode,
  TtsSpeechSpeed,
  TtsVoiceProfile,
} from "@/lib/types";

const CONN_BAR: Record<ConnectionStatus, string> = {
  open: "bg-live",
  connecting: "bg-reconnect",
  reconnecting: "bg-reconnect",
  closed: "bg-lost animate-seam-blink",
};

const VOICE_OPTIONS: ReadonlyArray<{ value: TtsVoiceProfile; label: string }> = [
  { value: "child_girl", label: "Girl" },
  { value: "child_boy", label: "Boy" },
  { value: "adult_woman", label: "Woman" },
  { value: "adult_man", label: "Man" },
];

const SPEECH_SPEED_OPTIONS: ReadonlyArray<{ value: TtsSpeechSpeed; label: string }> = [
  { value: "slow", label: "Slow" },
  { value: "medium", label: "Med" },
  { value: "fast", label: "Fast" },
];

export default function LiveSessionPage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const sessionId = params?.sessionId ?? "";

  const { getSession, resetSession } = useClassroomSession();

  const [session, setSession] = useState<ClassroomSession | null>(null);
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [mode, setMode] = useState<RecordingMode>("ptt");
  const [voiceProfile, setVoiceProfile] =
    useState<TtsVoiceProfile>("child_girl");
  const [speechSpeed, setSpeechSpeed] = useState<TtsSpeechSpeed>("slow");
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [resetError, setResetError] = useState<string | null>(null);

  const micRef = useRef<HTMLButtonElement | null>(null);
  const endButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelEndRef = useRef<HTMLButtonElement | null>(null);
  const confirmEndRef = useRef<HTMLButtonElement | null>(null);
  const startRef = useRef<number | null>(null);
  const endingRef = useRef(false);

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

  // A non-active session has nothing to stream — revisiting one from the list
  // must NOT open a live WebSocket (that surfaced "Realtime connection error").
  // Send it straight to its results instead.
  const sessionActive = session?.status === "active";
  useEffect(() => {
    if (session && session.status !== "active") {
      router.replace(`/classroom/${encodeURIComponent(sessionId)}/result`);
    }
  }, [session, router, sessionId]);

  // Elapsed class timer (starts on first mount of this live session).
  useEffect(() => {
    if (startRef.current === null) startRef.current = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const {
    connectionStatus: backendConnectionStatus,
    pipelineStatus: backendPipelineStatus,
    ttsAudio,
    lastError,
    queueTranslationCommit,
    waitForCommitDrain,
    reconnect: reconnectBackend,
  } = useClassroomSocket({ sessionId, enabled: Boolean(sessionId) && sessionActive });

  const {
    connectionStatus: realtimeConnectionStatus,
    captureStatus,
    pipelineStatus: realtimePipelineStatus,
    transcripts,
    translations,
    micStream,
    isTransmitting,
    isSupported,
    error: realtimeError,
    resume,
    pause,
    reconnect: reconnectRealtime,
    closeAndDrain,
    clearLines,
  } = useRealtimeTranslation({
    sessionId,
    enabled: Boolean(sessionId) && sessionActive,
    voiceProfile,
    speechSpeed,
    onPhraseCommit: queueTranslationCommit,
  });

  // VU ring fed by a single rAF loop writing --level on the mic element (no re-render).
  useMicLevel(micStream, micRef, isTransmitting);

  const handleModeChange = useCallback(
    (next: RecordingMode) => {
      if (next === mode) return;
      pause();
      setMode(next);
    },
    [mode, pause],
  );

  const pttDownRef = useRef(false);
  const handlePttDown = useCallback(() => {
    if (pttDownRef.current) return;
    pttDownRef.current = true;
    void resume();
  }, [resume]);
  const handlePttUp = useCallback(() => {
    if (!pttDownRef.current) return;
    pttDownRef.current = false;
    pause();
  }, [pause]);

  const navigatedRef = useRef(false);
  const handleEnd = useCallback(async () => {
    if (endingRef.current || navigatedRef.current) return;
    endingRef.current = true;
    setEnding(true);
    setEndError(null);
    setEndConfirmOpen(false);
    pttDownRef.current = false;

    try {
      await runEndClassFlow({
        closeRealtime: closeAndDrain,
        waitForCommitDrain,
        endSession: () => api.endSession(sessionId),
        navigate: () => {
          navigatedRef.current = true;
          router.push(`/classroom/${encodeURIComponent(sessionId)}/result`);
        },
      });
    } catch (cause) {
      setEndError(
        cause instanceof Error
          ? cause.message
          : "Could not end the class. Please try again.",
      );
      setEnding(false);
      endingRef.current = false;
    }
  }, [closeAndDrain, router, sessionId, waitForCommitDrain]);

  // Reset: discard what's been said so far (screen + recorded messages +
  // glossary) and start the take over, without ending the class.
  const handleReset = useCallback(async () => {
    if (resetting || ending) return;
    const resumeLiveAfterReset = mode === "live" && isTransmitting;
    setResetting(true);
    setResetError(null);
    pause();
    try {
      await closeAndDrain(30_000);
      const commitsDrained = await waitForCommitDrain(30_000);
      if (!commitsDrained) {
        throw new Error("Could not finish saving the current phrase before reset.");
      }
      await resetSession(sessionId);
      clearLines();
      if (resumeLiveAfterReset) void resume();
    } catch (cause) {
      setResetError(
        cause instanceof Error
          ? cause.message
          : "Could not reset this classroom. Please try again.",
      );
    } finally {
      setResetting(false);
    }
  }, [
    clearLines,
    closeAndDrain,
    ending,
    isTransmitting,
    mode,
    pause,
    resetSession,
    resetting,
    resume,
    sessionId,
    waitForCommitDrain,
  ]);

  const handleEndTap = useCallback(() => {
    if (ending || backendPipelineStatus === "completed") return;
    setEndConfirmOpen(true);
  }, [backendPipelineStatus, ending]);

  const handleCancelEnd = useCallback(() => {
    if (ending) return;
    setEndConfirmOpen(false);
    requestAnimationFrame(() => endButtonRef.current?.focus());
  }, [ending]);

  const handleConfirmEnd = useCallback(() => {
    if (ending || backendPipelineStatus === "completed") return;
    void handleEnd();
  }, [backendPipelineStatus, ending, handleEnd]);

  useEffect(() => {
    if (!endConfirmOpen) return;
    cancelEndRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleCancelEnd();
        return;
      }
      if (event.key === "Tab") {
        const cancel = cancelEndRef.current;
        const confirm = confirmEndRef.current;
        if (!cancel || !confirm) return;
        if (event.shiftKey && document.activeElement === cancel) {
          event.preventDefault();
          confirm.focus();
        } else if (!event.shiftKey && document.activeElement === confirm) {
          event.preventDefault();
          cancel.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [endConfirmOpen, handleCancelEnd]);

  const connectionStatus: ConnectionStatus =
    backendConnectionStatus !== "open"
      ? backendConnectionStatus
      : realtimeConnectionStatus === "connecting"
        ? "connecting"
        : realtimeConnectionStatus === "error" ||
            (realtimeConnectionStatus === "closed" && !ending)
          ? "closed"
          : "open";
  const pipelineStatus: PipelineStatus =
    backendPipelineStatus === "completed"
      ? "completed"
      : ending || realtimePipelineStatus === "processing"
        ? "processing"
        : realtimePipelineStatus === "error" || backendPipelineStatus === "error"
          ? "error"
          : realtimePipelineStatus !== "idle"
            ? realtimePipelineStatus
            : backendPipelineStatus === "speaking"
              ? "speaking"
              : "idle";
  const backendDisconnected =
    backendConnectionStatus === "closed" ||
    backendConnectionStatus === "reconnecting";
  const disconnected =
    backendDisconnected ||
    realtimeConnectionStatus === "closed" ||
    realtimeConnectionStatus === "error";
  const controlsDisabled =
    ending || pipelineStatus === "processing" || pipelineStatus === "completed";
  const micDisabled =
    !isSupported ||
    controlsDisabled ||
    captureStatus === "requesting" ||
    captureStatus === "closing";

  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(
    elapsed % 60,
  ).padStart(2, "0")}`;

  const micLabel = isTransmitting
    ? mode === "ptt"
      ? "RELEASE TO PAUSE"
      : "PAUSE LIVE"
    : captureStatus === "closing"
      ? "FINISHING…"
      : captureStatus === "requesting" || realtimeConnectionStatus === "connecting"
        ? "CONNECTING…"
        : mode === "live"
          ? realtimeConnectionStatus === "open"
            ? "RESUME LIVE"
            : "START LIVE"
          : "HOLD TO TALK";
  const micLabelTh = isTransmitting
    ? mode === "ptt"
      ? "ปล่อยเพื่อพักไมค์"
      : "พักไมค์"
    : captureStatus === "closing"
      ? "กำลังปิดคำแปล…"
      : captureStatus === "requesting" || realtimeConnectionStatus === "connecting"
        ? "กำลังเชื่อมต่อ…"
      : mode === "live"
        ? "แตะเพื่อเริ่มหรือพูดต่อ"
        : "กดค้างเพื่อพูด";
  const micAriaLabel =
    mode === "ptt"
      ? isTransmitting
        ? "Release to pause microphone"
        : "Hold to speak; release to pause"
      : isTransmitting
        ? "Pause live microphone"
        : "Resume live microphone";

  const micHandlers =
    mode === "live"
      ? {
          onClick: () => {
            if (micDisabled) return;
            if (isTransmitting) pause();
            else void resume();
          },
        }
      : {
          onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
            if (micDisabled) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            handlePttDown();
          },
          onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            handlePttUp();
          },
          onPointerCancel: handlePttUp,
          onLostPointerCapture: handlePttUp,
          onBlur: handlePttUp,
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
            ref={endButtonRef}
            type="button"
            onClick={handleEndTap}
            disabled={ending || pipelineStatus === "completed"}
            className="min-h-[44px] rounded-none px-3 font-display text-xs font-extrabold uppercase tracking-wide text-[#9a2b1c] ring-2 ring-[#9a2b1c] transition hover:bg-[#9a2b1c]/10 disabled:cursor-not-allowed disabled:opacity-50 md:px-5 md:text-sm"
          >
            {ending ? "ENDING…" : "END CLASS"}
          </button>
        </div>
      </header>

      {endConfirmOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-ink/55 px-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) handleCancelEnd();
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="end-class-title"
            aria-describedby="end-class-description"
            className="w-full max-w-sm rounded-none bg-surface p-6 text-center shadow-2xl ring-2 ring-ink"
          >
            <p
              id="end-class-title"
              lang="th"
              className="font-thai text-xl font-bold text-ink"
            >
              ต้องการปิดใช่หรือไม่
            </p>
            <p
              id="end-class-description"
              lang="th"
              className="mt-2 font-thai text-sm leading-relaxed text-ink-soft"
            >
              ระบบจะหยุดรับเสียงและเริ่มประมวลผลสรุป คำศัพท์ และแฟลชการ์ด
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                ref={cancelEndRef}
                type="button"
                onClick={handleCancelEnd}
                disabled={ending}
                className="min-h-[48px] rounded-none bg-canvas px-4 font-thai text-base font-bold text-ink ring-1 ring-ink transition hover:bg-canvas-soft disabled:cursor-not-allowed disabled:opacity-60"
              >
                ยกเลิก
              </button>
              <button
                ref={confirmEndRef}
                type="button"
                onClick={handleConfirmEnd}
                disabled={ending}
                className="min-h-[48px] rounded-none bg-[#9a2b1c] px-4 font-thai text-base font-bold text-canvas transition hover:bg-[#7f2418] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {ending ? "กำลังปิด…" : "ปิดคาบเรียน"}
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Full-bleed notice strips */}
      <div aria-live="polite" className="shrink-0 empty:hidden">
        {sessionLoadError && (
          <p role="alert" className="w-full bg-[#b3251f] px-4 py-2 text-sm font-medium text-canvas">
            {sessionLoadError}
          </p>
        )}
        {endError && (
          <div className="flex w-full flex-wrap items-center justify-between gap-2 bg-[#b3251f] px-4 py-2 text-sm font-medium text-canvas">
            <span role="alert">
              {endError}{" "}
              <span lang="th" className="font-thai">
                ยังไม่ปิดคาบเรียน กรุณาลองอีกครั้ง
              </span>
            </span>
            <button
              type="button"
              onClick={() => void handleEnd()}
              className="min-h-[36px] rounded-none bg-ink px-3 font-display text-xs font-extrabold uppercase tracking-wide text-canvas"
            >
              Retry end
            </button>
          </div>
        )}
        {resetError && (
          <p role="alert" className="w-full bg-[#b3251f] px-4 py-2 text-sm font-medium text-canvas">
            {resetError}
          </p>
        )}
        {!isSupported && (
          <p role="alert" className="w-full bg-[#c98a18] px-4 py-2 text-sm font-medium text-canvas">
            Live microphone translation is not supported here. Use a recent Chrome,
            Edge, or Safari over HTTPS or localhost.
          </p>
        )}
        {captureStatus === "denied" && (
          <p role="alert" className="w-full bg-[#b3251f] px-4 py-2 text-sm font-medium text-canvas">
            Microphone access denied. Enable mic permission for this site, then tap
            the mic again.
          </p>
        )}
        {realtimeError && captureStatus !== "denied" && (
          <p role="alert" className="w-full bg-[#b3251f] px-4 py-2 text-sm font-medium text-canvas">
            {realtimeError.message}
          </p>
        )}
        {disconnected && (
          <div className="flex w-full flex-wrap items-center justify-between gap-2 bg-[#c98a18] px-4 py-2 text-sm font-medium text-canvas">
            <span>
              {backendConnectionStatus === "reconnecting"
                ? "Reconnecting classroom saving and English audio…"
                : backendDisconnected
                  ? "Classroom saving and English audio are disconnected."
                  : "Live translation is disconnected."}
            </span>
            <button
              type="button"
              onClick={() => {
                if (backendDisconnected) reconnectBackend();
                if (
                  realtimeConnectionStatus === "closed" ||
                  realtimeConnectionStatus === "error"
                ) {
                  void reconnectRealtime();
                }
              }}
              className="min-h-[36px] rounded-none bg-ink px-3 font-display text-xs font-extrabold uppercase tracking-wide text-canvas"
            >
              Reconnect
            </button>
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

          <div className="pointer-events-auto flex max-w-[min(100%,44rem)] flex-wrap items-center justify-center gap-2 rounded-none bg-surface px-3 py-2 ring-1 ring-line">
            <div
              className="inline-flex overflow-hidden rounded-none ring-1 ring-line"
              role="group"
              aria-label="English voice profile"
            >
              {VOICE_OPTIONS.map((opt) => {
                const active = voiceProfile === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setVoiceProfile(opt.value)}
                    disabled={controlsDisabled}
                    aria-pressed={active}
                    className={`min-h-[34px] rounded-none px-2.5 font-display text-[0.68rem] font-extrabold uppercase tracking-wide transition disabled:opacity-50 md:px-3 md:text-xs ${
                      active ? "bg-ink text-canvas" : "text-ink-soft hover:bg-canvas-soft hover:text-ink"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <div
              className="inline-flex overflow-hidden rounded-none ring-1 ring-line"
              role="group"
              aria-label="English speech speed"
            >
              {SPEECH_SPEED_OPTIONS.map((opt) => {
                const active = speechSpeed === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSpeechSpeed(opt.value)}
                    disabled={controlsDisabled}
                    aria-pressed={active}
                    className={`min-h-[34px] rounded-none px-2.5 font-display text-[0.68rem] font-extrabold uppercase tracking-wide transition disabled:opacity-50 md:px-3 md:text-xs ${
                      active ? "bg-clay-600 text-canvas" : "text-ink-soft hover:bg-canvas-soft hover:text-ink"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
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

            {/* Reset: wipe the current take (screen + recorded lines) to redo. */}
            <button
              type="button"
              onClick={() => void handleReset()}
              disabled={resetting || controlsDisabled}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-none bg-surface px-3 font-display text-xs font-extrabold uppercase tracking-wide text-ink ring-1 ring-ink transition hover:bg-canvas-soft disabled:cursor-not-allowed disabled:opacity-50"
              title="Clear what's been said and start over"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4" />
              </svg>
              {resetting ? "Resetting…" : "Reset"}
            </button>
          </div>

          <div className="pointer-events-auto flex flex-col items-center gap-1.5">
            <div className="relative">
              {isTransmitting && (
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
                aria-pressed={isTransmitting}
                aria-label={micAriaLabel}
                className={`relative grid h-[88px] w-[88px] touch-none select-none place-items-center rounded-full text-canvas shadow-lg transition disabled:cursor-not-allowed disabled:opacity-50 md:h-28 md:w-28 landscape:h-32 landscape:w-32 ${
                  isTransmitting ? "mic-vu bg-brand-600" : "bg-ink hover:bg-brand-700"
                }`}
              >
                {isTransmitting ? (
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
