package ai_client

import "context"

// FinalizeMessage is one source/translation pair fed to finalization.
type FinalizeMessage struct {
	SourceText     string `json:"sourceText"`
	TranslatedText string `json:"translatedText"`
}

// FinalizeRequest is the payload sent to POST /ai/classroom/finalize.
type FinalizeRequest struct {
	SessionID string            `json:"sessionId"`
	Messages  []FinalizeMessage `json:"messages"`
}

// FinalizeSummary mirrors the summary block of the finalize response.
type FinalizeSummary struct {
	SummaryTh   string   `json:"summaryTh"`
	SummaryEn   string   `json:"summaryEn"`
	KeyPointsTh []string `json:"keyPointsTh"`
	KeyPointsEn []string `json:"keyPointsEn"`
}

// FinalizeVocabulary mirrors one vocabulary entry of the finalize response.
type FinalizeVocabulary struct {
	Word              string `json:"word"`
	Pronunciation     string `json:"pronunciation"`
	PartOfSpeech      string `json:"partOfSpeech"`
	MeaningTh         string `json:"meaningTh"`
	MeaningEn         string `json:"meaningEn"`
	ExampleSentenceEn string `json:"exampleSentenceEn"`
	ExampleSentenceTh string `json:"exampleSentenceTh"`
	DifficultyLevel   string `json:"difficultyLevel"`
}

// FinalizeFlashcard mirrors one flashcard entry of the finalize response.
type FinalizeFlashcard struct {
	Front           string `json:"front"`
	Back            string `json:"back"`
	Type            string `json:"type"`
	Word            string `json:"word"`
	HintTh          string `json:"hintTh"`
	ExampleSentence string `json:"exampleSentence"`
}

// FinalizeResponse is the decoded result of POST /ai/classroom/finalize.
type FinalizeResponse struct {
	Summary      FinalizeSummary      `json:"summary"`
	Vocabularies []FinalizeVocabulary `json:"vocabularies"`
	Flashcards   []FinalizeFlashcard  `json:"flashcards"`
}

// AIClient abstracts the ai-service so service/transport layers stay decoupled and testable.
type AIClient interface {
	STT(ctx context.Context, req STTRequest) (*STTResponse, error)
	Translate(ctx context.Context, sessionID, sourceText, contextNote string, glossary []TermPair) (*TranslateResponse, error)
	TTS(ctx context.Context, sessionID, text string) (*TTSResponse, error)
	Finalize(ctx context.Context, sessionID string, messages []FinalizeMessage) (*FinalizeResponse, error)
}

// compile-time assertion that *Client satisfies AIClient.
var _ AIClient = (*Client)(nil)

// Finalize asks the ai-service to produce summary, vocabularies, and flashcards.
func (c *Client) Finalize(ctx context.Context, sessionID string, messages []FinalizeMessage) (*FinalizeResponse, error) {
	var out FinalizeResponse
	req := FinalizeRequest{SessionID: sessionID, Messages: messages}
	if err := c.postJSON(ctx, "/ai/classroom/finalize", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
