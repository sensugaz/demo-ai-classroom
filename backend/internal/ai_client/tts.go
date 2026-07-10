package ai_client

import "context"

// TTSRequest is the payload sent to POST /ai/tts/en.
type TTSRequest struct {
	SessionID    string `json:"sessionId"`
	Text         string `json:"text"`
	VoiceProfile string `json:"voiceProfile,omitempty"`
	SpeechSpeed  string `json:"speechSpeed,omitempty"`
}

// TTSResponse is the decoded result of POST /ai/tts/en.
type TTSResponse struct {
	AudioURL     string  `json:"audioUrl"`
	AudioBase64  string  `json:"audioBase64"`
	Language     string  `json:"language"`
	DurationMs   int     `json:"durationMs"`
	VoiceProfile string  `json:"voiceProfile,omitempty"`
	SpeechSpeed  string  `json:"speechSpeed,omitempty"`
	PlaybackRate float64 `json:"playbackRate,omitempty"`
}

// TTS synthesizes English speech for the given text.
func (c *Client) TTS(ctx context.Context, sessionID, text, voiceProfile, speechSpeed string) (*TTSResponse, error) {
	var out TTSResponse
	req := TTSRequest{
		SessionID:    sessionID,
		Text:         text,
		VoiceProfile: voiceProfile,
		SpeechSpeed:  speechSpeed,
	}
	if err := c.postJSON(ctx, "/ai/tts/en", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
