// Package websocket implements the realtime transport: hub, clients, and the event protocol.
package websocket

import (
	"encoding/json"
	"fmt"

	"github.com/ai-classroom/backend/internal/classroom"
)

// Inbound (frontend -> backend) event names.
const (
	EventSessionJoin = "session:join"
	EventAudioChunk  = "audio:chunk"
	EventSessionEnd  = "session:end"
)

// Outbound (backend -> frontend) event names.
const (
	EventTranscriptPartial = "transcript:partial"
	EventTranscriptFinal   = "transcript:final"
	EventTranslationResult = "translation:result"
	EventTTSAudio          = "tts:audio"
	EventAudioProcessed    = "audio:processed"
	EventSessionCompleted  = "session:completed"
	EventError             = "error"
)

// Error codes emitted on the error event.
const (
	ErrCodeInvalidPayload  = "INVALID_PAYLOAD"
	ErrCodeSessionUnknown  = "SESSION_UNKNOWN"
	ErrCodeAudioTooLarge   = "AUDIO_TOO_LARGE"
	ErrCodeSTTFailed       = "STT_FAILED"
	ErrCodeTranslateFailed = "TRANSLATE_FAILED"
	ErrCodeTTSFailed       = "TTS_FAILED"
	ErrCodeFinalizeFailed  = "FINALIZE_FAILED"
	ErrCodeInternal        = "INTERNAL_ERROR"
)

// Envelope is the wire format for every WebSocket message in both directions.
type Envelope struct {
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload"`
}

// --- Inbound payloads ---

// SessionJoinPayload binds a connection to a session.
type SessionJoinPayload struct {
	SessionID string `json:"sessionId"`
}

// AudioChunkPayload carries a self-contained webm audio blob.
type AudioChunkPayload struct {
	SessionID    string `json:"sessionId"`
	Audio        string `json:"audio"`
	MimeType     string `json:"mimeType"`
	SequenceNo   int    `json:"sequenceNo"`
	VoiceProfile string `json:"voiceProfile,omitempty"`
	SpeechSpeed  string `json:"speechSpeed,omitempty"`
}

// SessionEndPayload requests finalization for a session.
type SessionEndPayload struct {
	SessionID string `json:"sessionId"`
}

// --- Outbound payloads ---

// TranscriptPayload carries partial or final STT text.
type TranscriptPayload struct {
	SessionID  string `json:"sessionId"`
	SequenceNo int    `json:"sequenceNo,omitempty"`
	Text       string `json:"text"`
	Language   string `json:"language"`
	IsFinal    bool   `json:"isFinal"`
}

// TranslationResultPayload carries a translated utterance.
type TranslationResultPayload struct {
	SessionID      string `json:"sessionId"`
	SequenceNo     int    `json:"sequenceNo,omitempty"`
	SourceText     string `json:"sourceText"`
	TranslatedText string `json:"translatedText"`
	SourceLanguage string `json:"sourceLanguage"`
	TargetLanguage string `json:"targetLanguage"`
	// Latency (ms) until this translation appeared: STT + translate stages.
	SttMs       int64 `json:"sttMs"`
	TranslateMs int64 `json:"translateMs"`
	LatencyMs   int64 `json:"latencyMs"`
}

// TTSAudioPayload carries synthesized English audio.
type TTSAudioPayload struct {
	SessionID    string  `json:"sessionId"`
	SequenceNo   int     `json:"sequenceNo"`
	Text         string  `json:"text"`
	Language     string  `json:"language"`
	AudioURL     string  `json:"audioUrl"`
	AudioBase64  string  `json:"audioBase64"`
	VoiceProfile string  `json:"voiceProfile,omitempty"`
	SpeechSpeed  string  `json:"speechSpeed,omitempty"`
	PlaybackRate float64 `json:"playbackRate,omitempty"`
}

// AudioProcessedPayload acknowledges that processing for one valid chunk has ended.
type AudioProcessedPayload struct {
	SessionID  string `json:"sessionId"`
	SequenceNo int    `json:"sequenceNo"`
}

// SessionCompletedPayload signals finalization readiness flags.
type SessionCompletedPayload struct {
	SessionID            string `json:"sessionId"`
	SummaryReady         bool   `json:"summaryReady"`
	VocabularyReady      bool   `json:"vocabularyReady"`
	FlashcardsReady      bool   `json:"flashcardsReady"`
	FlashcardImagesReady bool   `json:"flashcardImagesReady"`
	FlashcardImageStatus string `json:"flashcardImageStatus"`
}

// ErrorPayload carries a structured error to the client.
type ErrorPayload struct {
	SessionID string `json:"sessionId"`
	Code      string `json:"code"`
	Message   string `json:"message"`
}

// NewEnvelope marshals payload and wraps it in an Envelope as raw JSON bytes.
func NewEnvelope(event string, payload any) ([]byte, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal %s payload: %w", event, err)
	}
	return json.Marshal(Envelope{Event: event, Payload: raw})
}

// MustEnvelope is NewEnvelope for payloads known to marshal cleanly (typed structs).
// It falls back to a plain error envelope if marshaling ever fails, so callers can
// always obtain a sendable frame.
func MustEnvelope(event string, payload any) []byte {
	b, err := NewEnvelope(event, payload)
	if err != nil {
		fallback, _ := json.Marshal(Envelope{
			Event:   EventError,
			Payload: json.RawMessage(fmt.Sprintf(`{"code":%q,"message":"failed to encode %s"}`, ErrCodeInternal, event)),
		})
		return fallback
	}
	return b
}

// errorFrame builds a single error wire frame.
func errorFrame(sessionID, code, message string) []byte {
	return MustEnvelope(EventError, ErrorPayload{SessionID: sessionID, Code: code, Message: message})
}

// frameFromPipelineEvent maps a transport-agnostic domain event onto a wire frame.
// This is the single boundary where domain events become WebSocket envelopes.
func frameFromPipelineEvent(e classroom.PipelineEvent) []byte {
	switch e.Type {
	case classroom.PipelineTranscriptFinal:
		return MustEnvelope(EventTranscriptFinal, TranscriptPayload{
			SessionID:  e.SessionID,
			SequenceNo: e.SequenceNo,
			Text:       e.SourceText,
			Language:   classroom.SourceLanguage,
			IsFinal:    true,
		})
	case classroom.PipelineTranslation:
		return MustEnvelope(EventTranslationResult, TranslationResultPayload{
			SessionID:      e.SessionID,
			SequenceNo:     e.SequenceNo,
			SourceText:     e.SourceText,
			TranslatedText: e.TranslatedText,
			SourceLanguage: classroom.SourceLanguage,
			TargetLanguage: classroom.TargetLanguage,
			SttMs:          e.SttMs,
			TranslateMs:    e.TranslateMs,
			LatencyMs:      e.SttMs + e.TranslateMs,
		})
	case classroom.PipelineTTSAudio:
		return MustEnvelope(EventTTSAudio, TTSAudioPayload{
			SessionID:    e.SessionID,
			SequenceNo:   e.SequenceNo,
			Text:         e.TTSText,
			Language:     classroom.TargetLanguage,
			AudioURL:     e.AudioURL,
			AudioBase64:  e.AudioBase64,
			VoiceProfile: e.VoiceProfile,
			SpeechSpeed:  e.SpeechSpeed,
			PlaybackRate: e.PlaybackRate,
		})
	case classroom.PipelineError:
		return errorFrame(e.SessionID, e.Code, e.Message)
	default:
		return errorFrame(e.SessionID, ErrCodeInternal, "unknown pipeline event")
	}
}
