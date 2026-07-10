package classroom

// PipelineEventType enumerates the transport-agnostic events produced by the
// per-chunk audio pipeline. The transport layer (e.g. WebSocket) maps these onto
// its own wire protocol, keeping the domain free of any transport dependency.
type PipelineEventType string

const (
	PipelineTranslationCommitted PipelineEventType = "translation:committed"
	PipelineTTSAudio             PipelineEventType = "tts:audio"
	PipelineError                PipelineEventType = "error"
)

// PipelineEvent is a single transport-agnostic result of processing an audio chunk.
// Only the fields relevant to Type are populated.
type PipelineEvent struct {
	Type PipelineEventType

	// Common
	SessionID  string
	SequenceNo int
	CommitId   string
	CommitNo   int
	CommitKind TranslationCommitKind
	Duplicate  bool

	// TTS
	TTSText      string
	AudioURL     string
	AudioBase64  string
	VoiceProfile string
	SpeechSpeed  string
	PlaybackRate float64

	// Error
	Code    string
	Message string
}

// TranslationCommitInput is one immutable pair of append-only transcript slices.
type TranslationCommitInput struct {
	SessionID            string
	TranslationSessionId string
	CommitId             string
	CommitNo             int
	CommitKind           TranslationCommitKind
	SourceText           string
	TranslatedText       string
	SourceElapsedMs      int64
	TargetElapsedMs      int64
	VoiceProfile         string
	SpeechSpeed          string
}

// PipelineEventSink receives pipeline events as soon as each stage is ready.
type PipelineEventSink func(PipelineEvent)

// Pipeline error codes (transport-agnostic).
const (
	PipeErrInvalidPayload  = "INVALID_PAYLOAD"
	PipeErrSessionUnknown  = "SESSION_UNKNOWN"
	PipeErrSessionInactive = "SESSION_NOT_ACTIVE"
	PipeErrCommitConflict  = "COMMIT_CONFLICT"
	PipeErrTTSFailed       = "TTS_FAILED"
)

func translationCommittedEvent(message *Message, duplicate bool) PipelineEvent {
	return PipelineEvent{
		Type:       PipelineTranslationCommitted,
		SessionID:  message.SessionID,
		SequenceNo: message.SequenceNo,
		CommitId:   message.CommitId,
		CommitNo:   message.CommitNo,
		CommitKind: message.CommitKind,
		Duplicate:  duplicate,
	}
}

func ttsAudioEvent(message *Message, audioURL, audioBase64 string, playbackRate float64) PipelineEvent {
	return PipelineEvent{
		Type:         PipelineTTSAudio,
		SessionID:    message.SessionID,
		SequenceNo:   message.SequenceNo,
		CommitId:     message.CommitId,
		CommitNo:     message.CommitNo,
		TTSText:      message.TranslatedText,
		AudioURL:     audioURL,
		AudioBase64:  audioBase64,
		VoiceProfile: message.VoiceProfile,
		SpeechSpeed:  message.SpeechSpeed,
		PlaybackRate: playbackRate,
	}
}

func pipelineError(sessionID, code, message string) PipelineEvent {
	return PipelineEvent{Type: PipelineError, SessionID: sessionID, Code: code, Message: message}
}

func pipelineCommitError(message *Message, code, detail string) PipelineEvent {
	return PipelineEvent{
		Type:       PipelineError,
		SessionID:  message.SessionID,
		SequenceNo: message.SequenceNo,
		CommitId:   message.CommitId,
		CommitNo:   message.CommitNo,
		CommitKind: message.CommitKind,
		Code:       code,
		Message:    detail,
	}
}

func pipelineErrors(sessionID, code, message string) []PipelineEvent {
	return []PipelineEvent{pipelineError(sessionID, code, message)}
}
