package ai_client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReviewTranslationHTTPContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/ai/realtime-translation/review" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var request TranslationReviewRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if request.SessionID != "session-1" || request.SourceText != "มะยม มะขาม" ||
			request.CandidateTranslatedText != "makha" || request.ContextNote != "บทเรียนเรื่องผลไม้" {
			t.Fatalf("unexpected review request: %+v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"corrected","translatedText":"Star gooseberry and tamarind."}`))
	}))
	defer server.Close()

	client := NewClient(server.URL)
	result, err := client.ReviewTranslation(context.Background(), TranslationReviewRequest{
		SessionID:               "session-1",
		SourceText:              "มะยม มะขาม",
		CandidateTranslatedText: "makha",
		ContextNote:             "บทเรียนเรื่องผลไม้",
	})
	if err != nil {
		t.Fatalf("review translation: %v", err)
	}
	if result.Status != "corrected" || result.TranslatedText != "Star gooseberry and tamarind." {
		t.Fatalf("unexpected review response: %+v", result)
	}
}

func TestReviewTranslationRejectsIncompleteResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"pending","translatedText":""}`))
	}))
	defer server.Close()

	_, err := NewClient(server.URL).ReviewTranslation(
		context.Background(),
		TranslationReviewRequest{SessionID: "session-1", SourceText: "สวัสดี", CandidateTranslatedText: "Hello"},
	)
	if err == nil {
		t.Fatal("expected incomplete review response to fail closed")
	}
}
