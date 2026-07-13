package classroom

import (
	"context"
	"errors"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ai-classroom/backend/internal/ai_client"
)

type memRepo struct {
	mu       sync.Mutex
	sessions map[string]*Session
	messages map[string][]Message
	summary  map[string]*Summary
	vocab    map[string][]Vocabulary
	cards    map[string][]Flashcard

	afterImageReplace     chan struct{}
	afterImageReplaceOnce sync.Once
	failCompleteOnce      bool
	beforeCommit          func()
	commitErr             error
	commitOverride        *Message
}

func newMemRepo() *memRepo {
	return &memRepo{
		sessions: map[string]*Session{},
		messages: map[string][]Message{},
		summary:  map[string]*Summary{},
		vocab:    map[string][]Vocabulary{},
		cards:    map[string][]Flashcard{},
	}
}

func (m *memRepo) CreateSession(_ context.Context, s *Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.sessions[s.SessionID] = s
	return nil
}

func (m *memRepo) GetSession(_ context.Context, id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrSessionNotFound
	}
	copy := *s

	return &copy, nil
}

func (m *memRepo) ListSessions(_ context.Context) ([]Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, *s)
	}
	return out, nil
}

func (m *memRepo) TryStartSessionProcessing(_ context.Context, id string) (*Session, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[id]
	if !ok {
		return nil, false, ErrSessionNotFound
	}
	if s.Status != StatusActive && s.Status != StatusFailed {
		copy := *s

		return &copy, false, nil
	}
	s.Status = StatusProcessing
	copy := *s

	return &copy, true, nil
}

func (m *memRepo) UpdateSessionStatus(_ context.Context, id, status string, endedAt *time.Time) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if status == StatusCompleted && m.failCompleteOnce {
		m.failCompleteOnce = false

		return nil, errors.New("temporary completion write failure")
	}

	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrSessionNotFound
	}
	s.Status = status
	if endedAt != nil {
		s.EndedAt = endedAt
	}
	copy := *s

	return &copy, nil
}

func (m *memRepo) CommitMessage(_ context.Context, message *Message) (*Message, bool, error) {
	if m.beforeCommit != nil {
		m.beforeCommit()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.commitErr != nil {
		return nil, false, m.commitErr
	}
	if m.commitOverride != nil {
		copy := *m.commitOverride

		return &copy, false, nil
	}

	for i := range m.messages[message.SessionID] {
		existing := &m.messages[message.SessionID][i]
		if existing.CommitId == message.CommitId {
			copy := *existing

			return &copy, false, nil
		}
		if existing.CommitNo == message.CommitNo {
			return nil, false, ErrCommitConflict
		}
	}
	session, ok := m.sessions[message.SessionID]
	if !ok {
		return nil, false, ErrSessionNotFound
	}
	if session.Status != StatusActive {
		return nil, false, ErrSessionNotActive
	}
	message.SequenceNo = message.CommitNo
	m.messages[message.SessionID] = append(m.messages[message.SessionID], *message)
	copy := *message

	return &copy, true, nil
}

func (m *memRepo) GetMessageByCommitId(_ context.Context, sessionID, commitId string) (*Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for i := range m.messages[sessionID] {
		if m.messages[sessionID][i].CommitId == commitId {
			copy := m.messages[sessionID][i]

			return &copy, nil
		}
	}

	return nil, nil
}

func (m *memRepo) ListMessages(_ context.Context, id string) ([]Message, error) {
	out := append([]Message(nil), m.messages[id]...)
	sort.Slice(out, func(i, j int) bool { return out[i].SequenceNo < out[j].SequenceNo })
	return out, nil
}

func (m *memRepo) DeleteMessages(_ context.Context, id string) error {
	delete(m.messages, id)
	if session := m.sessions[id]; session != nil {
	}
	return nil
}

func (m *memRepo) UpsertSummary(_ context.Context, s *Summary) error {
	m.summary[s.SessionID] = s
	return nil
}

func (m *memRepo) DeleteSummary(_ context.Context, id string) error {
	delete(m.summary, id)

	return nil
}

func (m *memRepo) ReplaceVocabularies(_ context.Context, id string, v []Vocabulary) error {
	m.vocab[id] = v
	return nil
}

func (m *memRepo) ReplaceFlashcards(_ context.Context, id string, c []Flashcard) error {
	m.cards[id] = c
	return nil
}

func (m *memRepo) UpdateFlashcardImageStates(_ context.Context, id string, updates []FlashcardImageUpdate) error {
	for i := range m.cards[id] {
		for _, update := range updates {
			card := &m.cards[id][i]
			if card.Front != update.Front || card.Back != update.Back || card.Type != update.Type || card.Word != update.Word {
				continue
			}
			card.ImageURL = update.ImageURL
			card.ImageStatus = update.ImageStatus
		}
	}
	if m.afterImageReplace != nil {
		for _, card := range m.cards[id] {
			if card.ImageURL != "" {
				m.afterImageReplaceOnce.Do(func() { close(m.afterImageReplace) })
				break
			}
		}
	}
	return nil
}

func (m *memRepo) GetSummary(_ context.Context, id string) (*Summary, error) {
	return m.summary[id], nil
}

func (m *memRepo) GetVocabularies(_ context.Context, id string) ([]Vocabulary, error) {
	return m.vocab[id], nil
}

func (m *memRepo) GetFlashcards(_ context.Context, id string) ([]Flashcard, error) {
	return m.cards[id], nil
}

type fakeAI struct {
	mu          sync.Mutex
	ttsErr      error
	beforeTTS   func()
	secret      *ai_client.RealtimeTranslationClientSecret
	mintErr     error
	finalize    *ai_client.FinalizeResponse
	images      []ai_client.FinalizeFlashcard
	lastVoice   string
	lastSpeed   string
	lastTTSText string
	lastReview  ai_client.TranslationReviewRequest
	reviewErr   error
	reviewFn    func(context.Context, ai_client.TranslationReviewRequest) (*ai_client.TranslationReviewResponse, error)
	ttsFn       func(context.Context, string, string, string, string) (*ai_client.TTSResponse, error)
	finalizeFn  func(context.Context, string, []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error)
	mintCalls   atomic.Int32
	reviewCalls atomic.Int32
	ttsCalls    atomic.Int32
	finalCalls  atomic.Int32
	imageCalls  atomic.Int32
}

func (f *fakeAI) ReviewTranslation(ctx context.Context, request ai_client.TranslationReviewRequest) (*ai_client.TranslationReviewResponse, error) {
	f.reviewCalls.Add(1)
	f.mu.Lock()
	f.lastReview = request
	f.mu.Unlock()
	if f.reviewErr != nil {
		return nil, f.reviewErr
	}
	if f.reviewFn != nil {
		return f.reviewFn(ctx, request)
	}

	return &ai_client.TranslationReviewResponse{
		Status:         string(TranslationReviewStatusAccepted),
		TranslatedText: request.CandidateTranslatedText,
	}, nil
}

func (f *fakeAI) MintRealtimeTranslationClientSecret(context.Context, string) (*ai_client.RealtimeTranslationClientSecret, error) {
	f.mintCalls.Add(1)
	if f.mintErr != nil {
		return nil, f.mintErr
	}
	if f.secret != nil {
		return f.secret, nil
	}

	return &ai_client.RealtimeTranslationClientSecret{
		ClientSecret:         "ek_test",
		ExpiresAt:            1_800_000_000,
		TranslationSessionId: "sess_translation",
		Model:                "gpt-realtime-translate",
		TargetLanguage:       TargetLanguage,
	}, nil
}

func (f *fakeAI) TTS(ctx context.Context, sessionID, text, voiceProfile, speechSpeed string) (*ai_client.TTSResponse, error) {
	f.ttsCalls.Add(1)
	f.mu.Lock()
	f.lastVoice = voiceProfile
	f.lastSpeed = speechSpeed
	f.lastTTSText = text
	f.mu.Unlock()
	if f.beforeTTS != nil {
		f.beforeTTS()
	}
	if f.ttsErr != nil {
		return nil, f.ttsErr
	}
	if f.ttsFn != nil {
		return f.ttsFn(ctx, sessionID, text, voiceProfile, speechSpeed)
	}

	return &ai_client.TTSResponse{AudioBase64: "YQ==", Language: TargetLanguage, DurationMs: 100, PlaybackRate: 0.72}, nil
}

func (f *fakeAI) Finalize(ctx context.Context, sessionID string, messages []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error) {
	f.finalCalls.Add(1)
	if f.finalizeFn != nil {
		return f.finalizeFn(ctx, sessionID, messages)
	}
	if f.finalize == nil {
		return &ai_client.FinalizeResponse{}, nil
	}
	return f.finalize, nil
}

func (f *fakeAI) GenerateFlashcardImages(_ context.Context, _ string, flashcards []ai_client.FinalizeFlashcard, _ []ai_client.FinalizeVocabulary) ([]ai_client.FinalizeFlashcard, error) {
	f.imageCalls.Add(1)
	if f.images != nil {
		return f.images, nil
	}
	return flashcards, nil
}

func (f *fakeAI) GetFlashcardImage(_ context.Context, _ string) (*ai_client.BinaryAsset, error) {
	return &ai_client.BinaryAsset{ContentType: "image/webp", Body: []byte("image")}, nil
}

func activeSession(repo *memRepo) string {
	id := "sess-1"
	repo.sessions[id] = &Session{SessionID: id, Status: StatusActive, SourceLanguage: SourceLanguage, TargetLanguage: TargetLanguage}
	return id
}

func translationCommit(sessionID, commitId string, commitNo int) TranslationCommitInput {
	return TranslationCommitInput{
		SessionID:            sessionID,
		TranslationSessionId: "sess_translation",
		CommitId:             commitId,
		CommitNo:             commitNo,
		CommitKind:           TranslationCommitKindDebounced,
		SourceText:           "สวัสดี",
		TranslatedText:       "hello",
		SourceElapsedMs:      1000,
		TargetElapsedMs:      1200,
	}
}

func canonicalMessage(sessionID, sourceText, translatedText string) Message {
	return Message{
		SessionID:      sessionID,
		SourceText:     sourceText,
		TranslatedText: translatedText,
		ReviewStatus:   TranslationReviewStatusAccepted,
	}
}

func assertPipelineEventSequence(t *testing.T, events []PipelineEvent, want ...PipelineEventType) {
	t.Helper()
	if len(events) != len(want) {
		t.Fatalf("unexpected event count: want %d, got %d: %+v", len(want), len(events), events)
	}
	for i, eventType := range want {
		if events[i].Type != eventType {
			t.Fatalf("unexpected event %d: want %q, got %q: %+v", i, eventType, events[i].Type, events)
		}
	}
}

func TestCommitTranslationStream_HappyPath(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	svc := NewService(repo, &fakeAI{}, nil)

	var events []PipelineEvent
	err := svc.CommitTranslationStream(context.Background(), translationCommit(id, "commit-1", 1), func(event PipelineEvent) {
		if event.Type == PipelineTranslationProgress {
			if !svc.messageOrderMu.TryLock() {
				t.Fatalf("progress %q emitted while messageOrderMu was held", event.Stage)
			}
			svc.messageOrderMu.Unlock()
		}
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertPipelineEventSequence(t, events,
		PipelineTranslationProgress,
		PipelineTranslationProgress,
		PipelineTranslationProgress,
		PipelineTTSAudio,
		PipelineTranslationCommitted,
	)
	stages := []TranslationProgressStage{
		TranslationProgressStageReviewing,
		TranslationProgressStagePersisting,
		TranslationProgressStageSynthesizing,
	}
	for i, stage := range stages {
		if events[i].Stage != stage || events[i].SessionID != id || events[i].CommitId != "commit-1" || events[i].CommitNo != 1 {
			t.Fatalf("unexpected progress event %d: %+v", i, events[i])
		}
	}
	msgs := repo.messages[id]
	if len(msgs) != 1 || msgs[0].CommitId != "commit-1" || msgs[0].SourceText != "สวัสดี" || msgs[0].TranslatedText != "hello" {
		t.Fatalf("message not persisted correctly: %+v", msgs)
	}
}

func TestCommitTranslationStream_ReviewsBeforePersistenceAndTTS(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.sessions[id].ContextNote = "บทเรียนเรื่องผลไม้"
	var events []PipelineEvent
	ai := &fakeAI{
		reviewFn: func(_ context.Context, request ai_client.TranslationReviewRequest) (*ai_client.TranslationReviewResponse, error) {
			assertPipelineEventSequence(t, events, PipelineTranslationProgress)
			if events[0].Stage != TranslationProgressStageReviewing {
				t.Fatalf("reviewing progress was not emitted immediately before review: %+v", events)
			}

			return &ai_client.TranslationReviewResponse{
				Status:         string(TranslationReviewStatusCorrected),
				TranslatedText: "Star gooseberry and tamarind.",
			}, nil
		},
	}
	repo.beforeCommit = func() {
		assertPipelineEventSequence(t, events, PipelineTranslationProgress, PipelineTranslationProgress)
		if events[1].Stage != TranslationProgressStagePersisting {
			t.Fatalf("persisting progress was not emitted before persistence: %+v", events)
		}
	}
	ai.beforeTTS = func() {
		assertPipelineEventSequence(t, events,
			PipelineTranslationProgress,
			PipelineTranslationProgress,
			PipelineTranslationProgress,
		)
		if events[2].Stage != TranslationProgressStageSynthesizing {
			t.Fatalf("synthesizing progress was not emitted immediately before TTS: %+v", events)
		}
		repo.mu.Lock()
		defer repo.mu.Unlock()
		if len(repo.messages[id]) != 1 || repo.messages[id][0].ReviewStatus != TranslationReviewStatusCorrected {
			t.Fatalf("canonical translation was not durable before TTS: %+v", repo.messages[id])
		}
	}
	svc := NewService(repo, ai, nil)
	input := translationCommit(id, "commit-1", 1)
	input.SourceText = "มะยม มะขาม"
	input.TranslatedText = "It's not makha, khai makham."

	err := svc.CommitTranslationStream(context.Background(), input, func(event PipelineEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ai.lastReview.ContextNote != "บทเรียนเรื่องผลไม้" || ai.lastReview.SourceText != input.SourceText {
		t.Fatalf("review did not receive canonical context: %+v", ai.lastReview)
	}
	if ai.lastTTSText != "Star gooseberry and tamarind." {
		t.Fatalf("TTS received unreviewed text: %q", ai.lastTTSText)
	}
	if len(repo.messages[id]) != 1 || repo.messages[id][0].TranslatedText != "Star gooseberry and tamarind." || repo.messages[id][0].ReviewStatus != TranslationReviewStatusCorrected {
		t.Fatalf("canonical translation was not persisted: %+v", repo.messages[id])
	}
	assertPipelineEventSequence(t, events,
		PipelineTranslationProgress,
		PipelineTranslationProgress,
		PipelineTranslationProgress,
		PipelineTTSAudio,
		PipelineTranslationCommitted,
	)
	if events[4].TranslatedText != "Star gooseberry and tamarind." || events[4].ReviewStatus != TranslationReviewStatusCorrected {
		t.Fatalf("canonical commit event missing: %+v", events)
	}
}

func TestCommitTranslationStream_ReviewFailureRejectsWithoutSideEffects(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	ai := &fakeAI{reviewErr: errors.New("provider unavailable")}
	svc := NewService(repo, ai, nil)

	var events []PipelineEvent
	err := svc.CommitTranslationStream(context.Background(), translationCommit(id, "commit-1", 1), func(event PipelineEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("review rejection is a terminal stream outcome, got: %v", err)
	}
	if len(repo.messages[id]) != 0 || ai.ttsCalls.Load() != 0 {
		t.Fatalf("rejected translation caused side effects: messages=%d tts=%d", len(repo.messages[id]), ai.ttsCalls.Load())
	}
	assertPipelineEventSequence(t, events, PipelineTranslationProgress, PipelineTranslationRejected)
	if events[0].Stage != TranslationProgressStageReviewing || !events[1].Retryable || events[1].Code != PipeErrTranslationReviewFailed {
		t.Fatalf("unexpected rejection event: %+v", events)
	}
}

func TestCommitTranslationStream_PersistenceFailureStopsBeforeSynthesis(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.commitErr = errors.New("persistence unavailable")
	ai := &fakeAI{}
	svc := NewService(repo, ai, nil)

	var events []PipelineEvent
	err := svc.CommitTranslationStream(context.Background(), translationCommit(id, "commit-1", 1), func(event PipelineEvent) {
		events = append(events, event)
	})
	if !errors.Is(err, repo.commitErr) {
		t.Fatalf("expected fatal persistence error, got %v", err)
	}
	assertPipelineEventSequence(t, events, PipelineTranslationProgress, PipelineTranslationProgress)
	if events[0].Stage != TranslationProgressStageReviewing || events[1].Stage != TranslationProgressStagePersisting {
		t.Fatalf("unexpected persistence failure progress: %+v", events)
	}
	if ai.ttsCalls.Load() != 0 || len(repo.messages[id]) != 0 {
		t.Fatalf("persistence failure reached TTS or durable storage: tts=%d messages=%d", ai.ttsCalls.Load(), len(repo.messages[id]))
	}
}

func TestCommitTranslationStream_LegacyDuplicateIsRejectedWithoutTTS(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	input := translationCommit(id, "commit-1", 1)
	input.VoiceProfile = normalizeTTSVoiceProfile(input.VoiceProfile)
	input.SpeechSpeed = normalizeTTSSpeechSpeed(input.SpeechSpeed)
	repo.messages[id] = []Message{{
		SessionID:      id,
		CommitId:       input.CommitId,
		CommitHash:     translationCommitHash(input),
		CommitNo:       input.CommitNo,
		SequenceNo:     input.CommitNo,
		SourceText:     input.SourceText,
		TranslatedText: input.TranslatedText,
	}}
	ai := &fakeAI{}
	svc := NewService(repo, ai, nil)

	var events []PipelineEvent
	err := svc.CommitTranslationStream(context.Background(), input, func(event PipelineEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("legacy rejection should be a terminal stream outcome: %v", err)
	}
	if ai.reviewCalls.Load() != 0 || ai.ttsCalls.Load() != 0 {
		t.Fatalf("legacy message reached review/TTS: review=%d tts=%d", ai.reviewCalls.Load(), ai.ttsCalls.Load())
	}
	assertPipelineEventSequence(t, events, PipelineTranslationRejected)
}

func TestCommitTranslationStream_ConcurrentLegacyInsertIsRejectedBeforeTTS(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	input := translationCommit(id, "commit-1", 1)
	input.VoiceProfile = normalizeTTSVoiceProfile(input.VoiceProfile)
	input.SpeechSpeed = normalizeTTSSpeechSpeed(input.SpeechSpeed)
	repo.commitOverride = &Message{
		SessionID:      id,
		CommitId:       input.CommitId,
		CommitHash:     translationCommitHash(input),
		CommitNo:       input.CommitNo,
		SequenceNo:     input.CommitNo,
		SourceText:     input.SourceText,
		TranslatedText: input.TranslatedText,
	}
	ai := &fakeAI{}
	svc := NewService(repo, ai, nil)

	var events []PipelineEvent
	err := svc.CommitTranslationStream(context.Background(), input, func(event PipelineEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("legacy race rejection should be terminal: %v", err)
	}
	if ai.reviewCalls.Load() != 1 || ai.ttsCalls.Load() != 0 {
		t.Fatalf("legacy race reached TTS: review=%d tts=%d", ai.reviewCalls.Load(), ai.ttsCalls.Load())
	}
	assertPipelineEventSequence(t, events,
		PipelineTranslationProgress,
		PipelineTranslationProgress,
		PipelineTranslationRejected,
	)
	if events[0].Stage != TranslationProgressStageReviewing || events[1].Stage != TranslationProgressStagePersisting {
		t.Fatalf("unexpected legacy race events: %+v", events)
	}
}

func TestCommitTranslationStream_TTSFailureIsNonFatal(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	svc := NewService(repo, &fakeAI{ttsErr: errors.New("boom")}, nil)

	var events []PipelineEvent
	err := svc.CommitTranslationStream(context.Background(), translationCommit(id, "commit-1", 1), func(event PipelineEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("tts failure must not be fatal, got err: %v", err)
	}
	assertPipelineEventSequence(t, events,
		PipelineTranslationProgress,
		PipelineTranslationProgress,
		PipelineTranslationProgress,
		PipelineError,
		PipelineTranslationCommitted,
	)
	if events[2].Stage != TranslationProgressStageSynthesizing || events[3].Code != PipeErrTTSFailed {
		t.Fatalf("expected TTS error followed by acknowledgement, got: %+v", events)
	}
	// Translation must still be persisted.
	if got := repo.messages[id]; len(got) != 1 || got[0].TranslatedText != "hello" {
		t.Fatalf("translation should persist despite TTS failure: %+v", got)
	}
}

func TestCommitTranslationStream_EmitsAcknowledgementAfterTTS(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	emitted := make([]PipelineEvent, 0, 3)
	ai := &fakeAI{
		beforeTTS: func() {
			assertPipelineEventSequence(t, emitted,
				PipelineTranslationProgress,
				PipelineTranslationProgress,
				PipelineTranslationProgress,
			)
		},
	}
	svc := NewService(repo, ai, nil)

	err := svc.CommitTranslationStream(context.Background(), translationCommit(id, "commit-1", 1), func(event PipelineEvent) {
		emitted = append(emitted, event)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertPipelineEventSequence(t, emitted,
		PipelineTranslationProgress,
		PipelineTranslationProgress,
		PipelineTranslationProgress,
		PipelineTTSAudio,
		PipelineTranslationCommitted,
	)
	if emitted[2].Stage != TranslationProgressStageSynthesizing {
		t.Fatalf("expected TTS audio before acknowledgement, got: %+v", emitted)
	}
}

func TestCommitTranslationStream_PassesVoiceAndSpeedToTTS(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	ai := &fakeAI{}
	svc := NewService(repo, ai, nil)

	var emitted []PipelineEvent
	input := translationCommit(id, "commit-1", 1)
	input.VoiceProfile = TTSVoiceProfileChildGirl
	input.SpeechSpeed = TTSSpeechSpeedSlow
	err := svc.CommitTranslationStream(context.Background(), input, func(event PipelineEvent) {
		emitted = append(emitted, event)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ai.lastVoice != TTSVoiceProfileChildGirl || ai.lastSpeed != TTSSpeechSpeedSlow {
		t.Fatalf("voice/speed not passed to TTS: voice=%q speed=%q", ai.lastVoice, ai.lastSpeed)
	}
	ttsEvent := emitted[3]
	if ttsEvent.Type != PipelineTTSAudio || ttsEvent.VoiceProfile != TTSVoiceProfileChildGirl || ttsEvent.SpeechSpeed != TTSSpeechSpeedSlow {
		t.Fatalf("tts event missing voice/speed: %+v", ttsEvent)
	}
}

func TestCommitTranslationStream_DuplicatePersistsOnceAndRetriesTTS(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	ai := &fakeAI{}
	svc := NewService(repo, ai, nil)
	input := translationCommit(id, "commit-1", 1)

	if err := svc.CommitTranslationStream(context.Background(), input, nil); err != nil {
		t.Fatalf("first commit: %v", err)
	}
	var retryEvents []PipelineEvent
	if err := svc.CommitTranslationStream(context.Background(), input, func(event PipelineEvent) {
		retryEvents = append(retryEvents, event)
	}); err != nil {
		t.Fatalf("duplicate commit: %v", err)
	}

	if len(repo.messages[id]) != 1 || ai.ttsCalls.Load() != 2 {
		t.Fatalf("duplicate side effects messages=%d ttsCalls=%d", len(repo.messages[id]), ai.ttsCalls.Load())
	}
	if ai.reviewCalls.Load() != 1 {
		t.Fatalf("duplicate commit should reuse canonical review, calls=%d", ai.reviewCalls.Load())
	}
	assertPipelineEventSequence(t, retryEvents,
		PipelineTranslationProgress,
		PipelineTTSAudio,
		PipelineTranslationCommitted,
	)
	if retryEvents[0].Stage != TranslationProgressStageSynthesizing || !retryEvents[2].Duplicate {
		t.Fatalf("unexpected duplicate acknowledgement: %+v", retryEvents)
	}
}

func TestCommitTranslationStream_ConcurrentDuplicateReviewsOnce(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	reviewStarted := make(chan struct{})
	releaseReview := make(chan struct{})
	ai := &fakeAI{
		reviewFn: func(_ context.Context, request ai_client.TranslationReviewRequest) (*ai_client.TranslationReviewResponse, error) {
			close(reviewStarted)
			<-releaseReview

			return &ai_client.TranslationReviewResponse{
				Status:         string(TranslationReviewStatusAccepted),
				TranslatedText: request.CandidateTranslatedText,
			}, nil
		},
	}
	svc := NewService(repo, ai, nil)
	input := translationCommit(id, "commit-1", 1)
	errs := make(chan error, 2)

	go func() { errs <- svc.CommitTranslationStream(context.Background(), input, nil) }()
	<-reviewStarted
	go func() { errs <- svc.CommitTranslationStream(context.Background(), input, nil) }()
	close(releaseReview)

	for range 2 {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent duplicate failed: %v", err)
		}
	}
	if ai.reviewCalls.Load() != 1 || len(repo.messages[id]) != 1 {
		t.Fatalf("duplicate review/persistence calls=%d messages=%d", ai.reviewCalls.Load(), len(repo.messages[id]))
	}
}

func TestCommitTranslationStream_ConflictingCommitIsRejected(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	svc := NewService(repo, &fakeAI{}, nil)
	input := translationCommit(id, "commit-1", 1)

	if err := svc.CommitTranslationStream(context.Background(), input, nil); err != nil {
		t.Fatalf("first commit: %v", err)
	}
	input.TranslatedText = "different"
	if err := svc.CommitTranslationStream(context.Background(), input, nil); !errors.Is(err, ErrCommitConflict) {
		t.Fatalf("expected commit conflict, got %v", err)
	}
}

func TestCreateRealtimeTranslationClientSecret_RequiresActiveSession(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.messages[id] = []Message{{SessionID: id, SequenceNo: 4, CommitNo: 4}}
	ai := &fakeAI{}
	svc := NewService(repo, ai, nil)

	secret, err := svc.CreateRealtimeTranslationClientSecret(context.Background(), id)
	if err != nil || secret.ClientSecret != "ek_test" || secret.LastCommitNo != 4 || ai.mintCalls.Load() != 1 {
		t.Fatalf("active secret mint: secret=%+v calls=%d err=%v", secret, ai.mintCalls.Load(), err)
	}
	repo.sessions[id].Status = StatusCompleted
	if _, err := svc.CreateRealtimeTranslationClientSecret(context.Background(), id); !errors.Is(err, ErrSessionNotActive) {
		t.Fatalf("expected inactive session error, got %v", err)
	}
	if ai.mintCalls.Load() != 1 {
		t.Fatalf("inactive session reached ai-service: calls=%d", ai.mintCalls.Load())
	}
}

func TestCreateRealtimeTranslationClientSecret_SupersedesOlderTranslationSession(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	ai := &fakeAI{}
	svc := NewService(repo, ai, nil)

	if _, err := svc.CreateRealtimeTranslationClientSecret(context.Background(), id); err != nil {
		t.Fatalf("mint secret: %v", err)
	}
	oldCommit := translationCommit(id, "old-commit", 1)
	oldCommit.TranslationSessionId = "superseded-session"
	if err := svc.CommitTranslationStream(context.Background(), oldCommit, nil); !errors.Is(err, ErrCommitConflict) {
		t.Fatalf("expected superseded translation session conflict, got %v", err)
	}
	if len(repo.messages[id]) != 0 || ai.ttsCalls.Load() != 0 {
		t.Fatalf("superseded session produced side effects: messages=%d tts=%d", len(repo.messages[id]), ai.ttsCalls.Load())
	}
}

func TestUpdateSummary_PersistsTeacherEdits(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	createdAt := time.Now().UTC().Add(-time.Hour)
	repo.summary[id] = &Summary{
		SessionID:   id,
		SummaryTh:   "เดิม",
		SummaryEn:   "old",
		KeyPointsTh: []string{"ข้อเดิม"},
		KeyPointsEn: []string{"old point"},
		CreatedAt:   createdAt,
	}
	svc := NewService(repo, &fakeAI{}, nil)

	updated, err := svc.UpdateSummary(context.Background(), id, UpdateSummaryRequest{
		SummaryTh:   " ใหม่ ",
		SummaryEn:   " new ",
		KeyPointsTh: []string{" ข้อหนึ่ง ", "", "ข้อสอง"},
		KeyPointsEn: []string{" point one ", " ", "point two"},
	})
	if err != nil {
		t.Fatalf("update summary: %v", err)
	}
	if updated.SummaryTh != "ใหม่" || updated.SummaryEn != "new" {
		t.Fatalf("summary text not trimmed: %+v", updated)
	}
	if updated.CreatedAt != createdAt {
		t.Fatalf("createdAt should be preserved")
	}
	if len(updated.KeyPointsTh) != 2 || updated.KeyPointsTh[0] != "ข้อหนึ่ง" || updated.KeyPointsEn[1] != "point two" {
		t.Fatalf("key points not cleaned: %+v", updated)
	}
}

func TestListMessages_ReturnsOnlyCanonicalTranslations(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	canonical := canonicalMessage(id, "สวัสดี", "Hello")
	canonical.SequenceNo = 2
	repo.messages[id] = []Message{
		{SessionID: id, SequenceNo: 1, SourceText: "มะยม", TranslatedText: "makha"},
		canonical,
	}
	svc := NewService(repo, &fakeAI{}, nil)

	messages, err := svc.ListMessages(context.Background(), id)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(messages) != 1 || messages[0].TranslatedText != "Hello" {
		t.Fatalf("unreviewed translation escaped: %+v", messages)
	}
}

func TestResetSession_DrainsDuplicateCommitsBeforeDeleting(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	reviewStarted := make(chan struct{})
	reviewRelease := make(chan struct{})
	ai := &fakeAI{
		reviewFn: func(_ context.Context, request ai_client.TranslationReviewRequest) (*ai_client.TranslationReviewResponse, error) {
			close(reviewStarted)
			<-reviewRelease

			return &ai_client.TranslationReviewResponse{
				Status:         string(TranslationReviewStatusAccepted),
				TranslatedText: request.CandidateTranslatedText,
			}, nil
		},
	}
	svc := NewService(repo, ai, nil)
	input := translationCommit(id, "commit-1", 1)
	commitResults := make(chan error, 2)

	go func() { commitResults <- svc.CommitTranslationStream(context.Background(), input, nil) }()
	<-reviewStarted
	go func() { commitResults <- svc.CommitTranslationStream(context.Background(), input, nil) }()
	waitForInFlightCommitCount(t, svc, id, 2)

	resetDone := make(chan error, 1)
	go func() { resetDone <- svc.ResetSession(context.Background(), id) }()
	waitForCommitGateBlocked(t, svc, id)
	select {
	case err := <-resetDone:
		t.Fatalf("reset completed before duplicate commits drained: %v", err)
	default:
	}

	close(reviewRelease)
	for range 2 {
		if err := <-commitResults; err != nil {
			t.Fatalf("accepted duplicate commit failed: %v", err)
		}
	}
	if err := <-resetDone; err != nil {
		t.Fatalf("reset session: %v", err)
	}
	messages, err := repo.ListMessages(context.Background(), id)
	if err != nil || len(messages) != 0 {
		t.Fatalf("pre-reset commit was restored: messages=%+v err=%v", messages, err)
	}
	if ai.reviewCalls.Load() != 1 || ai.ttsCalls.Load() != 2 {
		t.Fatalf("unexpected duplicate processing: review=%d tts=%d", ai.reviewCalls.Load(), ai.ttsCalls.Load())
	}
}

func TestResetSession_RejectsOldTranslationGenerationUntilSecretRefresh(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	ai := &fakeAI{}
	svc := NewService(repo, ai, nil)

	if _, err := svc.CreateRealtimeTranslationClientSecret(context.Background(), id); err != nil {
		t.Fatalf("mint initial secret: %v", err)
	}
	if err := svc.ResetSession(context.Background(), id); err != nil {
		t.Fatalf("reset session: %v", err)
	}
	input := translationCommit(id, "old-generation-commit", 1)
	if err := svc.CommitTranslationStream(context.Background(), input, nil); !errors.Is(err, ErrCommitConflict) {
		t.Fatalf("old translation generation should be rejected, got %v", err)
	}
	if ai.reviewCalls.Load() != 0 || ai.ttsCalls.Load() != 0 {
		t.Fatalf("old generation reached AI: review=%d tts=%d", ai.reviewCalls.Load(), ai.ttsCalls.Load())
	}

	if _, err := svc.CreateRealtimeTranslationClientSecret(context.Background(), id); err != nil {
		t.Fatalf("mint replacement secret: %v", err)
	}
	input.CommitId = "new-generation-commit"
	if err := svc.CommitTranslationStream(context.Background(), input, nil); err != nil {
		t.Fatalf("new translation generation was not accepted: %v", err)
	}
}

func TestCommitTranslationStream_UnknownSession(t *testing.T) {
	repo := newMemRepo()
	svc := NewService(repo, &fakeAI{}, nil)
	err := svc.CommitTranslationStream(context.Background(), translationCommit("missing", "commit-1", 1), nil)
	if !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("expected unknown session error, got %v", err)
	}
}

func TestCommitTranslationStream_InvalidPayload(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	svc := NewService(repo, &fakeAI{}, nil)
	input := translationCommit(id, "commit-1", 1)
	input.TranslatedText = "   "
	if err := svc.CommitTranslationStream(context.Background(), input, nil); !errors.Is(err, ErrInvalidTranslationCommit) {
		t.Fatalf("expected invalid commit error, got %v", err)
	}
}

func TestEndSession_FinalizesAndIsIdempotent(t *testing.T) {
	repo := newMemRepo()
	repo.afterImageReplace = make(chan struct{})
	id := activeSession(repo)
	repo.messages[id] = []Message{canonicalMessage(id, "a", "b")}

	fin := &ai_client.FinalizeResponse{
		Summary:      ai_client.FinalizeSummary{SummaryEn: "sum"},
		Vocabularies: []ai_client.FinalizeVocabulary{{Word: "hello", DictionarySource: "AI Classroom glossary"}},
		Flashcards:   []ai_client.FinalizeFlashcard{{Front: "f", Back: "b", Type: FlashcardTypeVocabulary}},
	}
	images := []ai_client.FinalizeFlashcard{{Front: "f", Back: "b", Type: FlashcardTypeVocabulary, ImageURL: "/api/image.webp", ImageStatus: FlashcardImageStatusReady}}
	svc := NewService(repo, &fakeAI{finalize: fin, images: images}, nil)

	out, err := svc.EndSession(context.Background(), id)
	if err != nil {
		t.Fatalf("end session: %v", err)
	}
	if out.Status != StatusCompleted {
		t.Fatalf("want completed, got %s", out.Status)
	}
	if repo.summary[id] == nil || len(repo.vocab[id]) != 1 {
		t.Fatalf("derived artifacts not persisted")
	}
	if repo.vocab[id][0].DictionarySource != "AI Classroom glossary" {
		t.Fatalf("dictionary source not persisted: %+v", repo.vocab[id][0])
	}
	select {
	case <-repo.afterImageReplace:
	case <-time.After(2 * time.Second):
		t.Fatalf("flashcard image job did not update cards")
	}
	if cards, _ := repo.GetFlashcards(context.Background(), id); cards[0].ImageURL != "/api/image.webp" {
		t.Fatalf("flashcard image URL not persisted: %+v", cards[0])
	}
	if cards, _ := repo.GetFlashcards(context.Background(), id); cards[0].ImageStatus != FlashcardImageStatusReady {
		t.Fatalf("flashcard image status not persisted: %+v", cards[0])
	}

	// Idempotency: a second end on a completed session is a no-op success.
	out2, err := svc.EndSession(context.Background(), id)
	if err != nil || out2.Status != StatusCompleted {
		t.Fatalf("idempotent end failed: status=%v err=%v", out2.Status, err)
	}
}

func TestGetFlashcardImageRequiresSessionOwnedURL(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.cards[id] = []Flashcard{{
		SessionID:   id,
		Front:       "apple",
		Back:        "apple",
		Type:        FlashcardTypeVocabulary,
		Word:        "apple",
		ImageURL:    "/api/classroom-sessions/sess-1/flashcard-images/apple-123.webp",
		ImageStatus: FlashcardImageStatusReady,
		CreatedAt:   time.Now().UTC(),
	}}
	svc := NewService(repo, &fakeAI{}, nil)

	asset, err := svc.GetFlashcardImage(context.Background(), id, "apple-123.webp")
	if err != nil {
		t.Fatalf("expected owned image to load: %v", err)
	}
	if string(asset.Body) != "image" {
		t.Fatalf("unexpected image body: %q", string(asset.Body))
	}

	_, err = svc.GetFlashcardImage(context.Background(), id, "other-123.webp")
	if !errors.Is(err, ErrFlashcardImageNotFound) {
		t.Fatalf("expected unowned image to be rejected, got %v", err)
	}
}

func TestCommitTranslationStream_TTSMissingAudioEmitsFailure(t *testing.T) {
	tests := []struct {
		name     string
		response *ai_client.TTSResponse
	}{
		{name: "nil response", response: nil},
		{name: "empty response", response: &ai_client.TTSResponse{}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repo := newMemRepo()
			id := activeSession(repo)
			ai := &fakeAI{
				ttsFn: func(context.Context, string, string, string, string) (*ai_client.TTSResponse, error) {
					return test.response, nil
				},
			}
			svc := NewService(repo, ai, nil)

			var events []PipelineEvent
			err := svc.CommitTranslationStream(context.Background(), translationCommit(id, "commit-1", 1), func(event PipelineEvent) {
				events = append(events, event)
			})
			if err != nil {
				t.Fatalf("missing TTS audio must be non-fatal: %v", err)
			}
			assertPipelineEventSequence(t, events,
				PipelineTranslationProgress,
				PipelineTranslationProgress,
				PipelineTranslationProgress,
				PipelineError,
				PipelineTranslationCommitted,
			)
			if events[2].Stage != TranslationProgressStageSynthesizing || events[3].Code != PipeErrTTSFailed {
				t.Fatalf("expected TTS_FAILED followed by acknowledgement, got %+v", events)
			}
		})
	}
}

func TestEndSession_EmptyTranscriptClearsStaleArtifactsWithoutAI(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	empty := canonicalMessage(id, " \n\t ", "stale translation")
	repo.messages[id] = []Message{empty}
	repo.summary[id] = &Summary{SessionID: id, SummaryEn: "stale"}
	repo.vocab[id] = []Vocabulary{{SessionID: id, Word: "stale"}}
	repo.cards[id] = []Flashcard{{SessionID: id, Front: "stale", Type: FlashcardTypeVocabulary}}
	ai := &fakeAI{}
	svc := NewService(repo, ai, nil)

	session, err := svc.EndSession(context.Background(), id)
	if err != nil {
		t.Fatalf("end empty session: %v", err)
	}
	if session.Status != StatusCompleted {
		t.Fatalf("empty session should complete, got %q", session.Status)
	}
	if ai.finalCalls.Load() != 0 || ai.imageCalls.Load() != 0 {
		t.Fatalf("empty transcript called AI: finalize=%d images=%d", ai.finalCalls.Load(), ai.imageCalls.Load())
	}
	if repo.summary[id] != nil || len(repo.vocab[id]) != 0 || len(repo.cards[id]) != 0 {
		t.Fatalf("stale artifacts remain: summary=%+v vocab=%+v cards=%+v", repo.summary[id], repo.vocab[id], repo.cards[id])
	}

	second, err := svc.EndSession(context.Background(), id)
	if err != nil || second.Status != StatusCompleted {
		t.Fatalf("empty finalization should be idempotent: status=%v err=%v", second.Status, err)
	}
}

func TestEndSession_UnreviewedTranscriptClearsArtifactsWithoutAI(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.messages[id] = []Message{{
		SessionID:      id,
		SourceText:     "มะยม มะขาม",
		TranslatedText: "It's not makha, khai makham.",
	}}
	repo.summary[id] = &Summary{SessionID: id, SummaryEn: "unsafe"}
	repo.vocab[id] = []Vocabulary{{SessionID: id, Word: "unsafe"}}
	repo.cards[id] = []Flashcard{{SessionID: id, Front: "unsafe", Type: FlashcardTypeVocabulary}}
	ai := &fakeAI{}
	svc := NewService(repo, ai, nil)

	session, err := svc.EndSession(context.Background(), id)
	if err != nil || session.Status != StatusCompleted {
		t.Fatalf("end legacy session: session=%+v err=%v", session, err)
	}
	if ai.finalCalls.Load() != 0 || ai.imageCalls.Load() != 0 {
		t.Fatalf("unreviewed transcript reached AI: finalize=%d images=%d", ai.finalCalls.Load(), ai.imageCalls.Load())
	}
	if repo.summary[id] != nil || len(repo.vocab[id]) != 0 || len(repo.cards[id]) != 0 {
		t.Fatalf("unreviewed artifacts remain: summary=%+v vocab=%+v cards=%+v", repo.summary[id], repo.vocab[id], repo.cards[id])
	}
}

func TestEndSession_FinalizesOnlyCanonicalMessages(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	canonical := canonicalMessage(id, "สวัสดี", "Hello")
	canonical.SequenceNo = 2
	repo.messages[id] = []Message{
		{SessionID: id, SequenceNo: 1, SourceText: "มะยม", TranslatedText: "makha"},
		canonical,
	}
	ai := &fakeAI{}
	ai.finalizeFn = func(_ context.Context, _ string, messages []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error) {
		if len(messages) != 1 || messages[0].SourceText != "สวัสดี" || messages[0].TranslatedText != "Hello" {
			t.Fatalf("finalize received unreviewed messages: %+v", messages)
		}

		return &ai_client.FinalizeResponse{}, nil
	}
	svc := NewService(repo, ai, nil)

	completed, err := svc.EndSession(context.Background(), id)
	if err != nil || completed.Status != StatusCompleted {
		t.Fatalf("end mixed session: session=%+v err=%v", completed, err)
	}
	if ai.finalCalls.Load() != 1 {
		t.Fatalf("canonical transcript should finalize once, calls=%d", ai.finalCalls.Load())
	}
}

func TestArtifactGetters_SuppressStaleDataWithoutCanonicalTranscript(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.messages[id] = []Message{{SessionID: id, SourceText: "บทเรียน", TranslatedText: "unreviewed lesson"}}
	repo.summary[id] = &Summary{SessionID: id, SummaryEn: "stale"}
	repo.vocab[id] = []Vocabulary{{SessionID: id, Word: "stale"}}
	repo.cards[id] = []Flashcard{{SessionID: id, Front: "stale"}}
	svc := NewService(repo, &fakeAI{}, nil)

	summary, err := svc.GetSummary(context.Background(), id)
	if err != nil || summary != nil {
		t.Fatalf("expected stale summary suppression, summary=%+v err=%v", summary, err)
	}
	vocabularies, err := svc.GetVocabularies(context.Background(), id)
	if err != nil || len(vocabularies) != 0 {
		t.Fatalf("expected stale vocabulary suppression, vocab=%+v err=%v", vocabularies, err)
	}
	flashcards, err := svc.GetFlashcards(context.Background(), id)
	if err != nil || len(flashcards) != 0 {
		t.Fatalf("expected stale flashcard suppression, cards=%+v err=%v", flashcards, err)
	}
}

func TestEndSession_FailedSessionCanRetry(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.messages[id] = []Message{canonicalMessage(id, "บทเรียน", "lesson")}
	ai := &fakeAI{}
	ai.finalizeFn = func(context.Context, string, []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error) {
		if ai.finalCalls.Load() == 1 {
			return nil, errors.New("temporary finalize failure")
		}

		return &ai_client.FinalizeResponse{Summary: ai_client.FinalizeSummary{SummaryEn: "lesson"}}, nil
	}
	svc := NewService(repo, ai, nil)

	if _, err := svc.EndSession(context.Background(), id); err == nil {
		t.Fatalf("first end should surface finalize failure")
	}
	failed, err := repo.GetSession(context.Background(), id)
	if err != nil || failed.Status != StatusFailed {
		t.Fatalf("failed finalization status=%v err=%v", failed.Status, err)
	}

	completed, err := svc.EndSession(context.Background(), id)
	if err != nil {
		t.Fatalf("retry failed session: %v", err)
	}
	if completed.Status != StatusCompleted || ai.finalCalls.Load() != 2 {
		t.Fatalf("retry did not complete exactly once: status=%s calls=%d", completed.Status, ai.finalCalls.Load())
	}
}

func TestEndSession_WaitsForAcceptedCommitAndBlocksNewCommits(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	ttsStarted := make(chan struct{})
	ttsRelease := make(chan struct{})
	finalizedMessages := make(chan []ai_client.FinalizeMessage, 1)
	ai := &fakeAI{}
	ai.ttsFn = func(ctx context.Context, _, _, _, _ string) (*ai_client.TTSResponse, error) {
		close(ttsStarted)
		select {
		case <-ttsRelease:
			return &ai_client.TTSResponse{AudioBase64: "YQ==", PlaybackRate: 1}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ai.finalizeFn = func(_ context.Context, _ string, messages []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error) {
		finalizedMessages <- messages

		return &ai_client.FinalizeResponse{}, nil
	}
	svc := NewService(repo, ai, nil)

	commitDone := make(chan error, 1)
	go func() {
		input := translationCommit(id, "commit-1", 1)
		input.SourceText = "บทเรียน"
		input.TranslatedText = "lesson"
		commitDone <- svc.CommitTranslationStream(context.Background(), input, nil)
	}()
	<-ttsStarted

	type endResult struct {
		session *Session
		err     error
	}
	endDone := make(chan endResult, 1)
	go func() {
		session, err := svc.EndSession(context.Background(), id)
		endDone <- endResult{session: session, err: err}
	}()

	waitForCommitGateBlocked(t, svc, id)
	waiting, err := repo.GetSession(context.Background(), id)
	if err != nil || waiting.Status != StatusActive {
		t.Fatalf("session must stay active while accepted commits drain: session=%+v err=%v", waiting, err)
	}

	err = svc.CommitTranslationStream(context.Background(), translationCommit(id, "commit-2", 2), nil)
	if !errors.Is(err, ErrSessionNotActive) || ai.ttsCalls.Load() != 1 {
		t.Fatalf("new commit was not blocked: err=%v ttsCalls=%d", err, ai.ttsCalls.Load())
	}

	select {
	case ended := <-endDone:
		t.Fatalf("end completed before in-flight commit drained: %+v", ended)
	default:
	}
	close(ttsRelease)

	if err := <-commitDone; err != nil {
		t.Fatalf("accepted commit failed: %v", err)
	}
	ended := <-endDone
	if ended.err != nil || ended.session.Status != StatusCompleted {
		t.Fatalf("end after drain: session=%+v err=%v", ended.session, ended.err)
	}
	messages := <-finalizedMessages
	if len(messages) != 1 || messages[0].SourceText != "บทเรียน" {
		t.Fatalf("finalization missed accepted commit: %+v", messages)
	}
}

func TestEndSession_WaitsForReviewBeforeProcessingAndFinalization(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	reviewStarted := make(chan struct{})
	reviewRelease := make(chan struct{})
	finalizedMessages := make(chan []ai_client.FinalizeMessage, 1)
	ai := &fakeAI{}
	ai.reviewFn = func(_ context.Context, request ai_client.TranslationReviewRequest) (*ai_client.TranslationReviewResponse, error) {
		close(reviewStarted)
		<-reviewRelease

		return &ai_client.TranslationReviewResponse{
			Status:         string(TranslationReviewStatusAccepted),
			TranslatedText: request.CandidateTranslatedText,
		}, nil
	}
	ai.finalizeFn = func(_ context.Context, _ string, messages []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error) {
		finalizedMessages <- messages

		return &ai_client.FinalizeResponse{}, nil
	}
	svc := NewService(repo, ai, nil)

	commitDone := make(chan error, 1)
	go func() {
		input := translationCommit(id, "commit-1", 1)
		input.SourceText = "บทเรียน"
		input.TranslatedText = "lesson"
		commitDone <- svc.CommitTranslationStream(context.Background(), input, nil)
	}()
	<-reviewStarted

	type endResult struct {
		session *Session
		err     error
	}
	endDone := make(chan endResult, 1)
	go func() {
		session, err := svc.EndSession(context.Background(), id)
		endDone <- endResult{session: session, err: err}
	}()
	waitForCommitGateBlocked(t, svc, id)
	waiting, err := repo.GetSession(context.Background(), id)
	if err != nil || waiting.Status != StatusActive {
		t.Fatalf("reviewing phrase lost active persistence window: session=%+v err=%v", waiting, err)
	}

	close(reviewRelease)
	if err := <-commitDone; err != nil {
		t.Fatalf("reviewing commit failed during end: %v", err)
	}
	ended := <-endDone
	if ended.err != nil || ended.session.Status != StatusCompleted {
		t.Fatalf("end after review: session=%+v err=%v", ended.session, ended.err)
	}
	messages := <-finalizedMessages
	if len(messages) != 1 || messages[0].SourceText != "บทเรียน" || messages[0].TranslatedText != "lesson" {
		t.Fatalf("finalization missed reviewed phrase: %+v", messages)
	}
}

func TestEndSession_ConcurrentCallsHaveOneFinalizationOwner(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.messages[id] = []Message{canonicalMessage(id, "บทเรียน", "lesson")}
	finalizeStarted := make(chan struct{})
	finalizeRelease := make(chan struct{})
	ai := &fakeAI{}
	ai.finalizeFn = func(ctx context.Context, _ string, _ []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error) {
		close(finalizeStarted)
		select {
		case <-finalizeRelease:
			return &ai_client.FinalizeResponse{}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	svc := NewService(repo, ai, nil)

	firstDone := make(chan error, 1)
	go func() {
		_, err := svc.EndSession(context.Background(), id)
		firstDone <- err
	}()
	<-finalizeStarted

	second, err := svc.EndSession(context.Background(), id)
	if err != nil || second.Status != StatusProcessing {
		t.Fatalf("non-owner should observe processing: session=%+v err=%v", second, err)
	}
	close(finalizeRelease)
	if err := <-firstDone; err != nil {
		t.Fatalf("owner finalization failed: %v", err)
	}
	if ai.finalCalls.Load() != 1 {
		t.Fatalf("expected one finalization owner, got %d calls", ai.finalCalls.Load())
	}
}

func TestEndSession_CanceledDrainIsReusedByRetry(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	ttsStarted := make(chan struct{})
	ttsRelease := make(chan struct{})
	finalizedMessages := make(chan []ai_client.FinalizeMessage, 1)
	ai := &fakeAI{}
	ai.ttsFn = func(ctx context.Context, _, _, _, _ string) (*ai_client.TTSResponse, error) {
		close(ttsStarted)
		select {
		case <-ttsRelease:
			return &ai_client.TTSResponse{AudioBase64: "YQ==", PlaybackRate: 1}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ai.finalizeFn = func(_ context.Context, _ string, messages []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error) {
		finalizedMessages <- messages

		return &ai_client.FinalizeResponse{}, nil
	}
	svc := NewService(repo, ai, nil)

	commitDone := make(chan error, 1)
	go func() {
		input := translationCommit(id, "commit-1", 1)
		input.SourceText = "บทเรียน"
		input.TranslatedText = "lesson"
		commitDone <- svc.CommitTranslationStream(context.Background(), input, nil)
	}()
	<-ttsStarted

	endCtx, cancelEnd := context.WithCancel(context.Background())
	firstEnd := make(chan error, 1)
	go func() {
		_, err := svc.EndSession(endCtx, id)
		firstEnd <- err
	}()
	waitForCommitGateBlocked(t, svc, id)
	cancelEnd()
	if err := <-firstEnd; !errors.Is(err, context.Canceled) {
		t.Fatalf("first end should be canceled, got %v", err)
	}
	waitForSessionStatus(t, repo, id, StatusActive)

	retryDone := make(chan error, 1)
	go func() {
		_, err := svc.EndSession(context.Background(), id)
		retryDone <- err
	}()
	waitForCommitGateBlocked(t, svc, id)
	select {
	case err := <-retryDone:
		t.Fatalf("retry completed before original commit drained: %v", err)
	default:
	}

	close(ttsRelease)
	if err := <-commitDone; err != nil {
		t.Fatalf("accepted commit failed: %v", err)
	}
	if err := <-retryDone; err != nil {
		t.Fatalf("retry after canceled drain failed: %v", err)
	}
	messages := <-finalizedMessages
	if len(messages) != 1 || messages[0].SourceText != "บทเรียน" {
		t.Fatalf("retry missed original commit: %+v", messages)
	}
}

func TestEndSession_CompletionWriteFailureBecomesRetryable(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.messages[id] = []Message{canonicalMessage(id, "บทเรียน", "lesson")}
	repo.failCompleteOnce = true
	ai := &fakeAI{}
	svc := NewService(repo, ai, nil)

	if _, err := svc.EndSession(context.Background(), id); err == nil {
		t.Fatalf("completion write failure must be returned")
	}
	waitForSessionStatus(t, repo, id, StatusFailed)

	completed, err := svc.EndSession(context.Background(), id)
	if err != nil || completed.Status != StatusCompleted {
		t.Fatalf("retry after completion write failure: session=%+v err=%v", completed, err)
	}
}

func TestCommitTranslationStream_UnknownSessionPrunesIdleGate(t *testing.T) {
	svc := NewService(newMemRepo(), &fakeAI{}, nil)

	err := svc.CommitTranslationStream(context.Background(), translationCommit("missing", "commit-1", 1), nil)
	if !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("unknown session: %v", err)
	}
	svc.commitGatesMu.Lock()
	gateCount := len(svc.commitGates)
	svc.commitGatesMu.Unlock()
	if gateCount != 0 {
		t.Fatalf("unknown session leaked %d commit gates", gateCount)
	}
}

func waitForSessionStatus(t *testing.T, repo *memRepo, id, status string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		session, err := repo.GetSession(context.Background(), id)
		if err != nil {
			t.Fatalf("get session status: %v", err)
		}
		if session.Status == status {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("session did not reach %q; current=%q", status, session.Status)
		}
		time.Sleep(time.Millisecond)
	}
}

func waitForCommitGateBlocked(t *testing.T, svc *Service, sessionID string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		svc.commitGatesMu.Lock()
		gate := svc.commitGates[sessionID]
		blocked := gate != nil && gate.blocked
		svc.commitGatesMu.Unlock()
		if blocked {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("session commit gate was not blocked")
		}
		time.Sleep(time.Millisecond)
	}
}

func waitForInFlightCommitCount(t *testing.T, svc *Service, sessionID string, count int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		svc.commitGatesMu.Lock()
		gate := svc.commitGates[sessionID]
		inFlight := 0
		if gate != nil {
			inFlight = gate.inFlight
		}
		svc.commitGatesMu.Unlock()
		if inFlight == count {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("want %d in-flight commits, got %d", count, inFlight)
		}
		time.Sleep(time.Millisecond)
	}
}
