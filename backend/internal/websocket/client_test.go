package websocket

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/ai-classroom/backend/internal/ai_client"
	"github.com/ai-classroom/backend/internal/classroom"
)

type transportTestService struct {
	getSession        func(context.Context, string) (*classroom.Session, error)
	endSession        func(context.Context, string) (*classroom.Session, error)
	listMessages      func(context.Context, string) ([]classroom.Message, error)
	getFlashcards     func(context.Context, string) ([]classroom.Flashcard, error)
	commitTranslation func(context.Context, classroom.TranslationCommitInput, classroom.PipelineEventSink) error
}

func (s *transportTestService) CreateSession(context.Context, classroom.CreateSessionRequest) (*classroom.Session, error) {
	return nil, nil
}

func (s *transportTestService) GetSession(ctx context.Context, sessionID string) (*classroom.Session, error) {
	if s.getSession != nil {
		return s.getSession(ctx, sessionID)
	}

	return &classroom.Session{SessionID: sessionID, Status: classroom.StatusActive}, nil
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

func (s *transportTestService) CreateRealtimeTranslationClientSecret(context.Context, string) (*classroom.RealtimeTranslationClientSecretResponse, error) {
	return nil, nil
}

func (s *transportTestService) CommitTranslationStream(ctx context.Context, input classroom.TranslationCommitInput, emit classroom.PipelineEventSink) error {
	if s.commitTranslation == nil {
		return nil
	}

	return s.commitTranslation(ctx, input, emit)
}

func validTranslationCommitPayload(sessionID string) TranslationCommitPayload {
	return TranslationCommitPayload{
		SessionID:            sessionID,
		TranslationSessionId: "sess_translation",
		CommitId:             "commit-1",
		CommitNo:             1,
		CommitKind:           classroom.TranslationCommitKindDebounced,
		SourceText:           "บทเรียน",
		TranslatedText:       "lesson",
		SourceElapsedMs:      1000,
		TargetElapsedMs:      1200,
	}
}

func progressPipelineEvent(input classroom.TranslationCommitInput, stage classroom.TranslationProgressStage) classroom.PipelineEvent {
	return classroom.PipelineEvent{
		Type:      classroom.PipelineTranslationProgress,
		SessionID: input.SessionID,
		CommitId:  input.CommitId,
		CommitNo:  input.CommitNo,
		Stage:     stage,
	}
}

func assertTransportEventSequence(t *testing.T, frames []Envelope, want ...string) {
	t.Helper()
	if len(frames) != len(want) {
		t.Fatalf("unexpected frame count: want %d, got %d", len(want), len(frames))
	}
	for i, event := range want {
		if frames[i].Event != event {
			t.Fatalf("unexpected frame %d: want %q, got %q", i, event, frames[i].Event)
		}
	}
}

func TestProcessTranslationCommit_EmitsProgressTTSAndCriticalAcknowledgement(t *testing.T) {
	service := &transportTestService{
		commitTranslation: func(_ context.Context, input classroom.TranslationCommitInput, emit classroom.PipelineEventSink) error {
			emit(progressPipelineEvent(input, classroom.TranslationProgressStageReviewing))
			emit(progressPipelineEvent(input, classroom.TranslationProgressStagePersisting))
			emit(progressPipelineEvent(input, classroom.TranslationProgressStageSynthesizing))
			emit(classroom.PipelineEvent{
				Type:        classroom.PipelineTTSAudio,
				SessionID:   input.SessionID,
				CommitId:    input.CommitId,
				CommitNo:    input.CommitNo,
				SequenceNo:  7,
				TTSText:     input.TranslatedText,
				AudioBase64: "audio",
			})
			emit(classroom.PipelineEvent{
				Type:           classroom.PipelineTranslationCommitted,
				SessionID:      input.SessionID,
				CommitId:       input.CommitId,
				CommitNo:       input.CommitNo,
				CommitKind:     input.CommitKind,
				SequenceNo:     7,
				SourceText:     input.SourceText,
				TranslatedText: "canonical lesson",
				ReviewStatus:   classroom.TranslationReviewStatusCorrected,
			})

			return nil
		},
	}
	client := newTransportTestClient(service, "session-1")

	client.processTranslationCommit(validTranslationCommitPayload("session-1"))

	frames := readTransportTestFrames(t, client.send, 5)
	assertTransportEventSequence(t, frames,
		EventTranslationProgress,
		EventTranslationProgress,
		EventTranslationProgress,
		EventTTSAudio,
		EventTranslationCommitted,
	)
	stages := []classroom.TranslationProgressStage{
		classroom.TranslationProgressStageReviewing,
		classroom.TranslationProgressStagePersisting,
		classroom.TranslationProgressStageSynthesizing,
	}
	for i, stage := range stages {
		var progress TranslationProgressPayload
		if err := json.Unmarshal(frames[i].Payload, &progress); err != nil {
			t.Fatalf("decode progress %d: %v", i, err)
		}
		if progress.SessionID != "session-1" || progress.CommitId != "commit-1" || progress.CommitNo != 1 || progress.Stage != stage {
			t.Fatalf("unexpected progress %d: %+v", i, progress)
		}
	}
	var committed TranslationCommittedPayload
	if err := json.Unmarshal(frames[4].Payload, &committed); err != nil {
		t.Fatalf("decode acknowledgement: %v", err)
	}
	if committed.CommitId != "commit-1" || committed.SequenceNo != 7 || committed.Duplicate || committed.TranslatedText != "canonical lesson" || committed.ReviewStatus != classroom.TranslationReviewStatusCorrected {
		t.Fatalf("unexpected acknowledgement: %+v", committed)
	}
}

func TestProcessTranslationCommit_EmitsTerminalReviewRejection(t *testing.T) {
	service := &transportTestService{
		commitTranslation: func(_ context.Context, input classroom.TranslationCommitInput, emit classroom.PipelineEventSink) error {
			emit(progressPipelineEvent(input, classroom.TranslationProgressStageReviewing))
			emit(classroom.PipelineEvent{
				Type:       classroom.PipelineTranslationRejected,
				SessionID:  input.SessionID,
				CommitId:   input.CommitId,
				CommitNo:   input.CommitNo,
				CommitKind: input.CommitKind,
				Code:       classroom.PipeErrTranslationReviewFailed,
				Message:    "translation could not be verified; please repeat the phrase",
				Retryable:  true,
			})

			return nil
		},
	}
	client := newTransportTestClient(service, "session-1")

	client.processTranslationCommit(validTranslationCommitPayload("session-1"))

	frames := readTransportTestFrames(t, client.send, 2)
	assertTransportEventSequence(t, frames, EventTranslationProgress, EventTranslationRejected)
	var rejected TranslationRejectedPayload
	if err := json.Unmarshal(frames[1].Payload, &rejected); err != nil {
		t.Fatalf("decode rejection: %v", err)
	}
	if rejected.CommitId != "commit-1" || rejected.Code != ErrCodeTranslationReviewFailed || !rejected.Retryable {
		t.Fatalf("unexpected rejection: %+v", rejected)
	}
}

func TestProcessTranslationCommit_DuplicateEmitsOnlySynthesisProgress(t *testing.T) {
	service := &transportTestService{
		commitTranslation: func(_ context.Context, input classroom.TranslationCommitInput, emit classroom.PipelineEventSink) error {
			emit(progressPipelineEvent(input, classroom.TranslationProgressStageSynthesizing))
			emit(classroom.PipelineEvent{
				Type:        classroom.PipelineTTSAudio,
				SessionID:   input.SessionID,
				CommitId:    input.CommitId,
				CommitNo:    input.CommitNo,
				SequenceNo:  input.CommitNo,
				TTSText:     input.TranslatedText,
				AudioBase64: "audio",
			})
			emit(classroom.PipelineEvent{
				Type:       classroom.PipelineTranslationCommitted,
				SessionID:  input.SessionID,
				CommitId:   input.CommitId,
				CommitNo:   input.CommitNo,
				SequenceNo: input.CommitNo,
				Duplicate:  true,
			})

			return nil
		},
	}
	client := newTransportTestClient(service, "session-1")

	client.processTranslationCommit(validTranslationCommitPayload("session-1"))

	frames := readTransportTestFrames(t, client.send, 3)
	assertTransportEventSequence(t, frames, EventTranslationProgress, EventTTSAudio, EventTranslationCommitted)
	var progress TranslationProgressPayload
	if err := json.Unmarshal(frames[0].Payload, &progress); err != nil {
		t.Fatalf("decode duplicate progress: %v", err)
	}
	if progress.Stage != classroom.TranslationProgressStageSynthesizing {
		t.Fatalf("unexpected duplicate progress: %+v", progress)
	}
	var committed TranslationCommittedPayload
	if err := json.Unmarshal(frames[2].Payload, &committed); err != nil {
		t.Fatalf("decode duplicate acknowledgement: %v", err)
	}
	if !committed.Duplicate {
		t.Fatalf("duplicate acknowledgement was not marked duplicate: %+v", committed)
	}
}

func TestProcessTranslationCommit_TTSFailurePreservesTerminalOrder(t *testing.T) {
	service := &transportTestService{
		commitTranslation: func(_ context.Context, input classroom.TranslationCommitInput, emit classroom.PipelineEventSink) error {
			emit(progressPipelineEvent(input, classroom.TranslationProgressStageReviewing))
			emit(progressPipelineEvent(input, classroom.TranslationProgressStagePersisting))
			emit(progressPipelineEvent(input, classroom.TranslationProgressStageSynthesizing))
			emit(classroom.PipelineEvent{
				Type:      classroom.PipelineError,
				SessionID: input.SessionID,
				CommitId:  input.CommitId,
				CommitNo:  input.CommitNo,
				Code:      classroom.PipeErrTTSFailed,
				Message:   "text-to-speech failed",
			})
			emit(classroom.PipelineEvent{
				Type:      classroom.PipelineTranslationCommitted,
				SessionID: input.SessionID,
				CommitId:  input.CommitId,
				CommitNo:  input.CommitNo,
			})

			return nil
		},
	}
	client := newTransportTestClient(service, "session-1")

	client.processTranslationCommit(validTranslationCommitPayload("session-1"))

	frames := readTransportTestFrames(t, client.send, 5)
	assertTransportEventSequence(t, frames,
		EventTranslationProgress,
		EventTranslationProgress,
		EventTranslationProgress,
		EventError,
		EventTranslationCommitted,
	)
	var errorPayload ErrorPayload
	if err := json.Unmarshal(frames[3].Payload, &errorPayload); err != nil {
		t.Fatalf("decode TTS error: %v", err)
	}
	if errorPayload.Code != ErrCodeTTSFailed || errorPayload.SessionID != "session-1" || errorPayload.CommitId != "commit-1" || errorPayload.CommitNo != 1 {
		t.Fatalf("unexpected correlated TTS error: %+v", errorPayload)
	}
}

func TestProcessTranslationCommit_FatalErrorRemainsCorrelated(t *testing.T) {
	service := &transportTestService{
		commitTranslation: func(_ context.Context, input classroom.TranslationCommitInput, emit classroom.PipelineEventSink) error {
			emit(progressPipelineEvent(input, classroom.TranslationProgressStageReviewing))
			emit(progressPipelineEvent(input, classroom.TranslationProgressStagePersisting))

			return errors.New("persistence unavailable")
		},
	}
	client := newTransportTestClient(service, "session-1")

	client.processTranslationCommit(validTranslationCommitPayload("session-1"))

	frames := readTransportTestFrames(t, client.send, 3)
	assertTransportEventSequence(t, frames, EventTranslationProgress, EventTranslationProgress, EventError)
	var errorPayload ErrorPayload
	if err := json.Unmarshal(frames[2].Payload, &errorPayload); err != nil {
		t.Fatalf("decode fatal error: %v", err)
	}
	if errorPayload.Code != ErrCodeInternal || errorPayload.SessionID != "session-1" || errorPayload.CommitId != "commit-1" || errorPayload.CommitNo != 1 {
		t.Fatalf("unexpected correlated fatal error: %+v", errorPayload)
	}
}

func TestProcessTranslationCommit_BackpressureDoesNotDropAcknowledgement(t *testing.T) {
	handled := make(chan struct{})
	service := &transportTestService{
		commitTranslation: func(_ context.Context, input classroom.TranslationCommitInput, emit classroom.PipelineEventSink) error {
			close(handled)
			emit(classroom.PipelineEvent{
				Type:      classroom.PipelineTranslationCommitted,
				SessionID: input.SessionID,
				CommitId:  input.CommitId,
				CommitNo:  input.CommitNo,
			})

			return nil
		},
	}
	client := newTransportTestClient(service, "session-1")
	client.send = make(chan []byte, 1)
	client.send <- []byte("occupied")

	done := make(chan struct{})
	go func() {
		client.processTranslationCommit(validTranslationCommitPayload("session-1"))
		close(done)
	}()
	<-handled
	<-client.send

	select {
	case raw := <-client.send:
		var frame Envelope
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatalf("decode acknowledgement: %v", err)
		}
		if frame.Event != EventTranslationCommitted {
			t.Fatalf("expected critical acknowledgement, got %q", frame.Event)
		}
	case <-time.After(time.Second):
		t.Fatalf("commit acknowledgement was dropped under backpressure")
	}
	<-done
}

func TestProcessTranslationCommit_BackpressureDoesNotBlockProgress(t *testing.T) {
	handled := make(chan struct{})
	service := &transportTestService{
		commitTranslation: func(_ context.Context, input classroom.TranslationCommitInput, emit classroom.PipelineEventSink) error {
			close(handled)
			emit(progressPipelineEvent(input, classroom.TranslationProgressStageReviewing))

			return nil
		},
	}
	client := newTransportTestClient(service, "session-1")
	client.send = make(chan []byte, 1)
	client.send <- []byte("occupied")

	done := make(chan struct{})
	go func() {
		client.processTranslationCommit(validTranslationCommitPayload("session-1"))
		close(done)
	}()
	<-handled

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("translation progress blocked session processing under backpressure")
	}
	if got := <-client.send; string(got) != "occupied" {
		t.Fatalf("unexpected frame replaced the full queue entry: %q", got)
	}
}

func TestDispatch_RejectsCommitForUnjoinedSession(t *testing.T) {
	called := false
	service := &transportTestService{
		commitTranslation: func(context.Context, classroom.TranslationCommitInput, classroom.PipelineEventSink) error {
			called = true

			return nil
		},
	}
	client := newTransportTestClient(service, "session-1")
	payload, err := json.Marshal(validTranslationCommitPayload("session-2"))
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	client.dispatch(Envelope{Event: EventTranslationCommit, Payload: payload})
	frames := readTransportTestFrames(t, client.send, 1)
	if called {
		t.Fatalf("commit for an unjoined session reached the service")
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

func TestProcessTranslationCommit_MapsIdempotencyConflict(t *testing.T) {
	service := &transportTestService{
		commitTranslation: func(context.Context, classroom.TranslationCommitInput, classroom.PipelineEventSink) error {
			return classroom.ErrCommitConflict
		},
	}
	client := newTransportTestClient(service, "session-1")

	client.processTranslationCommit(validTranslationCommitPayload("session-1"))

	frames := readTransportTestFrames(t, client.send, 1)
	var payload ErrorPayload
	if err := json.Unmarshal(frames[0].Payload, &payload); err != nil {
		t.Fatalf("decode conflict error: %v", err)
	}
	if payload.Code != ErrCodeCommitConflict || payload.CommitId != "commit-1" || payload.CommitNo != 1 {
		t.Fatalf("unexpected conflict error: %+v", payload)
	}
}

func TestHandleJoin_RejectsConnectionRebind(t *testing.T) {
	service := &transportTestService{}
	client := newTransportTestClient(service, "session-1")

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
	client := newTransportTestClient(service, "session-1")

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

func newTransportTestClient(service classroom.SessionService, sessionID string) *Client {
	hub := NewHub()
	client := &Client{
		send: make(chan []byte, 8),
		hub:  hub,
		svc:  service,
		log:  slog.Default(),
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
