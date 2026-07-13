"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ClassroomWebSocket } from "@/lib/websocket";
import {
  advanceTranslationReviewOutcome,
  isCanonicalTranslationCommittedPayload,
  isExpectedPendingCommit,
  upsertCanonicalTranslation,
} from "@/lib/canonicalTranslation";
import type { TranslationReviewOutcome } from "@/lib/canonicalTranslation";
import { settleCommitWithoutAudio } from "@/lib/commitTerminal";
import {
  createPhraseJourneyState,
  phraseJourneyReducer,
} from "@/lib/phraseJourney";
import type {
  AudioPlayerLifecycleEvent,
  PhraseJourneyState,
} from "@/lib/phraseJourney";
import { readyTtsCommitNos } from "@/lib/ttsCommitOrdering";
import type {
  ConnectionStatus,
  ErrorPayload,
  PipelineStatus,
  SessionCompletedPayload,
  TranslationCommitPayload,
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
  id: number;
  payload: TtsAudioPayload;
}

interface UseClassroomSocketOptions {
  sessionId: string;
  enabled?: boolean;
}

interface UseClassroomSocketResult {
  connectionStatus: ConnectionStatus;
  pipelineStatus: PipelineStatus;
  ttsAudio: TtsAudioEvent | null;
  lastError: ClassroomSocketError | null;
  completed: SessionCompletedPayload | null;
  pendingCommitCount: number;
  translations: TranslationLine[];
  phraseJourney: PhraseJourneyState;
  audioResetToken: number;
  queueTranslationCommit: (
    payload: Omit<TranslationCommitPayload, "sessionId">,
  ) => void;
  waitForCommitDrain: (timeoutMs: number) => Promise<boolean>;
  reportAudioLifecycle: (event: AudioPlayerLifecycleEvent) => void;
  resetLiveState: () => void;
  reconnect: () => void;
}

export function useClassroomSocket(
  options: UseClassroomSocketOptions,
): UseClassroomSocketResult {
  const { sessionId, enabled = true } = options;
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>("idle");
  const [ttsAudio, setTtsAudio] = useState<TtsAudioEvent | null>(null);
  const [lastError, setLastError] = useState<ClassroomSocketError | null>(null);
  const [completed, setCompleted] = useState<SessionCompletedPayload | null>(null);
  const [pendingCommitCount, setPendingCommitCount] = useState(0);
  const [translations, setTranslations] = useState<TranslationLine[]>([]);
  const [audioResetToken, setAudioResetToken] = useState(0);
  const [phraseJourney, dispatchPhraseJourney] = useReducer(
    phraseJourneyReducer,
    createPhraseJourneyState(),
  );

  const socketRef = useRef<ClassroomWebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitsRef = useRef<Map<string, TranslationCommitPayload>>(new Map());
  const sentCommitIdsRef = useRef<Set<string>>(new Set());
  const acknowledgedCommitNosRef = useRef<Set<number>>(new Set());
  const noAudioCommitNosRef = useRef<Set<number>>(new Set());
  const dispatchedCommitNosRef = useRef<Set<number>>(new Set());
  const ttsByCommitNoRef = useRef<Map<number, TtsAudioPayload>>(new Map());
  const ttsDispatchQueueRef = useRef<TtsAudioPayload[]>([]);
  const ttsDispatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsCounterRef = useRef(0);
  const drainWaitersRef = useRef<
    Set<{
      resolve: (drained: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >(new Set());
  const scheduleReconnectRef = useRef<() => void>(() => {});
  const latestReviewOutcomeRef = useRef<TranslationReviewOutcome>({
    commitNo: 0,
    status: "accepted",
  });

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

  const enqueueTtsPlayback = useCallback((payloads: TtsAudioPayload[]) => {
    ttsDispatchQueueRef.current.push(...payloads);
    if (ttsDispatchTimerRef.current !== null) return;

    const dispatchNext = () => {
      const payload = ttsDispatchQueueRef.current.shift();
      if (!payload) {
        ttsDispatchTimerRef.current = null;
        return;
      }
      setTtsAudio({ id: ttsCounterRef.current++, payload });
      ttsDispatchTimerRef.current = setTimeout(dispatchNext, 0);
    };
    ttsDispatchTimerRef.current = setTimeout(dispatchNext, 0);
  }, []);

  const flushOrderedTts = useCallback(() => {
    let smallestPending = Number.POSITIVE_INFINITY;
    for (const commit of pendingCommitsRef.current.values()) {
      smallestPending = Math.min(smallestPending, commit.commitNo);
    }

    const readyCommitNos = readyTtsCommitNos({
      acknowledgedCommitNos: acknowledgedCommitNosRef.current,
      audioCommitNos: new Set(ttsByCommitNoRef.current.keys()),
      noAudioCommitNos: noAudioCommitNosRef.current,
      smallestPendingCommitNo: smallestPending,
    });
    const readyPayloads: TtsAudioPayload[] = [];
    for (const commitNo of readyCommitNos) {
      const payload = ttsByCommitNoRef.current.get(commitNo);
      acknowledgedCommitNosRef.current.delete(commitNo);
      if (dispatchedCommitNosRef.current.has(commitNo)) continue;
      dispatchedCommitNosRef.current.add(commitNo);
      ttsByCommitNoRef.current.delete(commitNo);
      noAudioCommitNosRef.current.delete(commitNo);
      if (payload) readyPayloads.push(payload);
    }
    if (readyPayloads.length > 0) enqueueTtsPlayback(readyPayloads);
  }, [enqueueTtsPlayback]);

  const settleTerminalNoAudio = useCallback(
    (identity: { commitId: string; commitNo: number }): boolean => {
      const settled = settleCommitWithoutAudio(
        {
          pendingCommits: pendingCommitsRef.current,
          sentCommitIds: sentCommitIdsRef.current,
          acknowledgedCommitNos: acknowledgedCommitNosRef.current,
          noAudioCommitNos: noAudioCommitNosRef.current,
          ttsByCommitNo: ttsByCommitNoRef.current,
        },
        identity,
      );
      if (!settled) return false;

      setPendingCommitCount(pendingCommitsRef.current.size);
      flushOrderedTts();
      if (pendingCommitsRef.current.size === 0) resolveDrainWaiters(true);

      return true;
    },
    [flushOrderedTts, resolveDrainWaiters],
  );

  const sendQueuedCommits = useCallback((socket: ClassroomWebSocket) => {
    const commits = [...pendingCommitsRef.current.values()].sort(
      (left, right) => left.commitNo - right.commitNo,
    );
    for (const commit of commits) {
      if (sentCommitIdsRef.current.has(commit.commitId)) continue;
      if (socket.sendTranslationCommit(commit)) {
        sentCommitIdsRef.current.add(commit.commitId);
      }
    }
  }, []);

  const buildSocket = useCallback((): ClassroomWebSocket => {
    const socket = new ClassroomWebSocket({
      onOpen: () => {
        reconnectAttemptsRef.current = 0;
        sentCommitIdsRef.current.clear();
        setConnectionStatus("open");
        setLastError((current) =>
          current?.code === "TRANSLATION_REVIEW_FAILED" &&
          latestReviewOutcomeRef.current.status === "rejected"
            ? current
            : null,
        );
        socket.sendSessionJoin({ sessionId });
        sendQueuedCommits(socket);
      },
      onClose: () => {
        sentCommitIdsRef.current.clear();
        if (socket.wasManuallyClosed) {
          setConnectionStatus("closed");
          return;
        }
        scheduleReconnectRef.current();
      },
      onSocketError: () => {
        setLastError({
          code: "WS_ERROR",
          message: "Classroom save and audio connection error.",
          at: Date.now(),
        });
      },
    });

    socket.on("translation:progress", (payload) => {
      if (payload.sessionId !== sessionId) return;
      if (!isExpectedPendingCommit(pendingCommitsRef.current, payload)) return;
      dispatchPhraseJourney({ type: "progress", payload });
    });

    socket.on("translation:committed", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const pending = pendingCommitsRef.current.get(payload.commitId);
      if (!pending) return;
      if (dispatchedCommitNosRef.current.has(payload.commitNo)) return;
      if (!isExpectedPendingCommit(pendingCommitsRef.current, payload)) {
        setLastError({
          code: "COMMIT_ACK_MISMATCH",
          message: "The classroom server returned a mismatched save acknowledgement.",
          at: Date.now(),
        });
        setPipelineStatus("error");
        return;
      }
      if (!isCanonicalTranslationCommittedPayload(payload)) {
        dispatchPhraseJourney({
          type: "rejected",
          commitId: payload.commitId,
          commitNo: payload.commitNo,
        });
        const isLatestOutcome =
          Number.isSafeInteger(payload.commitNo) &&
          payload.commitNo >= latestReviewOutcomeRef.current.commitNo;
        latestReviewOutcomeRef.current = advanceTranslationReviewOutcome(
          latestReviewOutcomeRef.current,
          payload.commitNo,
          "rejected",
        );
        if (pending) {
          pendingCommitsRef.current.delete(payload.commitId);
          sentCommitIdsRef.current.delete(payload.commitId);
          acknowledgedCommitNosRef.current.add(payload.commitNo);
          noAudioCommitNosRef.current.add(payload.commitNo);
          ttsByCommitNoRef.current.delete(payload.commitNo);
          setPendingCommitCount(pendingCommitsRef.current.size);
          flushOrderedTts();
          if (pendingCommitsRef.current.size === 0) {
            resolveDrainWaiters(true);
          }
        }
        if (isLatestOutcome) {
          setLastError({
            code: "TRANSLATION_REVIEW_FAILED",
            message: "The last phrase could not be verified. Please repeat it.",
            at: Date.now(),
          });
        }
        setPipelineStatus((previous) => {
          if (previous === "completed") return previous;
          return latestReviewOutcomeRef.current.status === "rejected"
            ? "error"
            : "idle";
        });
        return;
      }
      const isLatestOutcome =
        payload.commitNo >= latestReviewOutcomeRef.current.commitNo;
      latestReviewOutcomeRef.current = advanceTranslationReviewOutcome(
        latestReviewOutcomeRef.current,
        payload.commitNo,
        "accepted",
      );
      dispatchPhraseJourney({
        type: "committed",
        commitId: payload.commitId,
        commitNo: payload.commitNo,
        duplicate: payload.duplicate,
      });
      pendingCommitsRef.current.delete(payload.commitId);
      sentCommitIdsRef.current.delete(payload.commitId);
      acknowledgedCommitNosRef.current.add(payload.commitNo);
      if (isLatestOutcome) {
        setLastError((current) =>
          current?.code === "TRANSLATION_REVIEW_FAILED" ? null : current,
        );
      }
      setTranslations((previous) =>
        upsertCanonicalTranslation(previous, payload),
      );
      if (payload.duplicate) {
        noAudioCommitNosRef.current.add(payload.commitNo);
      }
      setPendingCommitCount(pendingCommitsRef.current.size);
      flushOrderedTts();
      if (pendingCommitsRef.current.size === 0) {
        setPipelineStatus((previous) => {
          if (previous === "completed") return previous;
          return latestReviewOutcomeRef.current.status === "rejected"
            ? "error"
            : "idle";
        });
        resolveDrainWaiters(true);
      }
    });

    socket.on("translation:rejected", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const pending = pendingCommitsRef.current.get(payload.commitId);
      if (!pending) return;
      if (!isExpectedPendingCommit(pendingCommitsRef.current, payload)) {
        setLastError({
          code: "COMMIT_REJECTION_MISMATCH",
          message: "The classroom server rejected a mismatched translation.",
          at: Date.now(),
        });
        setPipelineStatus("error");
        return;
      }
      dispatchPhraseJourney({
        type: "rejected",
        commitId: payload.commitId,
        commitNo: payload.commitNo,
      });
      pendingCommitsRef.current.delete(payload.commitId);
      sentCommitIdsRef.current.delete(payload.commitId);
      acknowledgedCommitNosRef.current.add(payload.commitNo);
      noAudioCommitNosRef.current.add(payload.commitNo);
      const isLatestOutcome =
        payload.commitNo >= latestReviewOutcomeRef.current.commitNo;
      latestReviewOutcomeRef.current = advanceTranslationReviewOutcome(
        latestReviewOutcomeRef.current,
        payload.commitNo,
        "rejected",
      );
      setPendingCommitCount(pendingCommitsRef.current.size);
      if (isLatestOutcome) {
        setLastError({
          code: payload.code,
          message: payload.message,
          at: Date.now(),
        });
      }
      setPipelineStatus((previous) => {
        if (previous === "completed") return previous;
        return latestReviewOutcomeRef.current.status === "rejected"
          ? "error"
          : "idle";
      });
      flushOrderedTts();
      if (pendingCommitsRef.current.size === 0) {
        resolveDrainWaiters(true);
      }
    });

    socket.on("tts:audio", (payload) => {
      if (payload.sessionId !== sessionId) return;
      if (!isExpectedPendingCommit(pendingCommitsRef.current, payload)) return;
      if (!payload.audioBase64 || dispatchedCommitNosRef.current.has(payload.commitNo)) {
        return;
      }
      setPipelineStatus((previous) =>
        previous === "completed" ? previous : "speaking",
      );
      ttsByCommitNoRef.current.set(payload.commitNo, payload);
      flushOrderedTts();
    });

    socket.on("session:completed", (payload) => {
      if (payload.sessionId !== sessionId) return;
      setPipelineStatus("completed");
      setCompleted(payload);
    });

    socket.on("error", (payload: ErrorPayload) => {
      if (payload.sessionId && payload.sessionId !== sessionId) return;
      if (payload.commitId !== undefined || payload.commitNo !== undefined) {
        if (
          typeof payload.commitId !== "string" ||
          typeof payload.commitNo !== "number" ||
          !isExpectedPendingCommit(pendingCommitsRef.current, {
            commitId: payload.commitId,
            commitNo: payload.commitNo,
          })
        ) {
          return;
        }
      }
      setLastError({
        code: payload.code,
        message: payload.message,
        at: Date.now(),
      });
      if (payload.code === "TTS_FAILED" && payload.commitNo) {
        noAudioCommitNosRef.current.add(payload.commitNo);
        if (payload.commitId) {
          dispatchPhraseJourney({
            type: "tts-failed",
            commitId: payload.commitId,
            commitNo: payload.commitNo,
          });
        }
        flushOrderedTts();
      }
      if (payload.code !== "TTS_FAILED") {
        if (
          typeof payload.commitId === "string" &&
          typeof payload.commitNo === "number" &&
          settleTerminalNoAudio({
            commitId: payload.commitId,
            commitNo: payload.commitNo,
          })
        ) {
          dispatchPhraseJourney({
            type: "commit-failed",
            commitId: payload.commitId,
            commitNo: payload.commitNo,
          });
        }
        setPipelineStatus((previous) =>
          previous === "completed" ? previous : "error",
        );
      }
    });

    return socket;
  }, [
    flushOrderedTts,
    resolveDrainWaiters,
    sendQueuedCommits,
    sessionId,
    settleTerminalNoAudio,
  ]);

  const connect = useCallback(() => {
    clearReconnectTimer();
    sentCommitIdsRef.current.clear();
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
          "Could not reconnect to classroom saving and English audio.",
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
    reconnectTimerRef.current = setTimeout(connect, delay);
  }, [clearReconnectTimer, connect]);

  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const sentCommitIds = sentCommitIdsRef.current;
    reconnectAttemptsRef.current = 0;
    connect();
    return () => {
      clearReconnectTimer();
      sentCommitIds.clear();
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [clearReconnectTimer, connect, enabled, sessionId]);

  useEffect(() => {
    const ttsDispatchQueue = ttsDispatchQueueRef.current;
    return () => {
      resolveDrainWaiters(false);
      if (ttsDispatchTimerRef.current !== null) {
        clearTimeout(ttsDispatchTimerRef.current);
      }
      ttsDispatchQueue.length = 0;
    };
  }, [resolveDrainWaiters]);

  const queueTranslationCommit = useCallback(
    (payload: Omit<TranslationCommitPayload, "sessionId">) => {
      const commit: TranslationCommitPayload = { ...payload, sessionId };
      dispatchPhraseJourney({
        type: "queue",
        commitId: commit.commitId,
        commitNo: commit.commitNo,
      });
      pendingCommitsRef.current.set(commit.commitId, commit);
      const isLatestOutcome =
        commit.commitNo >= latestReviewOutcomeRef.current.commitNo;
      latestReviewOutcomeRef.current = advanceTranslationReviewOutcome(
        latestReviewOutcomeRef.current,
        commit.commitNo,
        "pending",
      );
      if (isLatestOutcome) {
        setLastError((current) =>
          current?.code === "TRANSLATION_REVIEW_FAILED" ? null : current,
        );
      }
      setPendingCommitCount(pendingCommitsRef.current.size);
      const socket = socketRef.current;
      if (
        socket?.isOpen &&
        !sentCommitIdsRef.current.has(commit.commitId) &&
        socket.sendTranslationCommit(commit)
      ) {
        sentCommitIdsRef.current.add(commit.commitId);
      }
    },
    [sessionId],
  );

  const waitForCommitDrain = useCallback(
    (timeoutMs: number): Promise<boolean> => {
      if (pendingCommitsRef.current.size === 0) return Promise.resolve(true);
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

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  const reportAudioLifecycle = useCallback((event: AudioPlayerLifecycleEvent) => {
    dispatchPhraseJourney({ type: "audio", event });
  }, []);

  const resetLiveState = useCallback(() => {
    pendingCommitsRef.current.clear();
    sentCommitIdsRef.current.clear();
    acknowledgedCommitNosRef.current.clear();
    noAudioCommitNosRef.current.clear();
    dispatchedCommitNosRef.current.clear();
    ttsByCommitNoRef.current.clear();
    ttsDispatchQueueRef.current.length = 0;
    if (ttsDispatchTimerRef.current !== null) {
      clearTimeout(ttsDispatchTimerRef.current);
      ttsDispatchTimerRef.current = null;
    }
    latestReviewOutcomeRef.current = { commitNo: 0, status: "accepted" };
    setTranslations([]);
    setTtsAudio(null);
    setLastError(null);
    setCompleted(null);
    setPendingCommitCount(0);
    setPipelineStatus("idle");
    dispatchPhraseJourney({ type: "reset" });
    setAudioResetToken((current) => current + 1);
    resolveDrainWaiters(true);
  }, [resolveDrainWaiters]);

  return {
    connectionStatus,
    pipelineStatus,
    ttsAudio,
    lastError,
    completed,
    pendingCommitCount,
    translations,
    phraseJourney,
    audioResetToken,
    queueTranslationCommit,
    waitForCommitDrain,
    reportAudioLifecycle,
    resetLiveState,
    reconnect,
  };
}

export default useClassroomSocket;
