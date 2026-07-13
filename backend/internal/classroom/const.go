package classroom

import "time"

const (
	finalizeTimeout           = 120 * time.Second
	flashcardImageTimeout     = 180 * time.Second
	flashcardImageConcurrency = 2
	maxCommittedTextBytes     = 24_000
	maxCommitIdentifierBytes  = 256
)

const (
	StatusActive     = "active"
	StatusProcessing = "processing"
	StatusCompleted  = "completed"
	StatusFailed     = "failed"
)

const (
	SourceLanguage       = "th-TH"
	TargetLanguage       = "en-US"
	TranslationDirection = "th-to-en"
)

const (
	FlashcardTypeVocabulary = "vocabulary"
	FlashcardTypeSentence   = "sentence"
	FlashcardTypeGrammar    = "grammar"
)

const (
	FlashcardImageStatusPending = "pending"
	FlashcardImageStatusReady   = "ready"
	FlashcardImageStatusSkipped = "skipped"
	FlashcardImageStatusFailed  = "failed"
)

const (
	TTSVoiceProfileChildGirl  = "child_girl"
	TTSVoiceProfileChildBoy   = "child_boy"
	TTSVoiceProfileAdultWoman = "adult_woman"
	TTSVoiceProfileAdultMan   = "adult_man"
)

const (
	TTSSpeechSpeedSlow   = "slow"
	TTSSpeechSpeedMedium = "medium"
	TTSSpeechSpeedFast   = "fast"
)

const (
	TranslationCommitKindDebounced TranslationCommitKind = "debounced"
	TranslationCommitKindFinal     TranslationCommitKind = "final"
)

const (
	TranslationReviewStatusAccepted  TranslationReviewStatus = "accepted"
	TranslationReviewStatusCorrected TranslationReviewStatus = "corrected"
)

const (
	PipelineTranslationProgress  PipelineEventType = "translation:progress"
	PipelineTranslationCommitted PipelineEventType = "translation:committed"
	PipelineTranslationRejected  PipelineEventType = "translation:rejected"
	PipelineTTSAudio             PipelineEventType = "tts:audio"
	PipelineError                PipelineEventType = "error"
)

const (
	TranslationProgressStageReviewing    TranslationProgressStage = "reviewing"
	TranslationProgressStagePersisting   TranslationProgressStage = "persisting"
	TranslationProgressStageSynthesizing TranslationProgressStage = "synthesizing"
)

const (
	PipeErrInvalidPayload          = "INVALID_PAYLOAD"
	PipeErrSessionUnknown          = "SESSION_UNKNOWN"
	PipeErrSessionInactive         = "SESSION_NOT_ACTIVE"
	PipeErrCommitConflict          = "COMMIT_CONFLICT"
	PipeErrTranslationReviewFailed = "TRANSLATION_REVIEW_FAILED"
	PipeErrTTSFailed               = "TTS_FAILED"
)
