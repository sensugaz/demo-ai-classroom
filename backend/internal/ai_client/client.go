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
