/**
 * Typed REST client for the backend.
 *
 * Base URL comes from NEXT_PUBLIC_API_BASE_URL (e.g. http://localhost:3001).
 * All endpoints return JSON. Errors are normalized into ApiError so callers
 * get a consistent shape to render.
 */

import type {
  ClassroomFlashcard,
  ClassroomMessage,
  ClassroomSession,
  ClassroomSummary,
  ClassroomVocabulary,
  CreateSessionRequest,
  HealthResponse,
  RealtimeTokenResponse,
  UpdateSummaryRequest,
} from "./types";

const DEFAULT_API_BASE_URL = "http://localhost:3001";

export function getApiBaseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (fromEnv && fromEnv.trim()) {
    // Explicit override (e.g. a separate API host). Strip trailing slash.
    return fromEnv.trim().replace(/\/+$/, "");
  }
  // Default: same-origin. In the browser, return "" so requests go to the
  // current origin (e.g. https://your-domain/api/...) and are routed to the
  // backend by the nginx reverse proxy — no per-domain rebuild, no CORS.
  if (typeof window !== "undefined") {
    return "";
  }
  // SSR / build (no window): fall back to the local backend.
  return DEFAULT_API_BASE_URL;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  signal?: AbortSignal;
}

async function request<TResponse>(
  path: string,
  options: RequestOptions = {},
): Promise<TResponse> {
  const { method = "GET", body, signal } = options;
  const url = `${getApiBaseUrl()}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw cause;
    }
    throw new ApiError(
      `Network request to ${url} failed. Is the backend running?`,
      0,
      cause,
    );
  }

  const rawText = await response.text();
  let parsed: unknown = undefined;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = rawText;
    }
  }

  if (!response.ok) {
    const message =
      extractErrorMessage(parsed) ||
      `Request to ${path} failed with status ${response.status}`;
    throw new ApiError(message, response.status, parsed);
  }

  return unwrapEnvelope<TResponse>(parsed);
}

/**
 * Backend success responses are wrapped as { success: true, data: <payload> }.
 * Bare responses (e.g. /health) are returned as-is. This unwraps the envelope
 * when present so callers receive the entity directly.
 */
function unwrapEnvelope<T>(parsed: unknown): T {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "success" in parsed &&
    "data" in parsed
  ) {
    return (parsed as { data: T }).data;
  }
  return parsed as T;
}

/**
 * Backend error responses are wrapped as { success: false, error: { code, message } }.
 * Falls back to a bare { message } for resilience.
 */
function extractErrorMessage(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const err = obj.error;
  if (
    typeof err === "object" &&
    err !== null &&
    typeof (err as Record<string, unknown>).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  if (typeof obj.message === "string") {
    return obj.message;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  health(signal?: AbortSignal): Promise<HealthResponse> {
    return request<HealthResponse>("/health", { signal });
  },

  createSession(
    payload: CreateSessionRequest,
    signal?: AbortSignal,
  ): Promise<ClassroomSession> {
    return request<ClassroomSession>("/api/classroom-sessions", {
      method: "POST",
      body: payload,
      signal,
    });
  },

  async listSessions(signal?: AbortSignal): Promise<ClassroomSession[]> {
    return (
      (await request<ClassroomSession[] | null>("/api/classroom-sessions", {
        signal,
      })) ?? []
    );
  },

  getSession(sessionId: string, signal?: AbortSignal): Promise<ClassroomSession> {
    return request<ClassroomSession>(
      `/api/classroom-sessions/${encodeURIComponent(sessionId)}`,
      { signal },
    );
  },

  endSession(sessionId: string, signal?: AbortSignal): Promise<ClassroomSession> {
    return request<ClassroomSession>(
      `/api/classroom-sessions/${encodeURIComponent(sessionId)}/end`,
      { method: "POST", signal },
    );
  },

  createRealtimeToken(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<RealtimeTokenResponse> {
    return request<RealtimeTokenResponse>(
      `/api/classroom-sessions/${encodeURIComponent(sessionId)}/realtime-translation/client-secret`,
      { method: "POST", signal },
    );
  },

  resetSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return request<unknown>(
      `/api/classroom-sessions/${encodeURIComponent(sessionId)}/reset`,
      { method: "POST", signal },
    );
  },

  async getMessages(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ClassroomMessage[]> {
    return (
      (await request<ClassroomMessage[] | null>(
        `/api/classroom-sessions/${encodeURIComponent(sessionId)}/messages`,
        { signal },
      )) ?? []
    );
  },

  getSummary(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ClassroomSummary> {
    return request<ClassroomSummary>(
      `/api/classroom-sessions/${encodeURIComponent(sessionId)}/summary`,
      { signal },
    );
  },

  updateSummary(
    sessionId: string,
    payload: UpdateSummaryRequest,
    signal?: AbortSignal,
  ): Promise<ClassroomSummary> {
    return request<ClassroomSummary>(
      `/api/classroom-sessions/${encodeURIComponent(sessionId)}/summary`,
      { method: "PUT", body: payload, signal },
    );
  },

  async getVocabularies(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ClassroomVocabulary[]> {
    return (
      (await request<ClassroomVocabulary[] | null>(
        `/api/classroom-sessions/${encodeURIComponent(sessionId)}/vocabularies`,
        { signal },
      )) ?? []
    );
  },

  async getFlashcards(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ClassroomFlashcard[]> {
    return (
      (await request<ClassroomFlashcard[] | null>(
        `/api/classroom-sessions/${encodeURIComponent(sessionId)}/flashcards`,
        { signal },
      )) ?? []
    );
  },
};
