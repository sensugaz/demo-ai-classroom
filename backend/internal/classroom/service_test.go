package classroom

import (
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ai-classroom/backend/internal/ai_client"
)

// --- in-memory repository ---

type memRepo struct {
	sessions map[string]*Session
	messages map[string][]Message
	summary  map[string]*Summary
	vocab    map[string][]Vocabulary
	cards    map[string][]Flashcard

	afterImageReplace     chan struct{}
	afterImageReplaceOnce sync.Once
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
	m.sessions[s.SessionID] = s
	return nil
}

func (m *memRepo) GetSession(_ context.Context, id string) (*Session, error) {
	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrSessionNotFound
	}
	return s, nil
}

func (m *memRepo) ListSessions(_ context.Context) ([]Session, error) {
	out := make([]Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, *s)
	}
	return out, nil
}

func (m *memRepo) TryStartSessionProcessing(_ context.Context, id string) (*Session, bool, error) {
	s, ok := m.sessions[id]
	if !ok {
		return nil, false, ErrSessionNotFound
	}
	if s.Status != StatusActive {
		return s, false, nil
	}
	s.Status = StatusProcessing
	return s, true, nil
}

func (m *memRepo) UpdateSessionStatus(_ context.Context, id, status string, endedAt *time.Time) (*Session, error) {
	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrSessionNotFound
	}
	s.Status = status
	if endedAt != nil {
		s.EndedAt = endedAt
	}
	return s, nil
}

func (m *memRepo) InsertMessage(_ context.Context, msg *Message) (*Message, error) {
	msg.SequenceNo = len(m.messages[msg.SessionID]) + 1
	m.messages[msg.SessionID] = append(m.messages[msg.SessionID], *msg)
	return msg, nil
}

func (m *memRepo) ListMessages(_ context.Context, id string) ([]Message, error) {
	return m.messages[id], nil
}

func (m *memRepo) DeleteMessages(_ context.Context, id string) error {
	delete(m.messages, id)
	return nil
}

func (m *memRepo) UpsertSummary(_ context.Context, s *Summary) error {
	m.summary[s.SessionID] = s
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

// --- configurable fake AI client ---

type fakeAI struct {
	sttText     string
	translation string
	ttsErr      error
	beforeTTS   func()
	finalize    *ai_client.FinalizeResponse
	images      []ai_client.FinalizeFlashcard
}

func (f *fakeAI) STT(_ context.Context, _ ai_client.STTRequest) (*ai_client.STTResponse, error) {
	return &ai_client.STTResponse{Text: f.sttText, Language: SourceLanguage, IsFinal: true, Confidence: 0.9}, nil
}

func (f *fakeAI) Translate(_ context.Context, _, _, _ string, _ []ai_client.TermPair) (*ai_client.TranslateResponse, error) {
	return &ai_client.TranslateResponse{TranslatedText: f.translation, SourceLanguage: SourceLanguage, TargetLanguage: TargetLanguage}, nil
}

func (f *fakeAI) TTS(_ context.Context, _, _ string) (*ai_client.TTSResponse, error) {
	if f.beforeTTS != nil {
		f.beforeTTS()
	}
	if f.ttsErr != nil {
		return nil, f.ttsErr
	}
	return &ai_client.TTSResponse{AudioBase64: "YQ==", Language: TargetLanguage, DurationMs: 100}, nil
}

func (f *fakeAI) Finalize(_ context.Context, _ string, _ []ai_client.FinalizeMessage) (*ai_client.FinalizeResponse, error) {
	if f.finalize == nil {
		return &ai_client.FinalizeResponse{}, nil
	}
	return f.finalize, nil
}

func (f *fakeAI) GenerateFlashcardImages(_ context.Context, _ string, flashcards []ai_client.FinalizeFlashcard, _ []ai_client.FinalizeVocabulary) ([]ai_client.FinalizeFlashcard, error) {
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
