// Package classroom holds the core domain: models, DTOs, persistence, and orchestration.
package classroom

import "time"

// Session lifecycle status constants.
const (
	StatusActive     = "active"
	StatusProcessing = "processing"
	StatusCompleted  = "completed"
	StatusFailed     = "failed"
)

// Fixed language contract for the th-to-en pipeline.
const (
	SourceLanguage       = "th-TH"
	TargetLanguage       = "en-US"
	TranslationDirection = "th-to-en"
)

// Flashcard type constants.
const (
	FlashcardTypeVocabulary = "vocabulary"
	FlashcardTypeSentence   = "sentence"
	FlashcardTypeGrammar    = "grammar"
)

// Session represents a classroom session document.
type Session struct {
	SessionID      string     `bson:"sessionId" json:"sessionId"`
	ClassroomName  string     `bson:"classroomName" json:"classroomName"`
	SpeakerName    string     `bson:"speakerName" json:"speakerName"`
	ContextNote    string     `bson:"contextNote,omitempty" json:"contextNote,omitempty"`
	SourceLanguage string     `bson:"sourceLanguage" json:"sourceLanguage"`
	TargetLanguage string     `bson:"targetLanguage" json:"targetLanguage"`
	Status         string     `bson:"status" json:"status"`
	StartedAt      time.Time  `bson:"startedAt" json:"startedAt"`
	EndedAt        *time.Time `bson:"endedAt,omitempty" json:"endedAt,omitempty"`
	CreatedAt      time.Time  `bson:"createdAt" json:"createdAt"`
	UpdatedAt      time.Time  `bson:"updatedAt" json:"updatedAt"`
}

// Message represents a single transcribed/translated utterance.
type Message struct {
	SessionID      string     `bson:"sessionId" json:"sessionId"`
	SequenceNo     int        `bson:"sequenceNo" json:"sequenceNo"`
	SourceText     string     `bson:"sourceText" json:"sourceText"`
	TranslatedText string     `bson:"translatedText" json:"translatedText"`
	SourceLanguage string     `bson:"sourceLanguage" json:"sourceLanguage"`
	TargetLanguage string     `bson:"targetLanguage" json:"targetLanguage"`
	Confidence     float64    `bson:"confidence" json:"confidence"`
	AudioURL       string     `bson:"audioUrl" json:"audioUrl"`
	IsFinal        bool       `bson:"isFinal" json:"isFinal"`
	StartedAt      *time.Time `bson:"startedAt,omitempty" json:"startedAt,omitempty"`
	EndedAt        *time.Time `bson:"endedAt,omitempty" json:"endedAt,omitempty"`
	CreatedAt      time.Time  `bson:"createdAt" json:"createdAt"`
}

// Summary represents the bilingual recap of a session.
type Summary struct {
	SessionID   string    `bson:"sessionId" json:"sessionId"`
	SummaryTh   string    `bson:"summaryTh" json:"summaryTh"`
	SummaryEn   string    `bson:"summaryEn" json:"summaryEn"`
	KeyPointsTh []string  `bson:"keyPointsTh" json:"keyPointsTh"`
	KeyPointsEn []string  `bson:"keyPointsEn" json:"keyPointsEn"`
	CreatedAt   time.Time `bson:"createdAt" json:"createdAt"`
}

// Vocabulary represents a single learned word with bilingual context.
type Vocabulary struct {
	SessionID         string    `bson:"sessionId" json:"sessionId"`
	Word              string    `bson:"word" json:"word"`
	Pronunciation     string    `bson:"pronunciation" json:"pronunciation"`
	PartOfSpeech      string    `bson:"partOfSpeech" json:"partOfSpeech"`
	MeaningTh         string    `bson:"meaningTh" json:"meaningTh"`
	MeaningEn         string    `bson:"meaningEn" json:"meaningEn"`
	ExampleSentenceEn string    `bson:"exampleSentenceEn" json:"exampleSentenceEn"`
	ExampleSentenceTh string    `bson:"exampleSentenceTh" json:"exampleSentenceTh"`
	DifficultyLevel   string    `bson:"difficultyLevel" json:"difficultyLevel"`
	CreatedAt         time.Time `bson:"createdAt" json:"createdAt"`
}

// Flashcard represents a study card derived from the session.
type Flashcard struct {
	SessionID       string    `bson:"sessionId" json:"sessionId"`
	Front           string    `bson:"front" json:"front"`
	Back            string    `bson:"back" json:"back"`
	Type            string    `bson:"type" json:"type"`
	Word            string    `bson:"word" json:"word"`
	HintTh          string    `bson:"hintTh" json:"hintTh"`
	ExampleSentence string    `bson:"exampleSentence" json:"exampleSentence"`
	CreatedAt       time.Time `bson:"createdAt" json:"createdAt"`
}
