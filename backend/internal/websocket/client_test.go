package websocket

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/ai-classroom/backend/internal/ai_client"
	"github.com/ai-classroom/backend/internal/classroom"
)

type transportTestService struct {
	getSession    func(context.Context, string) (*classroom.Session, error)
	endSession    func(context.Context, string) (*classroom.Session, error)
	listMessages  func(context.Context, string) ([]classroom.Message, error)
	getFlashcards func(context.Context, string) ([]classroom.Flashcard, error)
	handleAudio   func(context.Context, classroom.AudioChunkInput, classroom.PipelineEventSink) error
}

func (s *transportTestService) CreateSession(context.Context, classroom.CreateSessionRequest) (*classroom.Session, error) {
	return nil, nil
}

func (s *transportTestService) GetSession(ctx context.Context, sessionID string) (*classroom.Session, error) {
	if s.getSession != nil {
		return s.getSession(ctx, sessionID)
	}

	return nil, nil
}

func (s *transportTestService) ListSessions(context.Context) ([]classroom.Session, error) {
	return nil, nil
}

func (s *transportTestService) EndSession(ctx context.Context, sessionID string) (*classroom.Session, error) {
	if s.endSession != nil {
		return s.endSession(ctx, sessionID)
	}

	return nil, nil
}

func (s *transportTestService) ResetSession(context.Context, string) error {
	return nil
}

func (s *transportTestService) ListMessages(ctx context.Context, sessionID string) ([]classroom.Message, error) {
	if s.listMessages != nil {
		return s.listMessages(ctx, sessionID)
	}

	return nil, nil
}

func (s *transportTestService) GetSummary(context.Context, string) (*classroom.Summary, error) {
	return nil, nil
}

func (s *transportTestService) UpdateSummary(context.Context, string, classroom.UpdateSummaryRequest) (*classroom.Summary, error) {
	return nil, nil
}

func (s *transportTestService) GetVocabularies(context.Context, string) ([]classroom.Vocabulary, error) {
	return nil, nil
}

func (s *transportTestService) GetFlashcards(ctx context.Context, sessionID string) ([]classroom.Flashcard, error) {
	if s.getFlashcards != nil {
		return s.getFlashcards(ctx, sessionID)
	}

	return nil, nil
}

func (s *transportTestService) GetFlashcardImage(context.Context, string, string) (*ai_client.BinaryAsset, error) {
	return nil, nil
}

func (s *transportTestService) HandleAudioChunk(context.Context, string, string, string, int) ([]classroom.PipelineEvent, error) {
	return nil, nil
}

func (s *transportTestService) HandleAudioChunkStream(ctx context.Context, input classroom.AudioChunkInput, emit classroom.PipelineEventSink) error {
	return s.handleAudio(ctx, input, emit)
}

func TestProcessAudioChunk_EmitsProcessedExactlyOnceAndLast(t *testing.T) {
	service := &transportTestService{
		handleAudio: func(_ context.Context, input classroom.AudioChunkInput, emit classroom.PipelineEventSink) error {
			emit(classroom.PipelineEvent{
				Type:       classroom.PipelineTranscriptFinal,
				SessionID:  input.SessionID,
				SequenceNo: input.SequenceNo,
				SourceText: "บทเรียน",
			})
			emit(classroom.PipelineEvent{
				Type:           classroom.PipelineTranslation,
				SessionID:      input.SessionID,
				SequenceNo:     input.SequenceNo,
				SourceText:     "บทเรียน",
				TranslatedText: "lesson",
			})

			return nil
		},
	}
	client := newTransportTestClient(service, 0, "session-1")

	client.processAudioChunk(AudioChunkPayload{
		SessionID:  "session-1",
		Audio:      "YQ==",
		SequenceNo: 7,
	})

	frames := readTransportTestFrames(t, client.send, 3)
	if frames[0].Event != EventTranscriptFinal || frames[1].Event != EventTranslationResult || frames[2].Event != EventAudioProcessed {
		t.Fatalf("unexpected transport order: %s, %s, %s", frames[0].Event, frames[1].Event, frames[2].Event)
	}
	processedCount := 0
	for _, frame := range frames {
		if frame.Event == EventAudioProcessed {
			processedCount++
		}
	}
	if processedCount != 1 {
		t.Fatalf("expected one processed acknowledgement, got %d", processedCount)
	}

	var payload AudioProcessedPayload
	if err := json.Unmarshal(frames[2].Payload, &payload); err != nil {
		t.Fatalf("decode processed payload: %v", err)
	}
	if payload.SessionID != "session-1" || payload.SequenceNo != 7 {
		t.Fatalf("unexpected processed payload: %+v", payload)
	}
}

func TestProcessAudioChunk_OversizedEmitsErrorThenProcessed(t *testing.T) {
	service := &transportTestService{
		handleAudio: func(context.Context, classroom.AudioChunkInput, classroom.PipelineEventSink) error {
			t.Fatalf("oversized audio must not reach the service")

			return nil
		},
	}
	client := newTransportTestClient(service, 1, "session-1")
	oversized := strings.Repeat("a", int(client.maxReadLimit())+1)

	client.processAudioChunk(AudioChunkPayload{
		SessionID:  "session-1",
		Audio:      oversized,
		SequenceNo: 9,
	})

	frames := readTransportTestFrames(t, client.send, 2)
	if frames[0].Event != EventError || frames[1].Event != EventAudioProcessed {
		t.Fatalf("oversized order must be error then processed, got %s then %s", frames[0].Event, frames[1].Event)
	}
	var payload ErrorPayload
	if err := json.Unmarshal(frames[0].Payload, &payload); err != nil {
		t.Fatalf("decode error payload: %v", err)
	}
	if payload.Code != ErrCodeAudioTooLarge {
		t.Fatalf("unexpected oversized code: %+v", payload)
	}
}

func TestProcessAudioChunk_BackpressureDoesNotDropProcessed(t *testing.T) {
	handled := make(chan struct{})
	service := &transportTestService{
		handleAudio: func(context.Context, classroom.AudioChunkInput, classroom.PipelineEventSink) error {
			close(handled)

			return nil
		},
	}
	client := newTransportTestClient(service, 0, "session-1")
	client.send = make(chan []byte, 1)
	client.send <- []byte("occupied")

	done := make(chan struct{})
	go func() {
		client.processAudioChunk(AudioChunkPayload{SessionID: "session-1", Audio: "YQ==", SequenceNo: 11})
		close(done)
	}()
	<-handled
	<-client.send

	select {
	case raw := <-client.send:
		var frame Envelope
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatalf("decode processed frame: %v", err)
		}
		if frame.Event != EventAudioProcessed {
			t.Fatalf("expected critical processed frame, got %q", frame.Event)
		}
	case <-time.After(time.Second):
		t.Fatalf("processed acknowledgement was dropped under backpressure")
	}
	<-done
}

func TestDispatch_RejectsAudioForUnjoinedSession(t *testing.T) {
	called := false
	service := &transportTestService{
		handleAudio: func(context.Context, classroom.AudioChunkInput, classroom.PipelineEventSink) error {
			called = true

			return nil
		},
	}
	client := newTransportTestClient(service, 0, "session-1")
	payload, err := json.Marshal(AudioChunkPayload{SessionID: "session-2", Audio: "YQ==", SequenceNo: 1})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	client.dispatch(Envelope{Event: EventAudioChunk, Payload: payload})
	frames := readTransportTestFrames(t, client.send, 1)
	if called {
		t.Fatalf("audio for an unjoined session reached the service")
	}
	if frames[0].Event != EventError {
		t.Fatalf("expected session binding error, got %q", frames[0].Event)
	}
	var errorPayload ErrorPayload
	if err := json.Unmarshal(frames[0].Payload, &errorPayload); err != nil {
		t.Fatalf("decode binding error: %v", err)
	}
	if errorPayload.Code != ErrCodeSessionUnknown {
		t.Fatalf("unexpected binding error: %+v", errorPayload)
	}
}

func TestHandleJoin_RejectsConnectionRebind(t *testing.T) {
	service := &transportTestService{}
	client := newTransportTestClient(service, 0, "session-1")

	client.handleJoin("session-2")

	frames := readTransportTestFrames(t, client.send, 1)
	if frames[0].Event != EventError {
		t.Fatalf("expected rebind error, got %q", frames[0].Event)
	}
	if got := client.getSessionID(); got != "session-1" {
		t.Fatalf("rebind changed connection session to %q", got)
	}
	var payload ErrorPayload
	if err := json.Unmarshal(frames[0].Payload, &payload); err != nil {
		t.Fatalf("decode rebind error: %v", err)
	}
	if payload.Code != ErrCodeInvalidPayload {
		t.Fatalf("unexpected rebind error: %+v", payload)
	}
}

func TestHandleSessionEnd_ReadinessErrorDoesNotReportFalseCompletion(t *testing.T) {
	service := &transportTestService{
		endSession: func(context.Context, string) (*classroom.Session, error) {
			return &classroom.Session{SessionID: "session-1", Status: classroom.StatusCompleted}, nil
		},
		listMessages: func(context.Context, string) ([]classroom.Message, error) {
			return nil, errors.New("readiness query failed")
		},
	}
	client := newTransportTestClient(service, 0, "session-1")

	client.handleSessionEnd("session-1")

	frames := readTransportTestFrames(t, client.send, 1)
	if frames[0].Event != EventError {
		t.Fatalf("expected readiness error, got %q", frames[0].Event)
	}
	var payload ErrorPayload
	if err := json.Unmarshal(frames[0].Payload, &payload); err != nil {
		t.Fatalf("decode readiness error: %v", err)
	}
	if payload.Code != ErrCodeInternal {
		t.Fatalf("unexpected readiness error: %+v", payload)
	}
}

func newTransportTestClient(service classroom.SessionService, maxAudio int64, sessionID string) *Client {
	hub := NewHub()
	client := &Client{
		send:     make(chan []byte, 8),
		hub:      hub,
		svc:      service,
		log:      slog.Default(),
		maxAudio: maxAudio,
	}
	client.setSessionID(sessionID)
	hub.Register(sessionID, client)

	return client
}

func readTransportTestFrames(t *testing.T, frames <-chan []byte, count int) []Envelope {
	t.Helper()

	decoded := make([]Envelope, 0, count)
	for range count {
		var frame Envelope
		if err := json.Unmarshal(<-frames, &frame); err != nil {
			t.Fatalf("decode frame: %v", err)
		}
		decoded = append(decoded, frame)
	}

	return decoded
}
