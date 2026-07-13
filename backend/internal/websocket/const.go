package websocket

import "time"

const (
	writeWait             = 10 * time.Second
	pongWait              = 60 * time.Second
	pingPeriod            = (pongWait * 9) / 10
	sendBuffer            = 64
	maxInboundMessageSize = 1 << 20
)

const (
	EventSessionJoin       = "session:join"
	EventTranslationCommit = "translation:commit"
	EventSessionEnd        = "session:end"
)

const (
	EventTranslationProgress  = "translation:progress"
	EventTranslationCommitted = "translation:committed"
	EventTranslationRejected  = "translation:rejected"
	EventTTSAudio             = "tts:audio"
	EventSessionCompleted     = "session:completed"
	EventError                = "error"
)

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
