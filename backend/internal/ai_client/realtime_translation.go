package ai_client

import (
	"context"
	"fmt"
)

// RealtimeTranslationClientSecretRequest identifies the validated classroom session.
type RealtimeTranslationClientSecretRequest struct {
	SessionID string `json:"sessionId"`
}

// RealtimeTranslationClientSecret contains only browser-safe short-lived credentials.
type RealtimeTranslationClientSecret struct {
	ClientSecret         string `json:"clientSecret"`
	ExpiresAt            int64  `json:"expiresAt"`
	TranslationSessionId string `json:"translationSessionId"`
	Model                string `json:"model"`
	TargetLanguage       string `json:"targetLanguage"`
}

// MintRealtimeTranslationClientSecret asks ai-service to mint a short-lived OpenAI credential.
func (c *Client) MintRealtimeTranslationClientSecret(ctx context.Context, sessionID string) (*RealtimeTranslationClientSecret, error) {
	var secret RealtimeTranslationClientSecret
	request := RealtimeTranslationClientSecretRequest{SessionID: sessionID}
	if err := c.postJSON(ctx, "/ai/realtime-translation/client-secret", request, &secret); err != nil {
		return nil, err
	}
	if secret.ClientSecret == "" || secret.TranslationSessionId == "" || secret.ExpiresAt <= 0 {
		return nil, fmt.Errorf("ai_client: realtime translation client-secret response is incomplete")
	}

	return &secret, nil
}
