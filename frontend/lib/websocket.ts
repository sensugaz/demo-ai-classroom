/**
 * Thin, typed wrapper around the native WebSocket.
 *
 * Responsibilities:
 *  - Encode outbound envelopes { event, payload }.
 *  - Decode inbound envelopes and dispatch to typed, per-event handlers.
 *  - Surface open / close / error lifecycle callbacks.
 *
 * Reconnection and higher-level session orchestration live in the
 * useClassroomSocket hook; this wrapper only owns one socket instance.
 */

import type {
  ClientToServerEvent,
  ServerEventName,
  ServerEventPayloadMap,
  ServerToClientEvent,
  SessionJoinPayload,
  TranslationCommitPayload,
} from "./types";

const DEFAULT_WS_URL = "ws://localhost:3001/ws";

export function getWsUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_WS_URL;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  // Default: same-origin WebSocket via the nginx proxy. Picks ws:// or wss://
  // automatically from the page protocol, so TLS works with no rebuild.
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }
  return DEFAULT_WS_URL;
}

export type ServerEventHandler<E extends ServerEventName> = (
  payload: ServerEventPayloadMap[E],
) => void;

export interface ClassroomWebSocketCallbacks {
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onSocketError?: (event: Event) => void;
  /** Fired when a message arrives that we could not parse / route. */
  onUnknownMessage?: (raw: string) => void;
}

export class ClassroomWebSocket {
  private socket: WebSocket | null = null;
  private readonly url: string;
  private readonly callbacks: ClassroomWebSocketCallbacks;
  private readonly handlers: {
    [E in ServerEventName]?: Set<ServerEventHandler<E>>;
  } = {};
  private manualClose = false;

  constructor(callbacks: ClassroomWebSocketCallbacks = {}, url: string = getWsUrl()) {
    this.url = url;
    this.callbacks = callbacks;
  }

  get readyState(): number {
    return this.socket?.readyState ?? WebSocket.CLOSED;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    // Avoid stacking sockets if already connecting/open.
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.manualClose = false;
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.callbacks.onOpen?.();
    };

    socket.onclose = (event) => {
      this.callbacks.onClose?.(event);
    };

    socket.onerror = (event) => {
      this.callbacks.onSocketError?.(event);
    };

    socket.onmessage = (event) => {
      this.handleRawMessage(event.data);
    };
  }

  private handleRawMessage(data: unknown): void {
    if (typeof data !== "string") {
      this.callbacks.onUnknownMessage?.(String(data));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.callbacks.onUnknownMessage?.(data);
      return;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("event" in parsed) ||
      !("payload" in parsed)
    ) {
      this.callbacks.onUnknownMessage?.(data);
      return;
    }

    const envelope = parsed as ServerToClientEvent;
    this.dispatch(envelope);
  }

  private dispatch(envelope: ServerToClientEvent): void {
    const name = envelope.event;
    const set = this.handlers[name] as
      | Set<ServerEventHandler<typeof name>>
      | undefined;
    if (!set || set.size === 0) {
      return;
    }
    // The envelope union guarantees payload matches the event name.
    for (const handler of set) {
      handler(envelope.payload as ServerEventPayloadMap[typeof name]);
    }
  }

  /** Register a typed handler for a server event. Returns an unsubscribe fn. */
  on<E extends ServerEventName>(
    event: E,
    handler: ServerEventHandler<E>,
  ): () => void {
    let set = this.handlers[event] as Set<ServerEventHandler<E>> | undefined;
    if (!set) {
      set = new Set<ServerEventHandler<E>>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.handlers as any)[event] = set;
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  private send(envelope: ClientToServerEvent): boolean {
    if (!this.isOpen || !this.socket) {
      return false;
    }
    this.socket.send(JSON.stringify(envelope));
    return true;
  }

  sendSessionJoin(payload: SessionJoinPayload): boolean {
    return this.send({ event: "session:join", payload });
  }

  sendTranslationCommit(payload: TranslationCommitPayload): boolean {
    return this.send({ event: "translation:commit", payload });
  }

  /** True if the socket was closed by an explicit close() call. */
  get wasManuallyClosed(): boolean {
    return this.manualClose;
  }

  close(code?: number, reason?: string): void {
    this.manualClose = true;
    if (this.socket) {
      try {
        this.socket.close(code, reason);
      } catch {
        // ignore close errors
      }
    }
    this.socket = null;
  }
}
