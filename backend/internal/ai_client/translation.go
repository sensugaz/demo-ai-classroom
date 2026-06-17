package ai_client

import "context"

// TranslateRequest is the payload sent to POST /ai/translate/th-to-en.
type TranslateRequest struct {
	SessionID  string `json:"sessionId"`
	SourceText string `json:"sourceText"`
}

// TranslateResponse is the decoded result of POST /ai/translate/th-to-en.
type TranslateResponse struct {
	TranslatedText string `json:"translatedText"`
	SourceLanguage string `json:"sourceLanguage"`
	TargetLanguage string `json:"targetLanguage"`
}

// Translate converts Thai source text to English.
func (c *Client) Translate(ctx context.Context, sessionID, sourceText string) (*TranslateResponse, error) {
	var out TranslateResponse
	req := TranslateRequest{SessionID: sessionID, SourceText: sourceText}
	if err := c.postJSON(ctx, "/ai/translate/th-to-en", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
