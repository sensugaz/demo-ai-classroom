package classroom

// PipelineEventType enumerates the transport-agnostic events produced by the
// per-chunk audio pipeline. The transport layer (e.g. WebSocket) maps these onto
// its own wire protocol, keeping the domain free of any transport dependency.
type PipelineEventType string

const (
	PipelineTranscriptFinal PipelineEventType = "transcript:final"
	PipelineTranslation     PipelineEventType = "translation:result"
	PipelineTTSAudio        PipelineEventType = "tts:audio"
	PipelineError           PipelineEventType = "error"
)

// PipelineEvent is a single transport-agnostic result of processing an audio chunk.
// Only the fields relevant to Type are populated.
type PipelineEvent struct {
	Type PipelineEventType

	// Common
	SessionID  string
	SequenceNo int

	// Transcript / translation text
	SourceText     string
	TranslatedText string

	// Latency (ms) — populated on translation events for live on-screen display.
	SttMs       int64
	TranslateMs int64

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

// AudioChunkInput is one validated audio chunk entering the realtime pipeline.
type AudioChunkInput struct {
	SessionID    string
	AudioBase64  string
	MimeType     string
	SequenceNo   int
	VoiceProfile string
	SpeechSpeed  string
}

// PipelineEventSink receives pipeline events as soon as each stage is ready.
type PipelineEventSink func(PipelineEvent)

// Pipeline error codes (transport-agnostic).
const (
	PipeErrInvalidPayload  = "INVALID_PAYLOAD"
	PipeErrSessionUnknown  = "SESSION_UNKNOWN"
	PipeErrSTTFailed       = "STT_FAILED"
	PipeErrTranslateFailed = "TRANSLATE_FAILED"
	PipeErrTTSFailed       = "TTS_FAILED"
)

func transcriptFinalEvent(sessionID, sourceText string, sequenceNo int) PipelineEvent {
	return PipelineEvent{Type: PipelineTranscriptFinal, SessionID: sessionID, SequenceNo: sequenceNo, SourceText: sourceText}
}

func translationEvent(sessionID, sourceText, translatedText string, sequenceNo int, sttMs, translateMs int64) PipelineEvent {
	return PipelineEvent{
		Type:           PipelineTranslation,
		SessionID:      sessionID,
		SequenceNo:     sequenceNo,
		SourceText:     sourceText,
		TranslatedText: translatedText,
		SttMs:          sttMs,
		TranslateMs:    translateMs,
	}
}

func ttsAudioEvent(sessionID, text, audioURL, audioBase64, voiceProfile, speechSpeed string, sequenceNo int, playbackRate float64) PipelineEvent {
	return PipelineEvent{
		Type:         PipelineTTSAudio,
		SessionID:    sessionID,
		SequenceNo:   sequenceNo,
		TTSText:      text,
		AudioURL:     audioURL,
		AudioBase64:  audioBase64,
		VoiceProfile: voiceProfile,
		SpeechSpeed:  speechSpeed,
		PlaybackRate: playbackRate,
	}
}

func pipelineError(sessionID, code, message string) PipelineEvent {
	return PipelineEvent{Type: PipelineError, SessionID: sessionID, Code: code, Message: message}
}

func pipelineErrors(sessionID, code, message string) []PipelineEvent {
	return []PipelineEvent{pipelineError(sessionID, code, message)}
}
