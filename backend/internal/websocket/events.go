// Package websocket implements the realtime transport: hub, clients, and the event protocol.
package websocket

import (
	"encoding/json"
	"fmt"

	"github.com/ai-classroom/backend/internal/classroom"
)

// Inbound (frontend -> backend) event names.
const (
	EventSessionJoin       = "session:join"
	EventTranslationCommit = "translation:commit"
	EventSessionEnd        = "session:end"
)

// Outbound (backend -> frontend) event names.
const (
	EventTranslationCommitted = "translation:committed"
	EventTranslationRejected  = "translation:rejected"
	EventTTSAudio             = "tts:audio"
	EventSessionCompleted     = "session:completed"
	EventError                = "error"
)

// Error codes emitted on the error event.
const (
	ErrCodeInvalidPayload          = "INVALID_PAYLOAD"
	ErrCodeSessionUnknown          = "SESSION_UNKNOWN"
	ErrCodeSessionInactive         = "SESSION_NOT_ACTIVE"
	ErrCodeCommitConflict          = "COMMIT_CONFLICT"
	ErrCodeTranslationReviewFailed = "TRANSLATION_REVIEW_FAILED"
	ErrCodeTTSFailed               = "TTS_FAILED"
	ErrCodeFinalizeFailed          = "FINALIZE_FAILED"
	ErrCodeInternal                = "INTERNAL_ERROR"
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

// TranslationCommitPayload carries one immutable pair of append-only text slices.
type TranslationCommitPayload struct {
	SessionID            string                          `json:"sessionId"`
	TranslationSessionId string                          `json:"translationSessionId"`
	CommitId             string                          `json:"commitId"`
	CommitNo             int                             `json:"commitNo"`
	CommitKind           classroom.TranslationCommitKind `json:"commitKind"`
	SourceText           string                          `json:"sourceText"`
	TranslatedText       string                          `json:"translatedText"`
	SourceElapsedMs      int64                           `json:"sourceElapsedMs"`
	TargetElapsedMs      int64                           `json:"targetElapsedMs"`
	VoiceProfile         string                          `json:"voiceProfile,omitempty"`
	SpeechSpeed          string                          `json:"speechSpeed,omitempty"`
}

// SessionEndPayload requests finalization for a session.
type SessionEndPayload struct {
	SessionID string `json:"sessionId"`
}

// --- Outbound payloads ---

// TranslationCommittedPayload acknowledges durable, idempotent persistence.
type TranslationCommittedPayload struct {
	SessionID      string                            `json:"sessionId"`
	CommitId       string                            `json:"commitId"`
	CommitNo       int                               `json:"commitNo"`
	CommitKind     classroom.TranslationCommitKind   `json:"commitKind"`
	SequenceNo     int                               `json:"sequenceNo"`
	Duplicate      bool                              `json:"duplicate"`
	SourceText     string                            `json:"sourceText"`
	TranslatedText string                            `json:"translatedText"`
	ReviewStatus   classroom.TranslationReviewStatus `json:"reviewStatus"`
}

// TranslationRejectedPayload terminates one unsafe commit without persistence.
type TranslationRejectedPayload struct {
	SessionID  string                          `json:"sessionId"`
	CommitId   string                          `json:"commitId"`
	CommitNo   int                             `json:"commitNo"`
	CommitKind classroom.TranslationCommitKind `json:"commitKind"`
	Code       string                          `json:"code"`
	Message    string                          `json:"message"`
	Retryable  bool                            `json:"retryable"`
}

// TTSAudioPayload carries synthesized English audio.
type TTSAudioPayload struct {
	SessionID    string  `json:"sessionId"`
	CommitId     string  `json:"commitId"`
	CommitNo     int     `json:"commitNo"`
	SequenceNo   int     `json:"sequenceNo"`
	Text         string  `json:"text"`
	Language     string  `json:"language"`
	AudioURL     string  `json:"audioUrl"`
	AudioBase64  string  `json:"audioBase64"`
	VoiceProfile string  `json:"voiceProfile,omitempty"`
	SpeechSpeed  string  `json:"speechSpeed,omitempty"`
	PlaybackRate float64 `json:"playbackRate,omitempty"`
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
	CommitId  string `json:"commitId,omitempty"`
	CommitNo  int    `json:"commitNo,omitempty"`
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

func commitErrorFrame(sessionID, commitId string, commitNo int, code, message string) []byte {
	return MustEnvelope(EventError, ErrorPayload{
		SessionID: sessionID,
		CommitId:  commitId,
		CommitNo:  commitNo,
		Code:      code,
		Message:   message,
	})
}

// frameFromPipelineEvent maps a transport-agnostic domain event onto a wire frame.
// This is the single boundary where domain events become WebSocket envelopes.
func frameFromPipelineEvent(e classroom.PipelineEvent) []byte {
	switch e.Type {
	case classroom.PipelineTranslationCommitted:
		return MustEnvelope(EventTranslationCommitted, TranslationCommittedPayload{
			SessionID:      e.SessionID,
			CommitId:       e.CommitId,
			CommitNo:       e.CommitNo,
			CommitKind:     e.CommitKind,
			SequenceNo:     e.SequenceNo,
			Duplicate:      e.Duplicate,
			SourceText:     e.SourceText,
			TranslatedText: e.TranslatedText,
			ReviewStatus:   e.ReviewStatus,
		})
	case classroom.PipelineTranslationRejected:
		return MustEnvelope(EventTranslationRejected, TranslationRejectedPayload{
			SessionID:  e.SessionID,
			CommitId:   e.CommitId,
			CommitNo:   e.CommitNo,
			CommitKind: e.CommitKind,
			Code:       e.Code,
			Message:    e.Message,
			Retryable:  e.Retryable,
		})
	case classroom.PipelineTTSAudio:
		return MustEnvelope(EventTTSAudio, TTSAudioPayload{
			SessionID:    e.SessionID,
			CommitId:     e.CommitId,
			CommitNo:     e.CommitNo,
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
		return MustEnvelope(EventError, ErrorPayload{
			SessionID: e.SessionID,
			CommitId:  e.CommitId,
			CommitNo:  e.CommitNo,
			Code:      e.Code,
			Message:   e.Message,
		})
	default:
		return errorFrame(e.SessionID, ErrCodeInternal, "unknown pipeline event")
	}
}
