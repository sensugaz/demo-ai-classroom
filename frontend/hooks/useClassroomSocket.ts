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
  endSession: () => void;
  reconnect: () => void;
  /** Clear the on-screen transcript + translation lists (used by Reset). */
  clearLines: () => void;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  // Ref-stable bridge to the latest scheduleReconnect, used inside onClose to
  // avoid a circular useCallback dependency (assigned in an effect below).
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

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

    // transcript:partial — interim Thai text; replace the live partial line.
    socket.on("transcript:partial", (payload) => {
      setPipelineStatus((prev) => (prev === "completed" ? prev : "transcribing"));
      setTranscripts((prev) => {
        const id = partialLineIdRef.current ?? genId("partial");
        partialLineIdRef.current = id;
        const next = prev.filter((line) => line.id !== id);
        return [...next, { id, text: payload.text, isFinal: false }];
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
          { id: genId("final"), text: payload.text, isFinal: true },
        ];
      });
    });

    // translation:result — English pairing.
    socket.on("translation:result", (payload) => {
      setPipelineStatus((prev) => (prev === "completed" ? prev : "translating"));
      setTranslations((prev) => [
        ...prev,
        {
          id: genId("tr"),
          sourceText: payload.sourceText,
          translatedText: payload.translatedText,
          latencyMs: payload.latencyMs,
        },
      ]);
    });

    // tts:audio — surface clip for the audio player queue.
    socket.on("tts:audio", (payload) => {
      if (!payload.audioBase64) return;
      setPipelineStatus((prev) => (prev === "completed" ? prev : "speaking"));
      const id = ttsCounterRef.current++;
      setTtsAudio({ id, payload });
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
  }, [sessionId]);

  const connect = useCallback(() => {
    clearReconnectTimer();
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
  }, [buildSocket, clearReconnectTimer]);

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
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, enabled]);

  const sendAudioChunk = useCallback(
    (chunk: Omit<AudioChunkPayload, "sessionId">): boolean => {
      const socket = socketRef.current;
      if (!socket || !socket.isOpen) {
        return false;
      }
      return socket.sendAudioChunk({ ...chunk, sessionId });
    },
    [sessionId],
  );

  const endSession = useCallback(() => {
    const socket = socketRef.current;
    setPipelineStatus("processing");
    if (socket && socket.isOpen) {
      socket.sendSessionEnd({ sessionId });
    }
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
    endSession,
    reconnect,
    clearLines,
  };
}
