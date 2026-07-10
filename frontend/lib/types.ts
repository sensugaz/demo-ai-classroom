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
export type TtsVoiceProfile =
  | "child_girl"
  | "child_boy"
  | "adult_woman"
  | "adult_man";
export type TtsSpeechSpeed = "slow" | "medium" | "fast";
export const REALTIME_TRANSLATION_MODEL = "gpt-realtime-translate" as const;
export const REALTIME_TRANSCRIPTION_MODEL = "gpt-realtime-whisper" as const;

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

/** Short-lived browser credential minted by the backend for one translation call. */
export interface RealtimeTokenResponse {
  clientSecret: string;
  expiresAt: number;
  translationSessionId: string;
  lastCommitNo: number;
  model: typeof REALTIME_TRANSLATION_MODEL;
  targetLanguage: TargetLanguage;
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

export interface UpdateSummaryRequest {
  summaryTh: string;
  summaryEn: string;
  keyPointsTh: string[];
  keyPointsEn: string[];
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

export interface TranslationCommitPayload {
  sessionId: string;
  translationSessionId: string;
  commitId: string;
  commitNo: number;
  commitKind: "debounced" | "final";
  sourceText: string;
  translatedText: string;
  sourceElapsedMs: number;
  targetElapsedMs: number;
  voiceProfile: TtsVoiceProfile;
  speechSpeed: TtsSpeechSpeed;
}

export type ClientToServerEvent =
  | WsEnvelope<"session:join", SessionJoinPayload>
  | WsEnvelope<"translation:commit", TranslationCommitPayload>;

// --- Backend -> Frontend payloads ------------------------------------------

export interface TtsAudioPayload {
  sessionId: string;
  commitId: string;
  commitNo: number;
  sequenceNo: number;
  text: string;
  language: TargetLanguage;
  audioUrl: string;
  audioBase64: string;
  voiceProfile?: TtsVoiceProfile;
  speechSpeed?: TtsSpeechSpeed;
  playbackRate?: number;
}

export interface TranslationCommittedPayload {
  sessionId: string;
  commitId: string;
  commitNo: number;
  commitKind: "debounced" | "final";
  sequenceNo: number;
  duplicate: boolean;
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
  commitId?: string;
  commitNo?: number;
  code: string;
  message: string;
}

export type ServerToClientEvent =
  | WsEnvelope<"translation:committed", TranslationCommittedPayload>
  | WsEnvelope<"tts:audio", TtsAudioPayload>
  | WsEnvelope<"session:completed", SessionCompletedPayload>
  | WsEnvelope<"error", ErrorPayload>;

export type ServerEventName = ServerToClientEvent["event"];

/**
 * Map of inbound event name -> its payload type. Used to build a typed
 * handler registry in the WebSocket wrapper.
 */
export interface ServerEventPayloadMap {
  "translation:committed": TranslationCommittedPayload;
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
  sequenceNo?: number;
  text: string;
  isFinal: boolean;
}

/** A source/translated pairing shown in the English translation panel. */
export interface TranslationLine {
  id: string;
  sequenceNo?: number;
  sourceText: string;
  translatedText: string;
  isFinal: boolean;
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

/**
 * How the microphone is driven during a live session:
 *   - "live": tap to pause/resume the long-lived WebRTC microphone track.
 *   - "ptt": enable the same track only while the control is held.
 */
export type RecordingMode = "live" | "ptt";

/** Browser-to-OpenAI peer connection lifecycle. */
export type RealtimeConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

/** Microphone track lifecycle inside a long-lived WebRTC translation call. */
export type RealtimeCaptureStatus =
  | "idle"
  | "requesting"
  | "paused"
  | "active"
  | "closing"
  | "closed"
  | "denied"
  | "unsupported"
  | "error";

export interface RealtimeTranscriptDeltaEvent {
  type: "session.input_transcript.delta" | "session.output_transcript.delta";
  delta: string;
  event_id: string;
  elapsed_ms?: number | null;
}

export interface RealtimeSessionClosedEvent {
  type: "session.closed";
  event_id?: string;
}

export interface RealtimeErrorEvent {
  type: "error";
  event_id?: string;
  error?: {
    code?: string;
    message?: string;
  };
}

export type RealtimeServerEvent =
  | RealtimeTranscriptDeltaEvent
  | RealtimeSessionClosedEvent
  | RealtimeErrorEvent
  | { type: string; [key: string]: unknown };
