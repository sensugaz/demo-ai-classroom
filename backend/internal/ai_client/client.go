// Package ai_client is the HTTP gateway to the Python ai-service.
package ai_client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// BinaryAsset is a raw file fetched from the ai-service.
type BinaryAsset struct {
	ContentType string
	Body        []byte
}

// Client talks to the ai-service over HTTP/JSON.
type Client struct {
	baseURL string
	http    *http.Client
}

// NewClient builds a Client targeting baseURL with sensible timeouts.
//
// The default timeout is generous because STT/translation/TTS each call upstream
// model providers; finalize uses a dedicated longer timeout via its own context.
func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		http: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// postJSON marshals req, POSTs it to path, and decodes the JSON response into out.
// Non-2xx responses are returned as errors carrying the upstream body for diagnostics.
func (c *Client) postJSON(ctx context.Context, path string, req, out any) error {
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("ai_client: marshal %s request: %w", path, err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("ai_client: build %s request: %w", path, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return fmt.Errorf("ai_client: call %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return fmt.Errorf("ai_client: read %s response: %w", path, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("ai_client: %s returned %d: %s", path, resp.StatusCode, truncate(respBody, 512))
	}

	if out == nil {
		return nil
	}
	if err := json.Unmarshal(respBody, out); err != nil {
		return fmt.Errorf("ai_client: decode %s response: %w", path, err)
	}
	return nil
}

func truncate(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n]) + "..."
	}
	return string(b)
}

// GetFlashcardImage fetches a cached flashcard image from the ai-service.
func (c *Client) GetFlashcardImage(ctx context.Context, filename string) (*BinaryAsset, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/ai/assets/flashcards/"+filename, nil)
	if err != nil {
		return nil, fmt.Errorf("ai_client: build flashcard image request: %w", err)
	}
	httpReq.Header.Set("Accept", "image/webp,image/png,image/jpeg,*/*")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("ai_client: call flashcard image: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, fmt.Errorf("ai_client: read flashcard image: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("ai_client: flashcard image returned %d: %s", resp.StatusCode, truncate(body, 256))
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return &BinaryAsset{ContentType: contentType, Body: body}, nil
}
