package ai_client

import "context"

// TermPair is one established Thai->English translation, fed back to the
// translator so the same term renders consistently across a session.
type TermPair struct {
	Th string `json:"th"`
	En string `json:"en"`
}

// TranslateRequest is the payload sent to POST /ai/translate/th-to-en.
type TranslateRequest struct {
	SessionID  string `json:"sessionId"`
	SourceText string `json:"sourceText"`
	// ContextNote is the lesson topic / story synopsis (optional background).
	ContextNote string `json:"contextNote,omitempty"`
	// Glossary carries recent confirmed translations for term consistency.
	Glossary []TermPair `json:"glossary,omitempty"`
}

// TranslateResponse is the decoded result of POST /ai/translate/th-to-en.
type TranslateResponse struct {
	TranslatedText string `json:"translatedText"`
	SourceLanguage string `json:"sourceLanguage"`
	TargetLanguage string `json:"targetLanguage"`
}

// Translate converts Thai source text to English, optionally guided by a lesson
// context note and a glossary of established term translations.
func (c *Client) Translate(ctx context.Context, sessionID, sourceText, contextNote string, glossary []TermPair) (*TranslateResponse, error) {
	var out TranslateResponse
	req := TranslateRequest{
		SessionID:   sessionID,
		SourceText:  sourceText,
		ContextNote: contextNote,
		Glossary:    glossary,
	}
	if err := c.postJSON(ctx, "/ai/translate/th-to-en", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
