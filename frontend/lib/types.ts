/**
 * Shared TypeScript contracts mirroring every backend / WebSocket / AI-service
 * shape used by the frontend. Field names match the system contract EXACTLY.
 *
 * Language is FIXED for this product:
 *   sourceLanguage = "th-TH"
 *   targetLanguage = "en-US"
 * There is intentionally no multi-language logic anywhere.
 */

// ---------------------------------------------------------------------------
// Fixed language literals
// ---------------------------------------------------------------------------

export const SOURCE_LANGUAGE = "th-TH" as const;
export const TARGET_LANGUAGE = "en-US" as const;
export const TRANSLATION_DIRECTION = "th-to-en" as const;

export type SourceLanguage = typeof SOURCE_LANGUAGE;
export type TargetLanguage = typeof TARGET_LANGUAGE;

// ---------------------------------------------------------------------------
// REST entities
// ---------------------------------------------------------------------------

export type SessionStatus = "active" | "processing" | "completed" | "failed";

export interface ClassroomSession {
  sessionId: string;
  classroomName: string;
  speakerName: string;
  contextNote?: string;
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
  status: SessionStatus;
  startedAt?: string;
  endedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateSessionRequest {
  classroomName: string;
  speakerName: string;
  /** Optional lesson topic / story synopsis to guide translation accuracy. */
  contextNote?: string;
}

export interface ClassroomMessage {
  sessionId: string;
  sequenceNo: number;
  sourceText: string;
  translatedText: string;
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
  confidence?: number;
  audioUrl?: string;
  isFinal: boolean;
  startedAt?: string;
  endedAt?: string;
  createdAt?: string;
}

export interface ClassroomSummary {
  sessionId: string;
  summaryTh: string;
  summaryEn: string;
  keyPointsTh: string[];
  keyPointsEn: string[];
  createdAt?: string;
}

export type DifficultyLevel = string;

export interface ClassroomVocabulary {
  sessionId: string;
  word: string;
  pronunciation: string;
  partOfSpeech: string;
  meaningTh: string;
  meaningEn: string;
  exampleSentenceEn: string;
  exampleSentenceTh: string;
  difficultyLevel: DifficultyLevel;
  dictionarySource: string;
  createdAt?: string;
}

export type FlashcardType = "vocabulary" | "sentence" | "grammar";
export type FlashcardImageStatus = "pending" | "ready" | "skipped" | "failed" | "";

export interface ClassroomFlashcard {
  sessionId: string;
  front: string;
  back: string;
  type: FlashcardType;
  word: string;
  hintTh: string;
  exampleSentence: string;
  imageUrl: string;
  imageStatus: FlashcardImageStatus;
  createdAt?: string;
}

export interface HealthResponse {
  status: string;
  service: string;
}

// ---------------------------------------------------------------------------
// WebSocket envelope
// ---------------------------------------------------------------------------

export interface WsEnvelope<TEvent extends string, TPayload> {
  event: TEvent;
  payload: TPayload;
}

// --- Frontend -> Backend payloads ------------------------------------------

export interface SessionJoinPayload {
  sessionId: string;
}

export interface AudioChunkPayload {
  sessionId: string;
  /** Base64-encoded, self-contained webm/opus blob. */
  audio: string;
  mimeType: "audio/webm";
  sequenceNo: number;
}

export interface SessionEndPayload {
  sessionId: string;
}

export type ClientToServerEvent =
  | WsEnvelope<"session:join", SessionJoinPayload>
  | WsEnvelope<"audio:chunk", AudioChunkPayload>
  | WsEnvelope<"session:end", SessionEndPayload>;

// --- Backend -> Frontend payloads ------------------------------------------

export interface TranscriptPartialPayload {
  sessionId: string;
  text: string;
  language: SourceLanguage;
  isFinal: false;
}

export interface TranscriptFinalPayload {
  sessionId: string;
  text: string;
  language: SourceLanguage;
  isFinal: true;
}

export interface TranslationResultPayload {
  sessionId: string;
  sourceText: string;
  translatedText: string;
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
  /** Latency (ms) until this translation appeared: STT + translate stages. */
  sttMs?: number;
  translateMs?: number;
  latencyMs?: number;
}

export interface TtsAudioPayload {
  sessionId: string;
  text: string;
  language: TargetLanguage;
  audioUrl: string;
  audioBase64: string;
}

export interface SessionCompletedPayload {
  sessionId: string;
  summaryReady: boolean;
  vocabularyReady: boolean;
  flashcardsReady: boolean;
  flashcardImagesReady?: boolean;
  flashcardImageStatus?: "pending" | "ready" | "skipped" | "failed";
}

export interface ErrorPayload {
  sessionId: string;
  code: string;
  message: string;
}

export type ServerToClientEvent =
  | WsEnvelope<"transcript:partial", TranscriptPartialPayload>
  | WsEnvelope<"transcript:final", TranscriptFinalPayload>
  | WsEnvelope<"translation:result", TranslationResultPayload>
  | WsEnvelope<"tts:audio", TtsAudioPayload>
  | WsEnvelope<"session:completed", SessionCompletedPayload>
  | WsEnvelope<"error", ErrorPayload>;

export type ServerEventName = ServerToClientEvent["event"];

/**
 * Map of inbound event name -> its payload type. Used to build a typed
 * handler registry in the WebSocket wrapper.
 */
export interface ServerEventPayloadMap {
  "transcript:partial": TranscriptPartialPayload;
  "transcript:final": TranscriptFinalPayload;
  "translation:result": TranslationResultPayload;
  "tts:audio": TtsAudioPayload;
  "session:completed": SessionCompletedPayload;
  error: ErrorPayload;
}

// ---------------------------------------------------------------------------
// UI view models
// ---------------------------------------------------------------------------

/** A finalized Thai transcript line shown in the live transcript list. */
export interface TranscriptLine {
  id: string;
  text: string;
  isFinal: boolean;
}

/** A source/translated pairing shown in the English translation panel. */
export interface TranslationLine {
  id: string;
  sourceText: string;
  translatedText: string;
  /** Latency (ms) until this line appeared (STT + translate), for live display. */
  latencyMs?: number;
}

/** High-level pipeline status surfaced to the user during a live session. */
export type PipelineStatus =
  | "idle"
  | "listening"
  | "transcribing"
  | "translating"
  | "speaking"
  | "processing"
  | "completed"
  | "error";

/** WebSocket connection lifecycle state. */
export type ConnectionStatus =
  | "connecting"
  | "open"
  | "closed"
  | "reconnecting";

/** Microphone permission / recorder lifecycle state. */
export type RecorderStatus =
  | "idle"
  | "requesting"
  | "recording"
  | "stopped"
  | "denied"
  | "unsupported"
  | "error";

/**
 * How the microphone is driven during a live session:
 *   - "live": continuous hands-free recording, auto-segmented (~3s) for
 *     near-realtime translation.
 *   - "ptt": push-to-talk — records only while the button is held, sending one
 *     self-contained utterance per press.
 */
export type RecordingMode = "live" | "ptt";
