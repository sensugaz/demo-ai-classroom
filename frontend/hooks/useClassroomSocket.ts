"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ClassroomWebSocket } from "@/lib/websocket";
import {
  advanceTranslationReviewOutcome,
  isCanonicalTranslationCommittedPayload,
  upsertCanonicalTranslation,
} from "@/lib/canonicalTranslation";
import type { TranslationReviewOutcome } from "@/lib/canonicalTranslation";
import {
  createPhraseJourneyState,
  phraseJourneyReducer,
} from "@/lib/phraseJourney";
import type {
  AudioPlayerLifecycleEvent,
  PhraseJourneyState,
} from "@/lib/phraseJourney";
import {
  acknowledgeRealtimeCommit,
  createRealtimeCommitState,
  isCommitDrainComplete,
  isSaveDrainComplete,
  queueRealtimeCommit,
  settleRealtimeTts,
  terminateRealtimeCommit,
  unresolvedCommitById,
  unresolvedCommitLocation,
  unresolvedCommitsForResend,
} from "@/lib/realtimeCommitState";
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
  waitForSaveDrain: (timeoutMs: number) => Promise<boolean>;
  waitForCommitDrain: (timeoutMs: number) => Promise<boolean>;
  reportAudioLifecycle: (event: AudioPlayerLifecycleEvent) => void;
  resetLiveState: () => void;
  reconnect: () => void;
}

interface DrainWaiter {
  resolve: (drained: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
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
  const commitStateRef = useRef(createRealtimeCommitState());
  const sentCommitIdsRef = useRef<Set<string>>(new Set());
  const acknowledgedCommitNosRef = useRef<Set<number>>(new Set());
  const noAudioCommitNosRef = useRef<Set<number>>(new Set());
  const dispatchedCommitNosRef = useRef<Set<number>>(new Set());
  const ttsByCommitNoRef = useRef<Map<number, TtsAudioPayload>>(new Map());
  const ttsDispatchQueueRef = useRef<TtsAudioPayload[]>([]);
  const ttsDispatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsCounterRef = useRef(0);
  const saveDrainWaitersRef = useRef<Set<DrainWaiter>>(new Set());
  const commitDrainWaitersRef = useRef<Set<DrainWaiter>>(new Set());
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

  const resolveWaiters = useCallback(
    (waiters: Set<DrainWaiter>, drained: boolean) => {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(drained);
      }
      waiters.clear();
    },
    [],
  );

  const resolveReadyDrainWaiters = useCallback(() => {
    const state = commitStateRef.current;
    if (isSaveDrainComplete(state)) {
      resolveWaiters(saveDrainWaitersRef.current, true);
    }
    if (isCommitDrainComplete(state)) {
      resolveWaiters(commitDrainWaitersRef.current, true);
    }
  }, [resolveWaiters]);

  const resolveAllDrainWaiters = useCallback(
    (drained: boolean) => {
      resolveWaiters(saveDrainWaitersRef.current, drained);
      resolveWaiters(commitDrainWaitersRef.current, drained);
    },
    [resolveWaiters],
  );

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
    for (const commit of commitStateRef.current.pendingSave.values()) {
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
      const transition = terminateRealtimeCommit(commitStateRef.current, identity);
      if (!transition.location) return false;

      commitStateRef.current = transition.state;
      sentCommitIdsRef.current.delete(identity.commitId);
      acknowledgedCommitNosRef.current.add(identity.commitNo);
      noAudioCommitNosRef.current.add(identity.commitNo);
      ttsByCommitNoRef.current.delete(identity.commitNo);
      setPendingCommitCount(commitStateRef.current.pendingSave.size);
      flushOrderedTts();
      resolveReadyDrainWaiters();

      return true;
    },
    [flushOrderedTts, resolveReadyDrainWaiters],
  );

  const settleTtsOutcome = useCallback(
    (identity: { commitId: string; commitNo: number }): boolean => {
      const transition = settleRealtimeTts(commitStateRef.current, identity);
      if (!transition.location) return false;

      commitStateRef.current = transition.state;
      setPendingCommitCount(commitStateRef.current.pendingSave.size);
      resolveReadyDrainWaiters();
      return true;
    },
    [resolveReadyDrainWaiters],
  );

  const sendQueuedCommits = useCallback((socket: ClassroomWebSocket) => {
    const commits = unresolvedCommitsForResend(commitStateRef.current);
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
      if (!unresolvedCommitLocation(commitStateRef.current, payload)) return;
      dispatchPhraseJourney({ type: "progress", payload });
    });

    socket.on("translation:committed", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const known = unresolvedCommitById(commitStateRef.current, payload.commitId);
      if (!known) return;
      if (known.commitNo !== payload.commitNo) {
        setLastError({
          code: "COMMIT_ACK_MISMATCH",
          message: "The classroom server returned a mismatched save acknowledgement.",
          at: Date.now(),
        });
        setPipelineStatus("error");
        return;
      }
      if (!isCanonicalTranslationCommittedPayload(payload)) {
        if (
          unresolvedCommitLocation(commitStateRef.current, payload) !==
          "pending-save"
        ) {
          return;
        }
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
        settleTerminalNoAudio(payload);
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

      const acknowledged = acknowledgeRealtimeCommit(
        commitStateRef.current,
        payload,
      );
      if (!acknowledged.location) return;
      commitStateRef.current = acknowledged.state;
      sentCommitIdsRef.current.delete(payload.commitId);
      acknowledgedCommitNosRef.current.add(payload.commitNo);

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
      if (isLatestOutcome) {
        setLastError((current) =>
          current?.code === "TRANSLATION_REVIEW_FAILED" ? null : current,
        );
      }
      setTranslations((previous) =>
        upsertCanonicalTranslation(previous, payload),
      );
      if (
        ttsByCommitNoRef.current.has(payload.commitNo) ||
        noAudioCommitNosRef.current.has(payload.commitNo)
      ) {
        settleTtsOutcome(payload);
      }
      setPendingCommitCount(commitStateRef.current.pendingSave.size);
      flushOrderedTts();
      resolveReadyDrainWaiters();
      if (isSaveDrainComplete(commitStateRef.current)) {
        setPipelineStatus((previous) => {
          if (previous === "completed") return previous;
          return latestReviewOutcomeRef.current.status === "rejected"
            ? "error"
            : "idle";
        });
      }
    });

    socket.on("translation:rejected", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const known = unresolvedCommitById(commitStateRef.current, payload.commitId);
      if (!known) return;
      if (known.commitNo !== payload.commitNo) {
        setLastError({
          code: "COMMIT_REJECTION_MISMATCH",
          message: "The classroom server rejected a mismatched translation.",
          at: Date.now(),
        });
        setPipelineStatus("error");
        return;
      }
      if (
        unresolvedCommitLocation(commitStateRef.current, payload) !==
        "pending-save"
      ) {
        return;
      }
      dispatchPhraseJourney({
        type: "rejected",
        commitId: payload.commitId,
        commitNo: payload.commitNo,
      });
      commitStateRef.current = terminateRealtimeCommit(
        commitStateRef.current,
        payload,
      ).state;
      sentCommitIdsRef.current.delete(payload.commitId);
      acknowledgedCommitNosRef.current.add(payload.commitNo);
      noAudioCommitNosRef.current.add(payload.commitNo);
      ttsByCommitNoRef.current.delete(payload.commitNo);
      const isLatestOutcome =
        payload.commitNo >= latestReviewOutcomeRef.current.commitNo;
      latestReviewOutcomeRef.current = advanceTranslationReviewOutcome(
        latestReviewOutcomeRef.current,
        payload.commitNo,
        "rejected",
      );
      setPendingCommitCount(commitStateRef.current.pendingSave.size);
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
      resolveReadyDrainWaiters();
    });

    socket.on("tts:audio", (payload) => {
      if (payload.sessionId !== sessionId) return;
      if (!unresolvedCommitLocation(commitStateRef.current, payload)) return;
      if (
        !payload.audioBase64 ||
        dispatchedCommitNosRef.current.has(payload.commitNo) ||
        noAudioCommitNosRef.current.has(payload.commitNo) ||
        ttsByCommitNoRef.current.has(payload.commitNo)
      ) {
        return;
      }
      setPipelineStatus((previous) =>
        previous === "completed" ? previous : "speaking",
      );
      ttsByCommitNoRef.current.set(payload.commitNo, payload);
      settleTtsOutcome(payload);
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
          !unresolvedCommitLocation(commitStateRef.current, {
            commitId: payload.commitId,
            commitNo: payload.commitNo,
          })
        ) {
          return;
        }
      }
      if (
        payload.code === "TTS_FAILED" &&
        typeof payload.commitNo === "number" &&
        ttsByCommitNoRef.current.has(payload.commitNo)
      ) {
        return;
      }
      setLastError({
        code: payload.code,
        message: payload.message,
        at: Date.now(),
      });
      if (
        payload.code === "TTS_FAILED" &&
        typeof payload.commitId === "string" &&
        typeof payload.commitNo === "number"
      ) {
        ttsByCommitNoRef.current.delete(payload.commitNo);
        noAudioCommitNosRef.current.add(payload.commitNo);
        settleTtsOutcome({
          commitId: payload.commitId,
          commitNo: payload.commitNo,
        });
        dispatchPhraseJourney({
          type: "tts-failed",
          commitId: payload.commitId,
          commitNo: payload.commitNo,
        });
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
    resolveReadyDrainWaiters,
    sendQueuedCommits,
    sessionId,
    settleTerminalNoAudio,
    settleTtsOutcome,
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
      resolveAllDrainWaiters(false);
      if (ttsDispatchTimerRef.current !== null) {
        clearTimeout(ttsDispatchTimerRef.current);
      }
      ttsDispatchQueue.length = 0;
    };
  }, [resolveAllDrainWaiters]);

  const queueTranslationCommit = useCallback(
    (payload: Omit<TranslationCommitPayload, "sessionId">) => {
      const commit: TranslationCommitPayload = { ...payload, sessionId };
      dispatchPhraseJourney({
        type: "queue",
        commitId: commit.commitId,
        commitNo: commit.commitNo,
      });
      commitStateRef.current = queueRealtimeCommit(commitStateRef.current, commit);
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
      setPendingCommitCount(commitStateRef.current.pendingSave.size);
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

  const waitForSaveDrain = useCallback(
    (timeoutMs: number): Promise<boolean> => {
      if (isSaveDrainComplete(commitStateRef.current)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const waiter: DrainWaiter = {
          resolve,
          timer: setTimeout(() => {
            saveDrainWaitersRef.current.delete(waiter);
            resolve(false);
          }, Math.max(0, timeoutMs)),
        };
        saveDrainWaitersRef.current.add(waiter);
      });
    },
    [],
  );

  const waitForCommitDrain = useCallback(
    (timeoutMs: number): Promise<boolean> => {
      if (isCommitDrainComplete(commitStateRef.current)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const waiter: DrainWaiter = {
          resolve,
          timer: setTimeout(() => {
            commitDrainWaitersRef.current.delete(waiter);
            resolve(false);
          }, Math.max(0, timeoutMs)),
        };
        commitDrainWaitersRef.current.add(waiter);
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
    commitStateRef.current = createRealtimeCommitState();
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
    resolveAllDrainWaiters(true);
  }, [resolveAllDrainWaiters]);

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
    waitForSaveDrain,
    waitForCommitDrain,
    reportAudioLifecycle,
    resetLiveState,
    reconnect,
  };
}

export default useClassroomSocket;
