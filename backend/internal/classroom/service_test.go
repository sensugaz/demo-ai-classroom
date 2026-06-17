package classroom

import (
	"context"
	"encoding/base64"
	"errors"
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
	finalize    *ai_client.FinalizeResponse
}

func (f *fakeAI) STT(_ context.Context, _ ai_client.STTRequest) (*ai_client.STTResponse, error) {
	return &ai_client.STTResponse{Text: f.sttText, Language: SourceLanguage, IsFinal: true, Confidence: 0.9}, nil
}

func (f *fakeAI) Translate(_ context.Context, _, _ string) (*ai_client.TranslateResponse, error) {
	return &ai_client.TranslateResponse{TranslatedText: f.translation, SourceLanguage: SourceLanguage, TargetLanguage: TargetLanguage}, nil
}

func (f *fakeAI) TTS(_ context.Context, _, _ string) (*ai_client.TTSResponse, error) {
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
	id := activeSession(repo)
	repo.messages[id] = []Message{{SessionID: id, SourceText: "a", TranslatedText: "b"}}

	fin := &ai_client.FinalizeResponse{
		Summary:      ai_client.FinalizeSummary{SummaryEn: "sum"},
		Vocabularies: []ai_client.FinalizeVocabulary{{Word: "hello"}},
		Flashcards:   []ai_client.FinalizeFlashcard{{Front: "f", Back: "b", Type: FlashcardTypeVocabulary}},
	}
	svc := NewService(repo, &fakeAI{finalize: fin}, nil)

	out, err := svc.EndSession(context.Background(), id)
	if err != nil {
		t.Fatalf("end session: %v", err)
	}
	if out.Status != StatusCompleted {
		t.Fatalf("want completed, got %s", out.Status)
	}
	if repo.summary[id] == nil || len(repo.vocab[id]) != 1 || len(repo.cards[id]) != 1 {
		t.Fatalf("derived artifacts not persisted")
	}

	// Idempotency: a second end on a completed session is a no-op success.
	out2, err := svc.EndSession(context.Background(), id)
	if err != nil || out2.Status != StatusCompleted {
		t.Fatalf("idempotent end failed: status=%v err=%v", out2.Status, err)
	}
}
