"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import {
  automaticPhraseCommitEnabled,
  HOLD_RELEASE_HARD_CAP_MS,
  holdQuiescenceSchedule,
  holdResumeDecision,
  planHoldRelease,
} from "@/lib/holdReleasePolicy";
import { isConnectionAttemptCurrent } from "@/lib/realtimeConnection";
import {
  abortRealtimePhraseCall,
  beginRealtimePhraseClose,
  consumeClosedPhraseCommit,
  createRealtimePhraseLifecycle,
  markRealtimePhraseCommitAcknowledged,
  markRealtimePhraseClosed,
  shouldSchedulePhraseTimer,
  startRealtimePhraseCall,
} from "@/lib/realtimePhraseLifecycle";
import {
  DEFAULT_PHRASE_MAX_WINDOW_MS,
  appendTranscriptDelta,
  normalizeCommittedText,
  takeAlignedTranscriptPhrase,
  takeCompletedTranscriptPhrase,
  takeReleasedTranscriptPhrase,
  takeSettledTranscriptPhrase,
} from "@/lib/translationPhrase";
import type { TimedTranscriptDelta } from "@/lib/translationPhrase";
import type {
  PipelineStatus,
  RecordingMode,
  RealtimeCaptureStatus,
  RealtimeConnectionStatus,
  RealtimeErrorEvent,
  RealtimeServerEvent,
  RealtimeTranscriptDeltaEvent,
  TranscriptLine,
  TranslationCommitPayload,
  TtsSpeechSpeed,
  TtsVoiceProfile,
} from "@/lib/types";

const OPENAI_TRANSLATION_CALLS_URL =
  "https://api.openai.com/v1/realtime/translations/calls";
const DATA_CHANNEL_OPEN_TIMEOUT_MS = 15_000;
const NATURAL_PHRASE_QUIET_MS = 1_200;
const PAUSE_CLOSE_TIMEOUT_MS = 10_000;
const PHRASE_COMMIT_TIMEOUT_MS = 30_000;

type PhraseCommitTrigger = "window" | "quiet" | "release" | "pause" | "final";

interface HoldQuiescenceBarrier {
  deadlineAt: number;
  lastDeltaAt: number;
  releasedAt: number;
  quietTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
}

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  channelCount: 1,
};

export interface RealtimeTranslationError {
  code: string;
  message: string;
}

interface UseRealtimeTranslationOptions {
  sessionId: string;
  enabled: boolean;
  recordingMode: RecordingMode;
  voiceProfile: TtsVoiceProfile;
  speechSpeed: TtsSpeechSpeed;
  onPhraseCommit: (
    payload: Omit<TranslationCommitPayload, "sessionId">,
  ) => void;
  waitForSaveDrain: (timeoutMs: number) => Promise<boolean>;
}

interface UseRealtimeTranslationResult {
  connectionStatus: RealtimeConnectionStatus;
  captureStatus: RealtimeCaptureStatus;
  pipelineStatus: PipelineStatus;
  transcripts: TranscriptLine[];
  isReviewingTranslation: boolean;
  isFinalizingPhrase: boolean;
  micStream: MediaStream | null;
  isTransmitting: boolean;
  isSupported: boolean;
  error: RealtimeTranslationError | null;
  resume: () => Promise<void>;
  releasePushToTalk: () => Promise<void>;
  pause: () => Promise<void>;
  reconnect: () => Promise<void>;
  closeAndDrain: (timeoutMs?: number) => Promise<void>;
  flushPhrase: () => boolean;
  clearLines: () => void;
}

function browserSupportsRealtime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof RTCPeerConnection !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

function waitForDataChannelOpen(
  channel: RTCDataChannel,
  timeoutMs: number,
): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      detach();
      reject(new Error("The realtime event channel did not open in time."));
    }, timeoutMs);
    const onOpen = () => {
      detach();
      resolve();
    };
    const onClose = () => {
      detach();
      reject(new Error("The realtime event channel closed while connecting."));
    };
    const detach = () => {
      window.clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
    };
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
  });
}

function errorDetails(cause: unknown): RealtimeTranslationError {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "NotAllowedError"
  ) {
    return {
      code: "MIC_PERMISSION_DENIED",
      message:
        "Microphone access denied. Enable mic permission for this site, then try again.",
    };
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "NotReadableError"
  ) {
    return {
      code: "MIC_UNAVAILABLE",
      message:
        "The microphone is being used by another application. Close it and try again.",
    };
  }
  return {
    code: "REALTIME_CONNECTION_FAILED",
    message:
      cause instanceof Error
        ? cause.message
        : "Could not connect to live translation. Please try again.",
  };
}

export function useRealtimeTranslation(
  options: UseRealtimeTranslationOptions,
): UseRealtimeTranslationResult {
  const {
    sessionId,
    enabled,
    recordingMode,
    voiceProfile,
    speechSpeed,
    onPhraseCommit,
    waitForSaveDrain,
  } = options;

  const [connectionStatus, setConnectionStatus] =
    useState<RealtimeConnectionStatus>("idle");
  const [captureStatus, setCaptureStatus] =
    useState<RealtimeCaptureStatus>("idle");
  const [pipelineStatus, setPipelineStatus] =
    useState<PipelineStatus>("idle");
  const [committedTranscripts, setCommittedTranscripts] = useState<
    TranscriptLine[]
  >([]);
  const [sourceDraft, setSourceDraft] = useState("");
  const [hasOutputDraft, setHasOutputDraft] = useState(false);
  const [isFinalizingPhrase, setIsFinalizingPhrase] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  const [error, setError] = useState<RealtimeTranslationError | null>(null);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  const connectionGenerationRef = useRef(0);
  const closePromiseRef = useRef<Promise<void> | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const sourceDraftRef = useRef("");
  const outputDraftRef = useRef("");
  const sourceDeltasRef = useRef<TimedTranscriptDelta[]>([]);
  const outputDeltasRef = useRef<TimedTranscriptDelta[]>([]);
  const sequenceRef = useRef(0);
  const translationSessionIdRef = useRef("");
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxWindowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phraseStartedAtRef = useRef<number | null>(null);
  const pausePromiseRef = useRef<Promise<void> | null>(null);
  const releasePromiseRef = useRef<Promise<void> | null>(null);
  const phraseLifecycleRef = useRef(createRealtimePhraseLifecycle());
  const desiredActiveRef = useRef(false);
  const holdCaptureActiveRef = useRef(false);
  const holdInactiveRef = useRef(false);
  const holdConnectionDirtyRef = useRef(false);
  const holdReleaseDeadlineRef = useRef<number | null>(null);
  const holdQuiescenceRef = useRef<HoldQuiescenceBarrier | null>(null);
  const closingRef = useRef(false);
  const sessionClosedRef = useRef(false);
  const everConnectedRef = useRef(false);
  const sessionClosedResolverRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const onPhraseCommitRef = useRef(onPhraseCommit);
  const waitForSaveDrainRef = useRef(waitForSaveDrain);
  const recordingModeRef = useRef(recordingMode);
  const voiceProfileRef = useRef(voiceProfile);
  const speechSpeedRef = useRef(speechSpeed);

  useEffect(() => {
    onPhraseCommitRef.current = onPhraseCommit;
  }, [onPhraseCommit]);
  useEffect(() => {
    waitForSaveDrainRef.current = waitForSaveDrain;
  }, [waitForSaveDrain]);
  useEffect(() => {
    recordingModeRef.current = recordingMode;
  }, [recordingMode]);
  useEffect(() => {
    voiceProfileRef.current = voiceProfile;
  }, [voiceProfile]);
  useEffect(() => {
    speechSpeedRef.current = speechSpeed;
  }, [speechSpeed]);

  const clearDebounceTimer = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const clearMaxWindowTimer = useCallback(() => {
    if (maxWindowTimerRef.current !== null) {
      clearTimeout(maxWindowTimerRef.current);
      maxWindowTimerRef.current = null;
    }
    phraseStartedAtRef.current = null;
  }, []);

  const clearPhraseTimers = useCallback(() => {
    clearDebounceTimer();
    clearMaxWindowTimer();
  }, [clearDebounceTimer, clearMaxWindowTimer]);

  const finishHoldQuiescence = useCallback(
    (barrier: HoldQuiescenceBarrier, markDirty: boolean) => {
      if (barrier.settled) return;
      barrier.settled = true;
      if (barrier.quietTimer !== null) clearTimeout(barrier.quietTimer);
      if (barrier.hardTimer !== null) clearTimeout(barrier.hardTimer);
      if (markDirty) holdConnectionDirtyRef.current = true;
      if (holdQuiescenceRef.current === barrier) {
        holdQuiescenceRef.current = null;
      }
      barrier.resolve();
    },
    [],
  );

  const startHoldQuiescence = useCallback((): Promise<void> => {
    const now = Date.now();
    const deadlineAt =
      holdReleaseDeadlineRef.current ?? now + HOLD_RELEASE_HARD_CAP_MS;
    holdReleaseDeadlineRef.current = deadlineAt;
    const releasedAt = deadlineAt - HOLD_RELEASE_HARD_CAP_MS;
    const schedule = holdQuiescenceSchedule({
      releasedAt,
      lastDeltaAt: now,
      now,
    });

    if (schedule.dirtyNow) {
      holdConnectionDirtyRef.current = true;
      return Promise.resolve();
    }

    let resolveBarrier = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });
    const barrier: HoldQuiescenceBarrier = {
      deadlineAt,
      lastDeltaAt: now,
      releasedAt,
      quietTimer: null,
      hardTimer: null,
      promise,
      resolve: resolveBarrier,
      settled: false,
    };
    barrier.hardTimer = setTimeout(() => {
      finishHoldQuiescence(barrier, true);
    }, schedule.hardDelayMs);
    barrier.quietTimer = setTimeout(() => {
      finishHoldQuiescence(barrier, false);
    }, schedule.quietDelayMs);
    holdQuiescenceRef.current = barrier;
    return promise;
  }, [finishHoldQuiescence]);

  const quarantineInactiveHoldDelta = useCallback((): boolean => {
    if (!holdInactiveRef.current) return false;

    const barrier = holdQuiescenceRef.current;
    if (!barrier || barrier.settled) {
      void startHoldQuiescence();
      return true;
    }

    const now = Date.now();
    barrier.lastDeltaAt = now;
    const schedule = holdQuiescenceSchedule({
      releasedAt: barrier.releasedAt,
      lastDeltaAt: barrier.lastDeltaAt,
      now,
    });
    if (schedule.dirtyNow) {
      finishHoldQuiescence(barrier, true);
      return true;
    }
    if (barrier.quietTimer !== null) clearTimeout(barrier.quietTimer);
    barrier.quietTimer = setTimeout(() => {
      finishHoldQuiescence(barrier, false);
    }, schedule.quietDelayMs);
    return true;
  }, [finishHoldQuiescence, startHoldQuiescence]);

  const waitForHoldQuiescence = useCallback(async (): Promise<void> => {
    while (holdQuiescenceRef.current) {
      await holdQuiescenceRef.current.promise;
    }
  }, []);

  const clearHoldReleaseState = useCallback(() => {
    const barrier = holdQuiescenceRef.current;
    if (barrier) finishHoldQuiescence(barrier, false);
    holdReleaseDeadlineRef.current = null;
    holdInactiveRef.current = false;
    holdConnectionDirtyRef.current = false;
  }, [finishHoldQuiescence]);

  const discardCurrentPhrase = useCallback(() => {
    clearPhraseTimers();
    sourceDraftRef.current = "";
    outputDraftRef.current = "";
    sourceDeltasRef.current = [];
    outputDeltasRef.current = [];
    setSourceDraft("");
    setHasOutputDraft(false);
  }, [clearPhraseTimers]);

  const discardIncompletePhrase = useCallback(() => {
    discardCurrentPhrase();
    setError((current) =>
      current?.code === "PHRASE_INCOMPLETE" ? null : current,
    );
    setPipelineStatus((current) =>
      current === "error"
        ? current
        : desiredActiveRef.current
          ? "listening"
          : "idle",
    );
  }, [discardCurrentPhrase]);

  const commitCurrentPhrase = useCallback(
    (trigger: PhraseCommitTrigger = "window"): boolean => {
      const aligned =
        trigger === "quiet"
          ? takeSettledTranscriptPhrase(
              sourceDeltasRef.current,
              outputDeltasRef.current,
            )
          : trigger === "release"
            ? takeReleasedTranscriptPhrase(
                sourceDeltasRef.current,
                outputDeltasRef.current,
              )
          : trigger === "pause" || trigger === "final"
            ? takeCompletedTranscriptPhrase(
                sourceDeltasRef.current,
                outputDeltasRef.current,
              )
          : takeAlignedTranscriptPhrase(
              sourceDeltasRef.current,
              outputDeltasRef.current,
            );
      const sourceText = normalizeCommittedText(aligned.sourceText);
      const translatedText = normalizeCommittedText(aligned.translatedText);

      if (!sourceText && !translatedText) {
        if (
          sourceDeltasRef.current.length === 0 &&
          outputDeltasRef.current.length === 0
        ) {
          clearPhraseTimers();
        } else if (trigger === "window") {
          // Keep the quiet timer armed; it will force-flush after both streams settle.
          clearMaxWindowTimer();
        }
        setPipelineStatus((current) =>
          current === "error"
            ? current
            : desiredActiveRef.current
              ? "listening"
              : "idle",
        );
        return false;
      }
      if (!sourceText || !translatedText || !translationSessionIdRef.current) {
        if (trigger === "window") clearMaxWindowTimer();
        setPipelineStatus((current) =>
          current === "error"
            ? current
            : !sourceText
              ? "transcribing"
              : "translating",
        );
        return false;
      }

      if (trigger === "window") {
        // Preserve the quiet timer so any aligned remainder is finalized at silence.
        clearMaxWindowTimer();
      } else {
        clearPhraseTimers();
      }

      sourceDeltasRef.current = aligned.remainingSource;
      outputDeltasRef.current = aligned.remainingTarget;
      sourceDraftRef.current = aligned.remainingSource
        .map((delta) => delta.text)
        .join("");
      outputDraftRef.current = aligned.remainingTarget
        .map((delta) => delta.text)
        .join("");
      setSourceDraft(sourceDraftRef.current);
      setHasOutputDraft(Boolean(outputDraftRef.current));

      const commitNo = sequenceRef.current + 1;
      sequenceRef.current = commitNo;
      setCommittedTranscripts((previous) => [
        ...previous,
        {
          id: `source-${commitNo}`,
          sequenceNo: commitNo,
          text: sourceText,
          isFinal: true,
        },
      ]);

      onPhraseCommitRef.current({
        translationSessionId: translationSessionIdRef.current,
        commitId: `${translationSessionIdRef.current}:${commitNo}`,
        commitNo,
        commitKind: trigger === "final" ? "final" : "debounced",
        sourceText,
        translatedText,
        sourceElapsedMs: aligned.sourceElapsedMs,
        targetElapsedMs: aligned.targetElapsedMs,
        voiceProfile: voiceProfileRef.current,
        speechSpeed: speechSpeedRef.current,
      });
      setPipelineStatus(desiredActiveRef.current ? "listening" : "idle");
      return true;
    },
    [clearMaxWindowTimer, clearPhraseTimers],
  );

  const schedulePhraseCommit = useCallback(
    () => {
      if (!automaticPhraseCommitEnabled(recordingModeRef.current)) return;
      if (phraseStartedAtRef.current === null) {
        phraseStartedAtRef.current = Date.now();
        maxWindowTimerRef.current = setTimeout(() => {
          if (!automaticPhraseCommitEnabled(recordingModeRef.current)) return;
          commitCurrentPhrase("window");
        }, DEFAULT_PHRASE_MAX_WINDOW_MS);
      }
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        if (!automaticPhraseCommitEnabled(recordingModeRef.current)) return;
        commitCurrentPhrase("quiet");
      }, NATURAL_PHRASE_QUIET_MS);
    },
    [commitCurrentPhrase],
  );

  const handleRealtimeEvent = useCallback(
    (message: MessageEvent<unknown>) => {
      if (typeof message.data !== "string") return;
      let event: RealtimeServerEvent;
      try {
        event = JSON.parse(message.data) as RealtimeServerEvent;
      } catch {
        return;
      }

      if (event.type === "session.input_transcript.delta") {
        const transcriptEvent = event as RealtimeTranscriptDeltaEvent;
        if (typeof transcriptEvent.delta !== "string") return;
        if (quarantineInactiveHoldDelta()) return;
        const elapsedMs = Math.max(0, transcriptEvent.elapsed_ms ?? 0);
        sourceDeltasRef.current.push({
          text: transcriptEvent.delta,
          elapsedMs,
        });
        setError((current) =>
          current?.code === "PHRASE_INCOMPLETE" ? null : current,
        );
        const next = appendTranscriptDelta(
          sourceDraftRef.current,
          transcriptEvent.delta,
        );
        sourceDraftRef.current = next;
        setSourceDraft(next);
        setPipelineStatus("transcribing");
        if (
          outputDraftRef.current &&
          !closingRef.current &&
          automaticPhraseCommitEnabled(recordingModeRef.current) &&
          shouldSchedulePhraseTimer(phraseLifecycleRef.current)
        ) {
          schedulePhraseCommit();
        }
        return;
      }

      if (event.type === "session.output_transcript.delta") {
        const transcriptEvent = event as RealtimeTranscriptDeltaEvent;
        if (typeof transcriptEvent.delta !== "string") return;
        if (quarantineInactiveHoldDelta()) return;
        const elapsedMs = Math.max(0, transcriptEvent.elapsed_ms ?? 0);
        outputDeltasRef.current.push({
          text: transcriptEvent.delta,
          elapsedMs,
        });
        const next = appendTranscriptDelta(
          outputDraftRef.current,
          transcriptEvent.delta,
        );
        outputDraftRef.current = next;
        setHasOutputDraft(true);
        setPipelineStatus("translating");
        if (
          !closingRef.current &&
          automaticPhraseCommitEnabled(recordingModeRef.current) &&
          shouldSchedulePhraseTimer(phraseLifecycleRef.current)
        ) {
          schedulePhraseCommit();
        }
        return;
      }

      if (event.type === "session.closed") {
        sessionClosedRef.current = true;
        phraseLifecycleRef.current = markRealtimePhraseClosed(
          phraseLifecycleRef.current,
        );
        sessionClosedResolverRef.current?.();
        sessionClosedResolverRef.current = null;
        return;
      }

      if (event.type === "error") {
        const errorEvent = event as RealtimeErrorEvent;
        const nextError = {
          code: errorEvent.error?.code ?? "REALTIME_ERROR",
          message:
            errorEvent.error?.message ??
            "Live translation reported an unexpected error.",
        };
        setError(nextError);
        setPipelineStatus("error");
      }
    },
    [quarantineInactiveHoldDelta, schedulePhraseCommit],
  );

  const cleanupPeer = useCallback((stopStream = true) => {
    clearHoldReleaseState();
    phraseLifecycleRef.current = abortRealtimePhraseCall(
      phraseLifecycleRef.current,
    );
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    const channel = channelRef.current;
    channelRef.current = null;
    if (channel) {
      channel.removeEventListener("message", handleRealtimeEvent);
      try {
        channel.close();
      } catch {
        // Ignore shutdown races.
      }
    }
    const peer = peerRef.current;
    peerRef.current = null;
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      try {
        peer.close();
      } catch {
        // Ignore shutdown races.
      }
    }
    if (stopStream) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (mountedRef.current) setMicStream(null);
    }
  }, [clearHoldReleaseState, handleRealtimeEvent]);

  const ensureConnected = useCallback(async (): Promise<void> => {
    const existingChannel = channelRef.current;
    if (existingChannel?.readyState === "open") return;
    if (connectPromiseRef.current) return connectPromiseRef.current;
    if (!enabled || !sessionId) {
      throw new Error("This classroom session is not ready for live translation.");
    }
    if (!browserSupportsRealtime()) {
      setIsSupported(false);
      setCaptureStatus("unsupported");
      throw new Error(
        "Live microphone translation is not supported in this browser.",
      );
    }

    const connectionGeneration = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = connectionGeneration;
    const connectPromise = (async () => {
      cleanupPeer(true);
      closingRef.current = false;
      sessionClosedRef.current = false;
      setIsFinalizingPhrase(false);
      setError(null);
      setConnectionStatus("connecting");
      setCaptureStatus("requesting");

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: AUDIO_CONSTRAINTS,
        });
        if (!isConnectionAttemptCurrent({
          mounted: mountedRef.current,
          closing: closingRef.current,
          currentGeneration: connectionGenerationRef.current,
          attemptGeneration: connectionGeneration,
        })) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const track = stream.getAudioTracks()[0];
        if (!track) {
          stream.getTracks().forEach((streamTrack) => streamTrack.stop());
          throw new Error("No microphone audio track was available.");
        }
        track.enabled = false;
        streamRef.current = stream;
        setMicStream(stream);

        const peer = new RTCPeerConnection();
        peerRef.current = peer;
        peer.addTrack(track, stream);
        // The translation audio track is intentionally never attached to playback.
        peer.ontrack = (remoteEvent) => {
          remoteEvent.track.enabled = false;
        };
        peer.onconnectionstatechange = () => {
          if (peerRef.current !== peer || closingRef.current) return;
          if (
            peer.connectionState === "failed" ||
            peer.connectionState === "disconnected" ||
            peer.connectionState === "closed"
          ) {
            track.enabled = false;
            desiredActiveRef.current = false;
            holdCaptureActiveRef.current = false;
            setConnectionStatus("closed");
            setCaptureStatus("paused");
            setError({
              code: "REALTIME_DISCONNECTED",
              message: "Live translation disconnected. Reconnect to continue.",
            });
          }
        };

        const channel = peer.createDataChannel("oai-events");
        channelRef.current = channel;
        channel.addEventListener("message", handleRealtimeEvent);

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        if (!offer.sdp) throw new Error("Could not create a WebRTC audio offer.");

        const controller = new AbortController();
        requestControllerRef.current = controller;
        const token = await api.createRealtimeToken(
          sessionId,
          controller.signal,
        );
        if (!token.clientSecret || !token.translationSessionId) {
          throw new Error("The realtime credential response was empty.");
        }
        translationSessionIdRef.current = token.translationSessionId;
        sequenceRef.current = Math.max(
          sequenceRef.current,
          token.lastCommitNo ?? 0,
        );
        const response = await fetch(OPENAI_TRANSLATION_CALLS_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token.clientSecret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        });
        if (!response.ok) {
          const detail = (await response.text()).trim();
          throw new Error(
            detail ||
              `Live translation connection failed with status ${response.status}.`,
          );
        }
        await peer.setRemoteDescription({
          type: "answer",
          sdp: await response.text(),
        });
        await waitForDataChannelOpen(channel, DATA_CHANNEL_OPEN_TIMEOUT_MS);
        requestControllerRef.current = null;
        everConnectedRef.current = true;
        phraseLifecycleRef.current = startRealtimePhraseCall(
          phraseLifecycleRef.current,
        );
        setConnectionStatus("open");
        setCaptureStatus("paused");
        setPipelineStatus("idle");
      } catch (cause) {
        cleanupPeer(true);
        const nextError = errorDetails(cause);
        if (mountedRef.current) {
          setError(nextError);
          setConnectionStatus("error");
          setCaptureStatus(
            nextError.code === "MIC_PERMISSION_DENIED" ? "denied" : "error",
          );
          setPipelineStatus("error");
        }
        throw cause;
      }
    })();

    connectPromiseRef.current = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (connectPromiseRef.current === connectPromise) {
        connectPromiseRef.current = null;
      }
    }
  }, [cleanupPeer, enabled, handleRealtimeEvent, sessionId]);

  const requestSessionClose = useCallback(
    async (timeoutMs: number, timeoutMessage: string): Promise<void> => {
      const channel = channelRef.current;
      if (sessionClosedRef.current) return;
      if (channel?.readyState !== "open") {
        throw new Error("Live translation disconnected before the phrase finished.");
      }

      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          sessionClosedResolverRef.current = null;
          reject(new Error(timeoutMessage));
        }, Math.max(0, timeoutMs));
        sessionClosedResolverRef.current = () => {
          window.clearTimeout(timer);
          resolve();
        };
        channel.send(JSON.stringify({ type: "session.close" }));
      });
    },
    [],
  );

  const resume = useCallback(async () => {
    desiredActiveRef.current = true;
    const initialPause = pausePromiseRef.current;
    const initialRelease = releasePromiseRef.current;
    const connectFromInitialGesture =
      !everConnectedRef.current &&
      !initialPause &&
      !initialRelease &&
      !closingRef.current;
    try {
      // On the first interaction, invoke getUserMedia before unrelated awaits so
      // Safari receives the permission request directly from the tap/press.
      if (connectFromInitialGesture) await ensureConnected();
      if (initialPause) await initialPause;
      if (initialRelease) await initialRelease;
      if (closingRef.current || !desiredActiveRef.current) return;

      const isHold = recordingModeRef.current === "ptt";
      const commitsDrained = await waitForSaveDrainRef.current(
        PHRASE_COMMIT_TIMEOUT_MS,
      );
      if (!commitsDrained) {
        setError({
          code: "PHRASE_COMMIT_TIMEOUT",
          message: "The previous phrase is still being saved. Please try again.",
        });
        setPipelineStatus("error");
        throw new Error("The previous phrase has not finished saving.");
      }

      if (isHold) {
        await waitForHoldQuiescence();
        const resumeDecision = holdResumeDecision({
          saveDrained: commitsDrained,
          quiescenceSettled: holdQuiescenceRef.current === null,
          connectionDirty: holdConnectionDirtyRef.current,
        });
        if (resumeDecision === "reconnect") {
          connectionGenerationRef.current += 1;
          connectPromiseRef.current = null;
          cleanupPeer(true);
          setConnectionStatus("idle");
        }
      }
      if (closingRef.current || !desiredActiveRef.current) return;
      if (!connectFromInitialGesture) await ensureConnected();
      if (closingRef.current || !desiredActiveRef.current) return;

      if (isHold) {
        await waitForHoldQuiescence();
        const resumeDecision = holdResumeDecision({
          saveDrained: commitsDrained,
          quiescenceSettled: holdQuiescenceRef.current === null,
          connectionDirty: holdConnectionDirtyRef.current,
        });
        if (resumeDecision === "reconnect") {
          connectionGenerationRef.current += 1;
          connectPromiseRef.current = null;
          cleanupPeer(true);
          setConnectionStatus("idle");
          await ensureConnected();
        }
        if (closingRef.current || !desiredActiveRef.current) return;
        holdReleaseDeadlineRef.current = null;
        holdInactiveRef.current = false;
        holdConnectionDirtyRef.current = false;
      }

      const track = streamRef.current?.getAudioTracks()[0];
      if (!track) throw new Error("The microphone audio track is unavailable.");
      if (isHold) holdCaptureActiveRef.current = true;
      track.enabled = true;
      setCaptureStatus("active");
      setPipelineStatus("listening");
      setError(null);
    } catch {
      desiredActiveRef.current = false;
      holdCaptureActiveRef.current = false;
    }
  }, [cleanupPeer, ensureConnected, waitForHoldQuiescence]);

  const pause = useCallback((): Promise<void> => {
    desiredActiveRef.current = false;
    const wasHoldCaptureActive = holdCaptureActiveRef.current;
    holdCaptureActiveRef.current = false;
    if (wasHoldCaptureActive) clearHoldReleaseState();
    const track = streamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = false;
    if (!closingRef.current) {
      setCaptureStatus(channelRef.current?.readyState === "open" ? "paused" : "idle");
      setPipelineStatus(outputDraftRef.current ? "translating" : "idle");
    }

    if (pausePromiseRef.current) return pausePromiseRef.current;
    if (channelRef.current?.readyState !== "open") {
      setIsFinalizingPhrase(false);
      if (sourceDeltasRef.current.length > 0 || outputDeltasRef.current.length > 0) {
        discardCurrentPhrase();
        setError({
          code: "PHRASE_FINALIZE_FAILED",
          message: "The phrase was interrupted. Please repeat it.",
        });
        setPipelineStatus("error");
      }
      return Promise.resolve();
    }

    clearPhraseTimers();
    setIsFinalizingPhrase(true);
    const pausePromise = (async () => {
      const pendingRelease = releasePromiseRef.current;
      if (pendingRelease) await pendingRelease;
      closingRef.current = true;
      phraseLifecycleRef.current = beginRealtimePhraseClose(
        phraseLifecycleRef.current,
      );
      try {
        await requestSessionClose(
          PAUSE_CLOSE_TIMEOUT_MS,
          "The translation did not finish after pausing. Please repeat the phrase.",
        );
        const hadDraft =
          sourceDeltasRef.current.length > 0 || outputDeltasRef.current.length > 0;
        const commitDecision = consumeClosedPhraseCommit(
          phraseLifecycleRef.current,
        );
        phraseLifecycleRef.current = commitDecision.lifecycle;
        const committed =
          commitDecision.shouldCommit && commitCurrentPhrase("pause");
        if (committed) {
          const commitsDrained = await waitForSaveDrainRef.current(
            PHRASE_COMMIT_TIMEOUT_MS,
          );
          if (!commitsDrained) {
            throw new Error(
              "The translation was not saved in time. Please try again.",
            );
          }
          phraseLifecycleRef.current = markRealtimePhraseCommitAcknowledged(
            phraseLifecycleRef.current,
          );
        }
        if (hadDraft && !committed) {
          discardIncompletePhrase();
        }
        cleanupPeer(true);
        setConnectionStatus("idle");
        setCaptureStatus("paused");
      } catch (cause) {
        discardCurrentPhrase();
        cleanupPeer(true);
        setError({
          code: "PHRASE_FINALIZE_FAILED",
          message:
            cause instanceof Error
              ? cause.message
              : "The phrase could not be finalized. Please repeat it.",
        });
        setConnectionStatus("error");
        setCaptureStatus("error");
        setPipelineStatus("error");
      } finally {
        closingRef.current = false;
        if (mountedRef.current) setIsFinalizingPhrase(false);
      }
    })();

    pausePromiseRef.current = pausePromise;
    void pausePromise.finally(() => {
      if (pausePromiseRef.current === pausePromise) pausePromiseRef.current = null;
    });
    return pausePromise;
  }, [
    cleanupPeer,
    clearHoldReleaseState,
    clearPhraseTimers,
    commitCurrentPhrase,
    discardIncompletePhrase,
    requestSessionClose,
  ]);

  const releasePushToTalk = useCallback((): Promise<void> => {
    const releasePlan = planHoldRelease(
      recordingModeRef.current,
      holdCaptureActiveRef.current,
    );
    if (releasePlan.action === "pause-session") return pause();

    desiredActiveRef.current = false;
    const track = streamRef.current?.getAudioTracks()[0];
    if (track && releasePlan.disableTrack) track.enabled = false;
    clearPhraseTimers();
    if (!closingRef.current) {
      setCaptureStatus(
        channelRef.current?.readyState === "open" ? "paused" : "idle",
      );
    }

    const pendingPause = pausePromiseRef.current;
    if (pendingPause) {
      holdCaptureActiveRef.current = false;
      return pendingPause;
    }
    const pendingRelease = releasePromiseRef.current;
    if (pendingRelease) return pendingRelease;
    if (releasePlan.action === "noop") return Promise.resolve();

    holdCaptureActiveRef.current = false;
    holdInactiveRef.current = true;
    holdConnectionDirtyRef.current = false;
    holdReleaseDeadlineRef.current = Date.now() + HOLD_RELEASE_HARD_CAP_MS;
    setIsFinalizingPhrase(true);
    const quiescencePromise = releasePlan.waitForQuiescence
      ? startHoldQuiescence()
      : Promise.resolve();

    const committed = commitCurrentPhrase("release");
    if (!committed) {
      discardIncompletePhrase();
    } else {
      setPipelineStatus("processing");
    }

    const savePromise = committed && releasePlan.waitForSave
      ? waitForSaveDrainRef.current(PHRASE_COMMIT_TIMEOUT_MS)
      : Promise.resolve(true);
    const releasePromise = (async () => {
      const [saved] = await Promise.all([savePromise, quiescencePromise]);
      if (!mountedRef.current) return;
      if (!saved) {
        setError({
          code: "PHRASE_COMMIT_TIMEOUT",
          message: "The released phrase is still being saved. Please try again.",
        });
        setPipelineStatus("error");
      } else if (committed && !desiredActiveRef.current) {
        setPipelineStatus("idle");
      }
    })();

    releasePromiseRef.current = releasePromise;
    void releasePromise.finally(() => {
      if (releasePromiseRef.current === releasePromise) {
        releasePromiseRef.current = null;
      }
      if (
        mountedRef.current &&
        pausePromiseRef.current === null &&
        closePromiseRef.current === null &&
        !closingRef.current
      ) {
        setIsFinalizingPhrase(false);
      }
    });
    return releasePromise;
  }, [
    clearPhraseTimers,
    commitCurrentPhrase,
    discardIncompletePhrase,
    pause,
    startHoldQuiescence,
  ]);

  const reconnect = useCallback(async () => {
    const shouldResume = desiredActiveRef.current;
    await pause();
    connectionGenerationRef.current += 1;
    connectPromiseRef.current = null;
    cleanupPeer(true);
    setConnectionStatus("idle");
    await ensureConnected();
    if (shouldResume) await resume();
  }, [cleanupPeer, ensureConnected, pause, resume]);

  const closeAndDrain = useCallback(
    async (timeoutMs = 30_000): Promise<void> => {
      if (closePromiseRef.current) return closePromiseRef.current;

      const closePromise = (async () => {
        desiredActiveRef.current = false;
        holdCaptureActiveRef.current = false;
        const pendingPause = pausePromiseRef.current;
        if (pendingPause) await pendingPause;
        const pendingRelease = releasePromiseRef.current;
        if (pendingRelease) await pendingRelease;
        closingRef.current = true;
        connectionGenerationRef.current += 1;
        connectPromiseRef.current = null;
        const track = streamRef.current?.getAudioTracks()[0];
        if (track) track.enabled = false;
        phraseLifecycleRef.current = beginRealtimePhraseClose(
          phraseLifecycleRef.current,
        );
        setIsFinalizingPhrase(true);
        setCaptureStatus("closing");
        setPipelineStatus("processing");

        const channel = channelRef.current;
        if (
          everConnectedRef.current &&
          !sessionClosedRef.current &&
          channel?.readyState !== "open"
        ) {
          throw new Error(
            "Live translation is disconnected. Reconnect before ending the class.",
          );
        }
        if (channel?.readyState === "open" && !sessionClosedRef.current) {
          await requestSessionClose(
            timeoutMs,
            "The final translation did not finish in time. Please retry End Class.",
          );
        }

        const commitDecision = consumeClosedPhraseCommit(
          phraseLifecycleRef.current,
        );
        phraseLifecycleRef.current = commitDecision.lifecycle;
        if (commitDecision.shouldCommit) commitCurrentPhrase("final");
        cleanupPeer(true);
        setConnectionStatus("closed");
        setCaptureStatus("closed");
      })();

      closePromiseRef.current = closePromise;
      try {
        await closePromise;
      } finally {
        closePromiseRef.current = null;
        if (mountedRef.current) setIsFinalizingPhrase(false);
      }
    },
    [cleanupPeer, commitCurrentPhrase, requestSessionClose],
  );

  const clearLines = useCallback(() => {
    clearPhraseTimers();
    clearHoldReleaseState();
    holdCaptureActiveRef.current = false;
    sourceDraftRef.current = "";
    outputDraftRef.current = "";
    sourceDeltasRef.current = [];
    outputDeltasRef.current = [];
    sequenceRef.current = 0;
    translationSessionIdRef.current = "";
    setSourceDraft("");
    setHasOutputDraft(false);
    setIsFinalizingPhrase(false);
    setCommittedTranscripts([]);
    setPipelineStatus(desiredActiveRef.current ? "listening" : "idle");
  }, [clearHoldReleaseState, clearPhraseTimers]);

  useEffect(() => {
    setIsSupported(browserSupportsRealtime());
  }, []);

  useEffect(() => {
    const stopOnInterruption = () => {
      if (desiredActiveRef.current) void pause();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stopOnInterruption();
    };
    window.addEventListener("blur", stopOnInterruption);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", stopOnInterruption);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [pause]);

  useEffect(() => {
    if (enabled) return;
    desiredActiveRef.current = false;
    holdCaptureActiveRef.current = false;
    const track = streamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = false;
    connectionGenerationRef.current += 1;
    connectPromiseRef.current = null;
    cleanupPeer(true);
    setConnectionStatus("idle");
    setCaptureStatus("idle");
  }, [cleanupPeer, enabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      holdCaptureActiveRef.current = false;
      connectionGenerationRef.current += 1;
      connectPromiseRef.current = null;
      clearPhraseTimers();
      cleanupPeer(true);
    };
  }, [cleanupPeer, clearPhraseTimers]);

  const transcripts = useMemo<TranscriptLine[]>(() => {
    if (!sourceDraft) return committedTranscripts;
    return [
      ...committedTranscripts,
      {
        id: "source-draft",
        sequenceNo: sequenceRef.current + 1,
        text: sourceDraft,
        isFinal: false,
      },
    ];
  }, [committedTranscripts, sourceDraft]);

  return {
    connectionStatus,
    captureStatus,
    pipelineStatus,
    transcripts,
    isReviewingTranslation: Boolean(sourceDraft || hasOutputDraft),
    isFinalizingPhrase,
    micStream,
    isTransmitting: captureStatus === "active",
    isSupported,
    error,
    resume,
    releasePushToTalk,
    pause,
    reconnect,
    closeAndDrain,
    flushPhrase: () => commitCurrentPhrase("pause"),
    clearLines,
  };
}

export default useRealtimeTranslation;
