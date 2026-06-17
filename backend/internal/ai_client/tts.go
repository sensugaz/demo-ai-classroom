package ai_client

import "context"

// TTSRequest is the payload sent to POST /ai/tts/en.
type TTSRequest struct {
	SessionID string `json:"sessionId"`
	Text      string `json:"text"`
}

// TTSResponse is the decoded result of POST /ai/tts/en.
type TTSResponse struct {
	AudioURL    string `json:"audioUrl"`
	AudioBase64 string `json:"audioBase64"`
	Language    string `json:"language"`
	DurationMs  int    `json:"durationMs"`
}

// TTS synthesizes English speech for the given text.
func (c *Client) TTS(ctx context.Context, sessionID, text string) (*TTSResponse, error) {
	var out TTSResponse
	req := TTSRequest{SessionID: sessionID, Text: text}
	if err := c.postJSON(ctx, "/ai/tts/en", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
