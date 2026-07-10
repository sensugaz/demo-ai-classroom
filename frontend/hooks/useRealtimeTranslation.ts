"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import { isConnectionAttemptCurrent } from "@/lib/realtimeConnection";
import {
  DEFAULT_PHRASE_MAX_WINDOW_MS,
  appendTranscriptDelta,
  normalizeCommittedText,
  phraseDebounceMs,
  takeAlignedTranscriptPhrase,
} from "@/lib/translationPhrase";
import type { TimedTranscriptDelta } from "@/lib/translationPhrase";
import type {
  PipelineStatus,
  RealtimeCaptureStatus,
  RealtimeConnectionStatus,
  RealtimeErrorEvent,
  RealtimeServerEvent,
  RealtimeTranscriptDeltaEvent,
  TranscriptLine,
  TranslationCommitPayload,
  TranslationLine,
  TtsSpeechSpeed,
  TtsVoiceProfile,
} from "@/lib/types";

const OPENAI_TRANSLATION_CALLS_URL =
  "https://api.openai.com/v1/realtime/translations/calls";
const DATA_CHANNEL_OPEN_TIMEOUT_MS = 15_000;

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
  voiceProfile: TtsVoiceProfile;
  speechSpeed: TtsSpeechSpeed;
  onPhraseCommit: (
    payload: Omit<TranslationCommitPayload, "sessionId">,
  ) => void;
}

interface UseRealtimeTranslationResult {
  connectionStatus: RealtimeConnectionStatus;
  captureStatus: RealtimeCaptureStatus;
  pipelineStatus: PipelineStatus;
  transcripts: TranscriptLine[];
  translations: TranslationLine[];
  micStream: MediaStream | null;
  isTransmitting: boolean;
  isSupported: boolean;
  error: RealtimeTranslationError | null;
  resume: () => Promise<void>;
  pause: () => void;
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
    voiceProfile,
    speechSpeed,
    onPhraseCommit,
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
  const [committedTranslations, setCommittedTranslations] = useState<
    TranslationLine[]
  >([]);
  const [sourceDraft, setSourceDraft] = useState("");
  const [outputDraft, setOutputDraft] = useState("");
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
  const desiredActiveRef = useRef(false);
  const closingRef = useRef(false);
  const sessionClosedRef = useRef(false);
  const everConnectedRef = useRef(false);
  const sessionClosedResolverRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const onPhraseCommitRef = useRef(onPhraseCommit);
  const voiceProfileRef = useRef(voiceProfile);
  const speechSpeedRef = useRef(speechSpeed);

  useEffect(() => {
    onPhraseCommitRef.current = onPhraseCommit;
  }, [onPhraseCommit]);
  useEffect(() => {
    voiceProfileRef.current = voiceProfile;
  }, [voiceProfile]);
  useEffect(() => {
    speechSpeedRef.current = speechSpeed;
  }, [speechSpeed]);

  const clearPhraseTimers = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (maxWindowTimerRef.current !== null) {
      clearTimeout(maxWindowTimerRef.current);
      maxWindowTimerRef.current = null;
    }
    phraseStartedAtRef.current = null;
  }, []);

  const commitCurrentPhrase = useCallback(
    (commitKind: "debounced" | "final" = "debounced"): boolean => {
      clearPhraseTimers();
      const aligned = takeAlignedTranscriptPhrase(
        sourceDeltasRef.current,
        outputDeltasRef.current,
        commitKind === "final",
      );
      const sourceText = normalizeCommittedText(aligned.sourceText);
      const translatedText = normalizeCommittedText(aligned.translatedText);

      if (!sourceText && !translatedText) {
        setPipelineStatus(desiredActiveRef.current ? "listening" : "idle");
        return false;
      }
      if (!sourceText || !translatedText || !translationSessionIdRef.current) {
        return false;
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
      setOutputDraft(outputDraftRef.current);

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

      setCommittedTranslations((previous) => [
        ...previous,
        {
          id: `translation-${commitNo}`,
          sequenceNo: commitNo,
          sourceText,
          translatedText,
          isFinal: true,
        },
      ]);
      onPhraseCommitRef.current({
        translationSessionId: translationSessionIdRef.current,
        commitId: `${translationSessionIdRef.current}:${commitNo}`,
        commitNo,
        commitKind,
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
    [clearPhraseTimers],
  );

  const schedulePhraseCommit = useCallback(
    (text: string) => {
      if (phraseStartedAtRef.current === null) {
        phraseStartedAtRef.current = Date.now();
        maxWindowTimerRef.current = setTimeout(
          commitCurrentPhrase,
          DEFAULT_PHRASE_MAX_WINDOW_MS,
        );
      }
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(
        commitCurrentPhrase,
        phraseDebounceMs(text),
      );
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
        const elapsedMs = Math.max(0, transcriptEvent.elapsed_ms ?? 0);
        sourceDeltasRef.current.push({
          text: transcriptEvent.delta,
          elapsedMs,
        });
        const next = appendTranscriptDelta(
          sourceDraftRef.current,
          transcriptEvent.delta,
        );
        sourceDraftRef.current = next;
        setSourceDraft(next);
        setPipelineStatus("transcribing");
        if (outputDraftRef.current) {
          schedulePhraseCommit(outputDraftRef.current);
        }
        return;
      }

      if (event.type === "session.output_transcript.delta") {
        const transcriptEvent = event as RealtimeTranscriptDeltaEvent;
        if (typeof transcriptEvent.delta !== "string") return;
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
        setOutputDraft(next);
        setPipelineStatus("translating");
        schedulePhraseCommit(next);
        return;
      }

      if (event.type === "session.closed") {
        sessionClosedRef.current = true;
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
    [schedulePhraseCommit],
  );

  const cleanupPeer = useCallback((stopStream = true) => {
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
  }, [handleRealtimeEvent]);

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

  const resume = useCallback(async () => {
    desiredActiveRef.current = true;
    try {
      await ensureConnected();
      if (closingRef.current || !desiredActiveRef.current) return;
      const track = streamRef.current?.getAudioTracks()[0];
      if (!track) throw new Error("The microphone audio track is unavailable.");
      track.enabled = true;
      setCaptureStatus("active");
      setPipelineStatus("listening");
      setError(null);
    } catch {
      desiredActiveRef.current = false;
    }
  }, [ensureConnected]);

  const pause = useCallback(() => {
    desiredActiveRef.current = false;
    const track = streamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = false;
    if (!closingRef.current) {
      setCaptureStatus(channelRef.current?.readyState === "open" ? "paused" : "idle");
      setPipelineStatus(outputDraftRef.current ? "translating" : "idle");
    }
  }, []);

  const reconnect = useCallback(async () => {
    const shouldResume = desiredActiveRef.current;
    pause();
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
        closingRef.current = true;
        connectionGenerationRef.current += 1;
        connectPromiseRef.current = null;
        const track = streamRef.current?.getAudioTracks()[0];
        if (track) track.enabled = false;
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
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => {
              sessionClosedResolverRef.current = null;
              reject(
                new Error(
                  "The final translation did not finish in time. Please retry End Class.",
                ),
              );
            }, Math.max(0, timeoutMs));
            sessionClosedResolverRef.current = () => {
              window.clearTimeout(timer);
              resolve();
            };
            channel.send(JSON.stringify({ type: "session.close" }));
          });
        }

        commitCurrentPhrase("final");
        cleanupPeer(true);
        setConnectionStatus("closed");
        setCaptureStatus("closed");
      })();

      closePromiseRef.current = closePromise;
      try {
        await closePromise;
      } finally {
        closePromiseRef.current = null;
      }
    },
    [cleanupPeer, commitCurrentPhrase],
  );

  const clearLines = useCallback(() => {
    clearPhraseTimers();
    sourceDraftRef.current = "";
    outputDraftRef.current = "";
    sourceDeltasRef.current = [];
    outputDeltasRef.current = [];
    setSourceDraft("");
    setOutputDraft("");
    setCommittedTranscripts([]);
    setCommittedTranslations([]);
    setPipelineStatus(desiredActiveRef.current ? "listening" : "idle");
  }, [clearPhraseTimers]);

  useEffect(() => {
    setIsSupported(browserSupportsRealtime());
  }, []);

  useEffect(() => {
    const stopOnInterruption = () => {
      if (desiredActiveRef.current) pause();
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
    pause();
    connectionGenerationRef.current += 1;
    connectPromiseRef.current = null;
    cleanupPeer(true);
    setConnectionStatus("idle");
    setCaptureStatus("idle");
  }, [cleanupPeer, enabled, pause]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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

  const translations = useMemo<TranslationLine[]>(() => {
    if (!outputDraft) return committedTranslations;
    return [
      ...committedTranslations,
      {
        id: "translation-draft",
        sequenceNo: sequenceRef.current + 1,
        sourceText: sourceDraft,
        translatedText: outputDraft,
        isFinal: false,
      },
    ];
  }, [committedTranslations, outputDraft, sourceDraft]);

  return {
    connectionStatus,
    captureStatus,
    pipelineStatus,
    transcripts,
    translations,
    micStream,
    isTransmitting: captureStatus === "active",
    isSupported,
    error,
    resume,
    pause,
    reconnect,
    closeAndDrain,
    flushPhrase: commitCurrentPhrase,
    clearLines,
  };
}

export default useRealtimeTranslation;
