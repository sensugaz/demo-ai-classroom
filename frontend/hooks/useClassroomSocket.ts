"use client";

/**
 * Realtime classroom socket hook.
 *
 * Owns one ClassroomWebSocket instance for the given sessionId and:
 *  - connects, then sends session:join on open
 *  - exposes sendAudioChunk / endSession imperative helpers
 *  - accumulates inbound transcripts[] (Thai) and translations[] (English)
 *  - tracks a high-level PipelineStatus and the latest TTS audio payload
 *  - auto-reconnects with capped backoff on unexpected disconnects
 *
 * The newest TTS payload is surfaced via `ttsAudio`; the EnglishAudioPlayer
 * component consumes and queues these for non-overlapping playback.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ClassroomWebSocket } from "@/lib/websocket";
import type {
  AudioChunkPayload,
  ConnectionStatus,
  ErrorPayload,
  PipelineStatus,
  SessionCompletedPayload,
  TranscriptLine,
  TranslationLine,
  TtsAudioPayload,
} from "@/lib/types";

const MAX_RECONNECT_ATTEMPTS = 6;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 15000;

export interface ClassroomSocketError {
  code: string;
  message: string;
  at: number;
}

export interface TtsAudioEvent {
  /** Monotonic id so the player can dedupe / queue distinct clips. */
  id: number;
  payload: TtsAudioPayload;
}

interface UseClassroomSocketOptions {
  sessionId: string;
  /** When false, the hook will not open a connection (e.g. before mic start). */
  enabled?: boolean;
}

interface UseClassroomSocketResult {
  connectionStatus: ConnectionStatus;
  pipelineStatus: PipelineStatus;
  transcripts: TranscriptLine[];
  translations: TranslationLine[];
  ttsAudio: TtsAudioEvent | null;
  lastError: ClassroomSocketError | null;
  completed: SessionCompletedPayload | null;
  sendAudioChunk: (chunk: Omit<AudioChunkPayload, "sessionId">) => boolean;
  waitForAudioDrain: (timeoutMs: number) => Promise<boolean>;
  endSession: () => boolean;
  reconnect: () => void;
  /** Clear the on-screen transcript + translation lists (used by Reset). */
  clearLines: () => void;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function bySequence<T extends { sequenceNo?: number }>(a: T, b: T): number {
  const left = a.sequenceNo ?? Number.MAX_SAFE_INTEGER;
  const right = b.sequenceNo ?? Number.MAX_SAFE_INTEGER;
  return left - right;
}

export function useClassroomSocket(
  options: UseClassroomSocketOptions,
): UseClassroomSocketResult {
  const { sessionId, enabled = true } = options;

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>("idle");
  const [transcripts, setTranscripts] = useState<TranscriptLine[]>([]);
  const [translations, setTranslations] = useState<TranslationLine[]>([]);
  const [ttsAudio, setTtsAudio] = useState<TtsAudioEvent | null>(null);
  const [lastError, setLastError] = useState<ClassroomSocketError | null>(null);
  const [completed, setCompleted] = useState<SessionCompletedPayload | null>(
    null,
  );

  const socketRef = useRef<ClassroomWebSocket | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsCounterRef = useRef<number>(0);
  // Track partial-transcript line id so successive partials replace, not append.
  const partialLineIdRef = useRef<string | null>(null);
  const pendingSequenceNosRef = useRef<Set<number>>(new Set());
  const processedSequenceNosRef = useRef<Set<number>>(new Set());
  const ttsBySequenceNoRef = useRef<Map<number, TtsAudioPayload>>(new Map());
  const ttsDispatchQueueRef = useRef<TtsAudioPayload[]>([]);
  const ttsDispatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainWaitersRef = useRef<
    Set<{
      resolve: (drained: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >(new Set());
  // Ref-stable bridge to the latest scheduleReconnect, used inside onClose to
  // avoid a circular useCallback dependency (assigned in an effect below).
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const resolveDrainWaiters = useCallback((drained: boolean) => {
    for (const waiter of drainWaitersRef.current) {
      clearTimeout(waiter.timer);
      waiter.resolve(drained);
    }
    drainWaitersRef.current.clear();
  }, []);

  const clearInFlightTracking = useCallback(() => {
    pendingSequenceNosRef.current.clear();
    processedSequenceNosRef.current.clear();
    ttsBySequenceNoRef.current.clear();
    ttsDispatchQueueRef.current.length = 0;
    if (ttsDispatchTimerRef.current !== null) {
      clearTimeout(ttsDispatchTimerRef.current);
      ttsDispatchTimerRef.current = null;
    }
    resolveDrainWaiters(false);
  }, [resolveDrainWaiters]);

  const enqueueTtsPlayback = useCallback((payloads: TtsAudioPayload[]) => {
    ttsDispatchQueueRef.current.push(...payloads);
    if (ttsDispatchTimerRef.current !== null) return;

    const dispatchNext = () => {
      const payload = ttsDispatchQueueRef.current.shift();
      if (!payload) {
        ttsDispatchTimerRef.current = null;
        return;
      }
      const id = ttsCounterRef.current++;
      setTtsAudio({ id, payload });
      ttsDispatchTimerRef.current = setTimeout(dispatchNext, 0);
    };
    ttsDispatchTimerRef.current = setTimeout(dispatchNext, 0);
  }, []);

  const flushOrderedTts = useCallback(() => {
    let smallestPending = Number.POSITIVE_INFINITY;
    for (const sequenceNo of pendingSequenceNosRef.current) {
      smallestPending = Math.min(smallestPending, sequenceNo);
    }

    const readySequenceNos = [...processedSequenceNosRef.current]
      .filter((sequenceNo) => sequenceNo < smallestPending)
      .sort((left, right) => left - right);
    const readyPayloads: TtsAudioPayload[] = [];
    for (const sequenceNo of readySequenceNos) {
      processedSequenceNosRef.current.delete(sequenceNo);
      const payload = ttsBySequenceNoRef.current.get(sequenceNo);
      ttsBySequenceNoRef.current.delete(sequenceNo);
      if (payload) readyPayloads.push(payload);
    }
    if (readyPayloads.length > 0) {
      enqueueTtsPlayback(readyPayloads);
    }
  }, [enqueueTtsPlayback]);

  const buildSocket = useCallback((): ClassroomWebSocket => {
    const socket = new ClassroomWebSocket({
      onOpen: () => {
        reconnectAttemptsRef.current = 0;
        setConnectionStatus("open");
        setPipelineStatus((prev) =>
          prev === "completed" ? prev : "listening",
        );
        socket.sendSessionJoin({ sessionId });
      },
      onClose: () => {
        if (socket.wasManuallyClosed) {
          setConnectionStatus("closed");
          return;
        }
        // Acknowledgements are sender-scoped. Once this socket is gone, its
        // pending sequence numbers can never be acknowledged on the new one.
        clearInFlightTracking();
        // Call through the ref so we always reach the latest scheduleReconnect
        // without creating a circular useCallback dependency.
        scheduleReconnectRef.current();
      },
      onSocketError: () => {
        // onClose will follow and drive reconnection; surface a soft error.
        setLastError({
          code: "WS_ERROR",
          message: "Realtime connection error.",
          at: Date.now(),
        });
      },
    });

    socket.on("audio:processed", (payload) => {
      pendingSequenceNosRef.current.delete(payload.sequenceNo);
      processedSequenceNosRef.current.add(payload.sequenceNo);
      flushOrderedTts();
      if (pendingSequenceNosRef.current.size === 0) {
        resolveDrainWaiters(true);
      }
    });

    // transcript:partial — interim Thai text; replace the live partial line.
    socket.on("transcript:partial", (payload) => {
      setPipelineStatus((prev) => (prev === "completed" ? prev : "transcribing"));
      setTranscripts((prev) => {
        const id = partialLineIdRef.current ?? genId("partial");
        partialLineIdRef.current = id;
        const next = prev.filter((line) => line.id !== id);
        return [
          ...next,
          {
            id,
            sequenceNo: payload.sequenceNo,
            text: payload.text,
            isFinal: false,
          },
        ].sort(bySequence);
      });
    });

    // transcript:final — promote to a permanent Thai line.
    socket.on("transcript:final", (payload) => {
      setPipelineStatus((prev) => (prev === "completed" ? prev : "transcribing"));
      setTranscripts((prev) => {
        const withoutPartial = partialLineIdRef.current
          ? prev.filter((line) => line.id !== partialLineIdRef.current)
          : prev;
        partialLineIdRef.current = null;
        return [
          ...withoutPartial,
          {
            id: genId("final"),
            sequenceNo: payload.sequenceNo,
            text: payload.text,
            isFinal: true,
          },
        ].sort(bySequence);
      });
    });

    // translation:result — English pairing.
    socket.on("translation:result", (payload) => {
      setPipelineStatus((prev) => (prev === "completed" ? prev : "translating"));
      setTranslations((prev) =>
        [
          ...prev,
          {
            id: genId("tr"),
            sequenceNo: payload.sequenceNo,
            sourceText: payload.sourceText,
            translatedText: payload.translatedText,
            latencyMs: payload.latencyMs,
          },
        ].sort(bySequence),
      );
    });

    // tts:audio — surface clip for the audio player queue.
    socket.on("tts:audio", (payload) => {
      if (!payload.audioBase64) return;
      if (!Number.isInteger(payload.sequenceNo) || payload.sequenceNo <= 0) {
        setLastError({
          code: "INVALID_TTS_SEQUENCE",
          message: "Received an invalid audio sequence.",
          at: Date.now(),
        });
        return;
      }
      setPipelineStatus((prev) => (prev === "completed" ? prev : "speaking"));
      ttsBySequenceNoRef.current.set(payload.sequenceNo, payload);
    });

    // session:completed — terminal state; artifacts ready.
    socket.on("session:completed", (payload) => {
      setPipelineStatus("completed");
      setCompleted(payload);
    });

    // error — TTS_FAILED is non-fatal by contract; record but keep going.
    socket.on("error", (payload: ErrorPayload) => {
      setLastError({
        code: payload.code,
        message: payload.message,
        at: Date.now(),
      });
      if (payload.code !== "TTS_FAILED") {
        setPipelineStatus((prev) =>
          prev === "completed" ? prev : "error",
        );
      }
    });

    return socket;
    // scheduleReconnect is stable via ref usage below; deps kept minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearInFlightTracking, enqueueTtsPlayback, flushOrderedTts, resolveDrainWaiters, sessionId]);

  const connect = useCallback(() => {
    clearReconnectTimer();
    // Acknowledgements are scoped to one socket connection. Every replacement,
    // including a manual reconnect, must discard state the new sender cannot own.
    clearInFlightTracking();
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    const socket = buildSocket();
    socketRef.current = socket;
    setConnectionStatus(
      reconnectAttemptsRef.current > 0 ? "reconnecting" : "connecting",
    );
    socket.connect();
  }, [buildSocket, clearInFlightTracking, clearReconnectTimer]);

  const scheduleReconnect = useCallback(() => {
    const attempt = reconnectAttemptsRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setConnectionStatus("closed");
      setLastError({
        code: "WS_RECONNECT_FAILED",
        message:
          "Lost connection to the classroom server and could not reconnect.",
        at: Date.now(),
      });
      return;
    }
    reconnectAttemptsRef.current = attempt + 1;
    setConnectionStatus("reconnecting");
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** attempt,
      MAX_RECONNECT_DELAY_MS,
    );
    clearReconnectTimer();
    reconnectTimerRef.current = setTimeout(() => {
      connect();
    }, delay);
  }, [clearReconnectTimer, connect]);

  // Keep the ref-stable bridge pointing at the latest scheduleReconnect so the
  // socket's onClose handler always reconnects with current state.
  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  useEffect(() => {
    if (!enabled || !sessionId) {
      return;
    }
    reconnectAttemptsRef.current = 0;
    connect();
    return () => {
      clearReconnectTimer();
      clearInFlightTracking();
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, enabled]);

  useEffect(() => {
    return () => {
      clearInFlightTracking();
      resolveDrainWaiters(false);
    };
  }, [clearInFlightTracking, resolveDrainWaiters]);

  const sendAudioChunk = useCallback(
    (chunk: Omit<AudioChunkPayload, "sessionId">): boolean => {
      const socket = socketRef.current;
      if (!socket || !socket.isOpen) {
        return false;
      }
      const sent = socket.sendAudioChunk({ ...chunk, sessionId });
      if (sent) {
        pendingSequenceNosRef.current.add(chunk.sequenceNo);
      }
      return sent;
    },
    [sessionId],
  );

  const waitForAudioDrain = useCallback(
    (timeoutMs: number): Promise<boolean> => {
      if (pendingSequenceNosRef.current.size === 0) {
        return Promise.resolve(true);
      }

      return new Promise<boolean>((resolve) => {
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            drainWaitersRef.current.delete(waiter);
            resolve(false);
          }, Math.max(0, timeoutMs)),
        };
        drainWaitersRef.current.add(waiter);
      });
    },
    [],
  );

  const endSession = useCallback((): boolean => {
    const socket = socketRef.current;
    setPipelineStatus("processing");
    if (socket && socket.isOpen) {
      return socket.sendSessionEnd({ sessionId });
    }
    return false;
  }, [sessionId]);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  const clearLines = useCallback(() => {
    partialLineIdRef.current = null;
    setTranscripts([]);
    setTranslations([]);
  }, []);

  return {
    connectionStatus,
    pipelineStatus,
    transcripts,
    translations,
    ttsAudio,
    lastError,
    completed,
    sendAudioChunk,
    waitForAudioDrain,
    endSession,
    reconnect,
    clearLines,
  };
}
