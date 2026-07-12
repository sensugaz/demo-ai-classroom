package ai_client

import (
	"context"
	"fmt"
	"strings"
)

// TranslationReviewRequest carries one untrusted Realtime candidate.
type TranslationReviewRequest struct {
	SessionID               string `json:"sessionId"`
	SourceText              string `json:"sourceText"`
	CandidateTranslatedText string `json:"candidateTranslatedText"`
	ContextNote             string `json:"contextNote"`
}

// TranslationReviewResponse contains canonical English for downstream use.
type TranslationReviewResponse struct {
	Status         string `json:"status"`
	TranslatedText string `json:"translatedText"`
}

// ReviewTranslation verifies one phrase before persistence, display, or TTS.
func (c *Client) ReviewTranslation(ctx context.Context, request TranslationReviewRequest) (*TranslationReviewResponse, error) {
	var review TranslationReviewResponse
	if err := c.postJSON(ctx, "/ai/realtime-translation/review", request, &review); err != nil {
		return nil, err
	}
	if strings.TrimSpace(review.TranslatedText) == "" || (review.Status != "accepted" && review.Status != "corrected") {
		return nil, fmt.Errorf("ai_client: translation review response is incomplete")
	}

	return &review, nil
}
