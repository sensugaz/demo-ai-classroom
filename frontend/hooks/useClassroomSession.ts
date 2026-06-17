"use client";

/**
 * REST-side session hook. Wraps lib/api with React state for loading/error
 * handling and exposes imperative helpers for create / get / list / end and
 * for fetching the post-session artifacts (messages, summary, vocab, flashcards).
 *
 * Each fetch tracks its own abort controller so unmounts / re-fetches cancel
 * in-flight requests.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";
import type {
  ClassroomFlashcard,
  ClassroomMessage,
  ClassroomSession,
  ClassroomSummary,
  ClassroomVocabulary,
  CreateSessionRequest,
} from "@/lib/types";

function toMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

interface AsyncState {
  loading: boolean;
  error: string | null;
}

const initialAsync: AsyncState = { loading: false, error: null };

export function useClassroomSession() {
  const [createState, setCreateState] = useState<AsyncState>(initialAsync);
  const [listState, setListState] = useState<AsyncState>(initialAsync);
  const [sessions, setSessions] = useState<ClassroomSession[]>([]);

  const abortControllers = useRef<Set<AbortController>>(new Set());

  useEffect(() => {
    const controllers = abortControllers.current;
    return () => {
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);

  const withController = useCallback(
    async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      abortControllers.current.add(controller);
      try {
        return await fn(controller.signal);
      } finally {
        abortControllers.current.delete(controller);
      }
    },
    [],
  );

  const createSession = useCallback(
    async (payload: CreateSessionRequest): Promise<ClassroomSession | null> => {
      setCreateState({ loading: true, error: null });
      try {
        const session = await withController((signal) =>
          api.createSession(payload, signal),
        );
        setCreateState({ loading: false, error: null });
        return session;
      } catch (error) {
        if (isAbort(error)) return null;
        setCreateState({ loading: false, error: toMessage(error) });
        return null;
      }
    },
    [withController],
  );

  const refreshSessions = useCallback(async (): Promise<void> => {
    setListState({ loading: true, error: null });
    try {
      const list = await withController((signal) => api.listSessions(signal));
      setSessions(Array.isArray(list) ? list : []);
      setListState({ loading: false, error: null });
    } catch (error) {
      if (isAbort(error)) return;
      setListState({ loading: false, error: toMessage(error) });
    }
  }, [withController]);

  const getSession = useCallback(
    (sessionId: string): Promise<ClassroomSession> =>
      withController((signal) => api.getSession(sessionId, signal)),
    [withController],
  );

  const endSession = useCallback(
    (sessionId: string): Promise<ClassroomSession> =>
      withController((signal) => api.endSession(sessionId, signal)),
    [withController],
  );

  const getMessages = useCallback(
    (sessionId: string): Promise<ClassroomMessage[]> =>
      withController((signal) => api.getMessages(sessionId, signal)),
    [withController],
  );

  const getSummary = useCallback(
    (sessionId: string): Promise<ClassroomSummary> =>
      withController((signal) => api.getSummary(sessionId, signal)),
    [withController],
  );

  const getVocabularies = useCallback(
    (sessionId: string): Promise<ClassroomVocabulary[]> =>
      withController((signal) => api.getVocabularies(sessionId, signal)),
    [withController],
  );

  const getFlashcards = useCallback(
    (sessionId: string): Promise<ClassroomFlashcard[]> =>
      withController((signal) => api.getFlashcards(sessionId, signal)),
    [withController],
  );

  return {
    // create
    createSession,
    createLoading: createState.loading,
    createError: createState.error,
    // list
    sessions,
    refreshSessions,
    listLoading: listState.loading,
    listError: listState.error,
    // single
    getSession,
    endSession,
    // artifacts
    getMessages,
    getSummary,
    getVocabularies,
    getFlashcards,
  };
}
