package classroom

import (
	"context"
	"encoding/base64"
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

func (m *memRepo) InsertMessage(_ context.Context, msg *Message) (*Message, error) {
	if msg.SequenceNo <= 0 {
		msg.SequenceNo = len(m.messages[msg.SessionID]) + 1
	}
	m.messages[msg.SessionID] = append(m.messages[msg.SessionID], *msg)
	return msg, nil
}

func (m *memRepo) ListMessages(_ context.Context, id string) ([]Message, error) {
	out := append([]Message(nil), m.messages[id]...)
	sort.Slice(out, func(i, j int) bool { return out[i].SequenceNo < out[j].SequenceNo })
	return out, nil
}

func (m *memRepo) DeleteMessages(_ context.Context, id string) error {
	delete(m.messages, id)
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
	sttText     string
	translation string
	ttsErr      error
	beforeTTS   func()
	finalize    *ai_client.FinalizeResponse
	images      []ai_client.FinalizeFlashcard
	lastVoice   string
	lastSpeed   string
	sttFn       func(context.Context, ai_client.STTRequest) (*ai_client.STTResponse, error)
	ttsFn       func(context.Context, string, string, string, string) (*ai_client.TTSResponse, error)
	finalizeFn  func(context.Context, string, []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error)
	sttCalls    atomic.Int32
	finalCalls  atomic.Int32
	imageCalls  atomic.Int32
}

func (f *fakeAI) STT(ctx context.Context, req ai_client.STTRequest) (*ai_client.STTResponse, error) {
	f.sttCalls.Add(1)
	if f.sttFn != nil {
		return f.sttFn(ctx, req)
	}

	return &ai_client.STTResponse{Text: f.sttText, Language: SourceLanguage, IsFinal: true, Confidence: 0.9}, nil
}

func (f *fakeAI) Translate(_ context.Context, _, _, _ string, _ []ai_client.TermPair) (*ai_client.TranslateResponse, error) {
	return &ai_client.TranslateResponse{TranslatedText: f.translation, SourceLanguage: SourceLanguage, TargetLanguage: TargetLanguage}, nil
}

func (f *fakeAI) TTS(ctx context.Context, sessionID, text, voiceProfile, speechSpeed string) (*ai_client.TTSResponse, error) {
	f.lastVoice = voiceProfile
	f.lastSpeed = speechSpeed
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

func validAudio() string { return base64.StdEncoding.EncodeToString([]byte("webm-bytes")) }

func TestHandleAudioChunk_HappyPath(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	svc := NewService(repo, &fakeAI{sttText: "สวัสดี", translation: "hello"}, nil)

	events, err := svc.HandleAudioChunk(context.Background(), id, validAudio(), "audio/webm", 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("want 3 events (transcript, translation, tts), got %d: %+v", len(events), events)
	}
	if events[0].Type != PipelineTranscriptFinal || events[1].Type != PipelineTranslation || events[2].Type != PipelineTTSAudio {
		t.Fatalf("unexpected event order: %v %v %v", events[0].Type, events[1].Type, events[2].Type)
	}
	msgs := repo.messages[id]
	if len(msgs) != 1 || msgs[0].SourceText != "สวัสดี" || msgs[0].TranslatedText != "hello" {
		t.Fatalf("message not persisted correctly: %+v", msgs)
	}
}

func TestHandleAudioChunk_TTSFailureIsNonFatal(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	svc := NewService(repo, &fakeAI{sttText: "x", translation: "y", ttsErr: errors.New("boom")}, nil)

	events, err := svc.HandleAudioChunk(context.Background(), id, validAudio(), "audio/webm", 1)
	if err != nil {
		t.Fatalf("tts failure must not be fatal, got err: %v", err)
	}
	if len(events) != 3 || events[2].Type != PipelineError || events[2].Code != PipeErrTTSFailed {
		t.Fatalf("expected trailing TTS error event, got: %+v", events)
	}
	// Translation must still be persisted.
	if got := repo.messages[id]; len(got) != 1 || got[0].TranslatedText != "y" {
		t.Fatalf("translation should persist despite TTS failure: %+v", got)
	}
}

func TestHandleAudioChunkStream_EmitsTranslationBeforeTTS(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	emitted := make([]PipelineEvent, 0, 3)
	ai := &fakeAI{
		sttText:     "สวัสดี",
		translation: "hello",
		beforeTTS: func() {
			if len(emitted) != 2 {
				t.Fatalf("translation should be emitted before TTS starts, got %d events", len(emitted))
			}
			if emitted[0].Type != PipelineTranscriptFinal || emitted[1].Type != PipelineTranslation {
				t.Fatalf("unexpected pre-TTS events: %+v", emitted)
			}
		},
	}
	svc := NewService(repo, ai, nil)

	err := svc.HandleAudioChunkStream(context.Background(), AudioChunkInput{
		SessionID:   id,
		AudioBase64: validAudio(),
		MimeType:    "audio/webm",
		SequenceNo:  1,
	}, func(event PipelineEvent) {
		emitted = append(emitted, event)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(emitted) != 3 || emitted[2].Type != PipelineTTSAudio {
		t.Fatalf("expected TTS audio after translation, got: %+v", emitted)
	}
}

func TestHandleAudioChunkStream_PassesVoiceAndSpeedToTTS(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	ai := &fakeAI{sttText: "สวัสดี", translation: "hello"}
	svc := NewService(repo, ai, nil)

	var emitted []PipelineEvent
	err := svc.HandleAudioChunkStream(context.Background(), AudioChunkInput{
		SessionID:    id,
		AudioBase64:  validAudio(),
		MimeType:     "audio/webm",
		SequenceNo:   1,
		VoiceProfile: TTSVoiceProfileChildGirl,
		SpeechSpeed:  TTSSpeechSpeedSlow,
	}, func(event PipelineEvent) {
		emitted = append(emitted, event)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ai.lastVoice != TTSVoiceProfileChildGirl || ai.lastSpeed != TTSSpeechSpeedSlow {
		t.Fatalf("voice/speed not passed to TTS: voice=%q speed=%q", ai.lastVoice, ai.lastSpeed)
	}
	last := emitted[len(emitted)-1]
	if last.Type != PipelineTTSAudio || last.VoiceProfile != TTSVoiceProfileChildGirl || last.SpeechSpeed != TTSSpeechSpeedSlow {
		t.Fatalf("tts event missing voice/speed: %+v", last)
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

func TestHandleAudioChunk_UnknownSession(t *testing.T) {
	repo := newMemRepo()
	svc := NewService(repo, &fakeAI{}, nil)
	events, err := svc.HandleAudioChunk(context.Background(), "missing", validAudio(), "audio/webm", 1)
	if err != nil {
		t.Fatalf("unknown session should surface as event, not error: %v", err)
	}
	if len(events) != 1 || events[0].Type != PipelineError || events[0].Code != PipeErrSessionUnknown {
		t.Fatalf("expected SESSION_UNKNOWN event, got: %+v", events)
	}
}

func TestHandleAudioChunk_InvalidBase64(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	svc := NewService(repo, &fakeAI{}, nil)
	events, _ := svc.HandleAudioChunk(context.Background(), id, "!!!not-base64!!!", "audio/webm", 1)
	if len(events) != 1 || events[0].Code != PipeErrInvalidPayload {
		t.Fatalf("expected INVALID_PAYLOAD event, got: %+v", events)
	}
}

func TestEndSession_FinalizesAndIsIdempotent(t *testing.T) {
	repo := newMemRepo()
	repo.afterImageReplace = make(chan struct{})
	id := activeSession(repo)
	repo.messages[id] = []Message{{SessionID: id, SourceText: "a", TranslatedText: "b"}}

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

func TestHandleAudioChunk_TTSMissingAudioEmitsFailure(t *testing.T) {
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
				sttText:     "สวัสดี",
				translation: "hello",
				ttsFn: func(context.Context, string, string, string, string) (*ai_client.TTSResponse, error) {
					return test.response, nil
				},
			}
			svc := NewService(repo, ai, nil)

			events, err := svc.HandleAudioChunk(context.Background(), id, validAudio(), "audio/webm", 1)
			if err != nil {
				t.Fatalf("missing TTS audio must be non-fatal: %v", err)
			}
			if len(events) != 3 || events[2].Type != PipelineError || events[2].Code != PipeErrTTSFailed {
				t.Fatalf("expected trailing TTS_FAILED without tts:audio, got %+v", events)
			}
		})
	}
}

func TestEndSession_EmptyTranscriptClearsStaleArtifactsWithoutAI(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.messages[id] = []Message{{SessionID: id, SourceText: " \n\t ", TranslatedText: "stale translation"}}
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

func TestArtifactGetters_SuppressStaleDataWithoutValidTranscript(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.messages[id] = []Message{{SessionID: id, SourceText: "   ", TranslatedText: "old"}}
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
	repo.messages[id] = []Message{{SessionID: id, SourceText: "บทเรียน", TranslatedText: "lesson"}}
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

func TestEndSession_WaitsForAcceptedAudioAndBlocksNewChunks(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	sttStarted := make(chan struct{})
	sttRelease := make(chan struct{})
	finalizedMessages := make(chan []ai_client.FinalizeMessage, 1)
	ai := &fakeAI{translation: "lesson"}
	ai.sttFn = func(ctx context.Context, _ ai_client.STTRequest) (*ai_client.STTResponse, error) {
		close(sttStarted)
		select {
		case <-sttRelease:
			return &ai_client.STTResponse{Text: "บทเรียน", Language: SourceLanguage, IsFinal: true}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ai.finalizeFn = func(_ context.Context, _ string, messages []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error) {
		finalizedMessages <- messages

		return &ai_client.FinalizeResponse{}, nil
	}
	svc := NewService(repo, ai, nil)

	audioDone := make(chan error, 1)
	go func() {
		_, err := svc.HandleAudioChunk(context.Background(), id, validAudio(), "audio/webm", 1)
		audioDone <- err
	}()
	<-sttStarted

	type endResult struct {
		session *Session
		err     error
	}
	endDone := make(chan endResult, 1)
	go func() {
		session, err := svc.EndSession(context.Background(), id)
		endDone <- endResult{session: session, err: err}
	}()

	deadline := time.Now().Add(time.Second)
	for {
		session, err := repo.GetSession(context.Background(), id)
		if err != nil {
			t.Fatalf("get processing session: %v", err)
		}
		if session.Status == StatusProcessing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("end session did not acquire processing ownership")
		}
		time.Sleep(time.Millisecond)
	}

	blockedEvents, err := svc.HandleAudioChunk(context.Background(), id, validAudio(), "audio/webm", 2)
	if err != nil {
		t.Fatalf("blocked audio returned error: %v", err)
	}
	if len(blockedEvents) != 1 || blockedEvents[0].Code != PipeErrSessionUnknown || ai.sttCalls.Load() != 1 {
		t.Fatalf("new audio was not blocked: events=%+v sttCalls=%d", blockedEvents, ai.sttCalls.Load())
	}

	select {
	case ended := <-endDone:
		t.Fatalf("end completed before in-flight audio drained: %+v", ended)
	default:
	}
	close(sttRelease)

	if err := <-audioDone; err != nil {
		t.Fatalf("accepted audio failed: %v", err)
	}
	ended := <-endDone
	if ended.err != nil || ended.session.Status != StatusCompleted {
		t.Fatalf("end after drain: session=%+v err=%v", ended.session, ended.err)
	}
	messages := <-finalizedMessages
	if len(messages) != 1 || messages[0].SourceText != "บทเรียน" {
		t.Fatalf("finalization missed accepted audio: %+v", messages)
	}
}

func TestEndSession_ConcurrentCallsHaveOneFinalizationOwner(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.messages[id] = []Message{{SessionID: id, SourceText: "บทเรียน"}}
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
	sttStarted := make(chan struct{})
	sttRelease := make(chan struct{})
	finalizedMessages := make(chan []ai_client.FinalizeMessage, 1)
	ai := &fakeAI{translation: "lesson"}
	ai.sttFn = func(ctx context.Context, _ ai_client.STTRequest) (*ai_client.STTResponse, error) {
		close(sttStarted)
		select {
		case <-sttRelease:
			return &ai_client.STTResponse{Text: "บทเรียน", Language: SourceLanguage, IsFinal: true}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ai.finalizeFn = func(_ context.Context, _ string, messages []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error) {
		finalizedMessages <- messages

		return &ai_client.FinalizeResponse{}, nil
	}
	svc := NewService(repo, ai, nil)

	audioDone := make(chan error, 1)
	go func() {
		_, err := svc.HandleAudioChunk(context.Background(), id, validAudio(), "audio/webm", 1)
		audioDone <- err
	}()
	<-sttStarted

	endCtx, cancelEnd := context.WithCancel(context.Background())
	firstEnd := make(chan error, 1)
	go func() {
		_, err := svc.EndSession(endCtx, id)
		firstEnd <- err
	}()
	waitForSessionStatus(t, repo, id, StatusProcessing)
	cancelEnd()
	if err := <-firstEnd; !errors.Is(err, context.Canceled) {
		t.Fatalf("first end should be canceled, got %v", err)
	}
	waitForSessionStatus(t, repo, id, StatusFailed)

	retryDone := make(chan error, 1)
	go func() {
		_, err := svc.EndSession(context.Background(), id)
		retryDone <- err
	}()
	waitForSessionStatus(t, repo, id, StatusProcessing)
	select {
	case err := <-retryDone:
		t.Fatalf("retry completed before original audio drained: %v", err)
	default:
	}

	close(sttRelease)
	if err := <-audioDone; err != nil {
		t.Fatalf("accepted audio failed: %v", err)
	}
	if err := <-retryDone; err != nil {
		t.Fatalf("retry after canceled drain failed: %v", err)
	}
	messages := <-finalizedMessages
	if len(messages) != 1 || messages[0].SourceText != "บทเรียน" {
		t.Fatalf("retry missed original audio: %+v", messages)
	}
}

func TestEndSession_CompletionWriteFailureBecomesRetryable(t *testing.T) {
	repo := newMemRepo()
	id := activeSession(repo)
	repo.messages[id] = []Message{{SessionID: id, SourceText: "บทเรียน"}}
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

func TestHandleAudioChunk_UnknownSessionPrunesIdleGate(t *testing.T) {
	svc := NewService(newMemRepo(), &fakeAI{}, nil)

	if _, err := svc.HandleAudioChunk(context.Background(), "missing", validAudio(), "audio/webm", 1); err != nil {
		t.Fatalf("unknown session: %v", err)
	}
	svc.audioGatesMu.Lock()
	gateCount := len(svc.audioGates)
	svc.audioGatesMu.Unlock()
	if gateCount != 0 {
		t.Fatalf("unknown session leaked %d audio gates", gateCount)
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
