package ai_client

import "context"

// STTRequest is the payload sent to POST /ai/stt/th.
type STTRequest struct {
	SessionID   string `json:"sessionId"`
	AudioBase64 string `json:"audioBase64"`
	MimeType    string `json:"mimeType"`
	SequenceNo  int    `json:"sequenceNo"`
}

// STTResponse is the decoded result of POST /ai/stt/th.
type STTResponse struct {
	SessionID  string  `json:"sessionId"`
	Text       string  `json:"text"`
	Language   string  `json:"language"`
	IsFinal    bool    `json:"isFinal"`
	Confidence float64 `json:"confidence"`
}

// STT performs Thai speech-to-text on a single self-contained audio chunk.
func (c *Client) STT(ctx context.Context, req STTRequest) (*STTResponse, error) {
	var out STTResponse
	if err := c.postJSON(ctx, "/ai/stt/th", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
