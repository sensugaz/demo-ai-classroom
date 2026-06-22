package classroom

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/ai-classroom/backend/internal/ai_client"
	"github.com/ai-classroom/backend/pkg/uuid"
)

// finalizeTimeout bounds the (potentially long) LLM finalization call.
const finalizeTimeout = 120 * time.Second

// glossarySize caps how many recent term pairs are fed back to the translator
// for cross-utterance consistency (e.g. always render "มหาดเล็ก" the same way).
const glossarySize = 12

// SessionService is the orchestration contract for the classroom domain.
type SessionService interface {
	CreateSession(ctx context.Context, req CreateSessionRequest) (*Session, error)
	GetSession(ctx context.Context, sessionID string) (*Session, error)
	ListSessions(ctx context.Context) ([]Session, error)
	EndSession(ctx context.Context, sessionID string) (*Session, error)
	ListMessages(ctx context.Context, sessionID string) ([]Message, error)
	GetSummary(ctx context.Context, sessionID string) (*Summary, error)
	GetVocabularies(ctx context.Context, sessionID string) ([]Vocabulary, error)
	GetFlashcards(ctx context.Context, sessionID string) ([]Flashcard, error)

	// HandleAudioChunk runs the per-chunk STT -> translate -> TTS pipeline and returns
	// the ordered, transport-agnostic events to emit. TTS failure is non-fatal and surfaces
	// as a PipelineError event appended after the translation result.
	HandleAudioChunk(ctx context.Context, sessionID, audioBase64, mimeType string, sequenceNo int) ([]PipelineEvent, error)
}

// Service implements SessionService over a Repository and an AIClient.
type Service struct {
	repo Repository
	ai   ai_client.AIClient
	log  *slog.Logger

	// glossaryMu guards glossary. glossary keeps a short rolling window of recent
	// confirmed term pairs per session, fed back to the translator so the same
	// Thai term renders consistently across utterances. In-memory and best-effort
	// (lost on restart); a missing window only forgoes the consistency hint.
	glossaryMu sync.Mutex
	glossary   map[string][]ai_client.TermPair
}

var _ SessionService = (*Service)(nil)

// NewService constructs a Service.
func NewService(repo Repository, ai ai_client.AIClient, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{
		repo:     repo,
		ai:       ai,
		log:      log,
		glossary: make(map[string][]ai_client.TermPair),
	}
}

// glossaryFor returns a snapshot copy of the session's recent term pairs.
func (s *Service) glossaryFor(sessionID string) []ai_client.TermPair {
	s.glossaryMu.Lock()
	defer s.glossaryMu.Unlock()
	cur := s.glossary[sessionID]
	if len(cur) == 0 {
		return nil
	}
	out := make([]ai_client.TermPair, len(cur))
	copy(out, cur)
	return out
}

// rememberTerm appends a confirmed pair to the session window, capped at
// glossarySize (oldest dropped).
func (s *Service) rememberTerm(sessionID, th, en string) {
	if th == "" || en == "" {
		return
	}
	s.glossaryMu.Lock()
	defer s.glossaryMu.Unlock()
	cur := append(s.glossary[sessionID], ai_client.TermPair{Th: th, En: en})
	if len(cur) > glossarySize {
		cur = cur[len(cur)-glossarySize:]
	}
	s.glossary[sessionID] = cur
}

// CreateSession persists a new active session with the fixed language contract.
func (s *Service) CreateSession(ctx context.Context, req CreateSessionRequest) (*Session, error) {
	now := time.Now().UTC()
	session := &Session{
		SessionID:      uuid.New(),
		ClassroomName:  req.ClassroomName,
		SpeakerName:    req.SpeakerName,
		ContextNote:    req.ContextNote,
		SourceLanguage: SourceLanguage,
		TargetLanguage: TargetLanguage,
		Status:         StatusActive,
		StartedAt:      now,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := s.repo.CreateSession(ctx, session); err != nil {
		return nil, err
	}
	return session, nil
}

// GetSession returns a session by id.
func (s *Service) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	return s.repo.GetSession(ctx, sessionID)
}

// ListSessions returns all sessions.
func (s *Service) ListSessions(ctx context.Context) ([]Session, error) {
	return s.repo.ListSessions(ctx)
}

// ListMessages returns the ordered messages of a session.
func (s *Service) ListMessages(ctx context.Context, sessionID string) ([]Message, error) {
	if _, err := s.repo.GetSession(ctx, sessionID); err != nil {
		return nil, err
	}
	return s.repo.ListMessages(ctx, sessionID)
}

// GetSummary returns the summary of a session.
func (s *Service) GetSummary(ctx context.Context, sessionID string) (*Summary, error) {
	if _, err := s.repo.GetSession(ctx, sessionID); err != nil {
		return nil, err
	}
	return s.repo.GetSummary(ctx, sessionID)
}

// GetVocabularies returns the vocabularies of a session.
func (s *Service) GetVocabularies(ctx context.Context, sessionID string) ([]Vocabulary, error) {
	if _, err := s.repo.GetSession(ctx, sessionID); err != nil {
		return nil, err
	}
	return s.repo.GetVocabularies(ctx, sessionID)
}

// GetFlashcards returns the flashcards of a session.
func (s *Service) GetFlashcards(ctx context.Context, sessionID string) ([]Flashcard, error) {
	if _, err := s.repo.GetSession(ctx, sessionID); err != nil {
		return nil, err
	}
	return s.repo.GetFlashcards(ctx, sessionID)
}

// EndSession transitions active -> processing, runs finalization, persists the derived
// artifacts, then transitions to completed. It is idempotent for already-completed sessions.
func (s *Service) EndSession(ctx context.Context, sessionID string) (*Session, error) {
	session, err := s.repo.GetSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Idempotency: a completed session simply returns its current state.
	if session.Status == StatusCompleted {
		return session, nil
	}

	processing, err := s.repo.UpdateSessionStatus(ctx, sessionID, StatusProcessing, nil)
	if err != nil {
		return nil, err
	}

	if err := s.finalize(ctx, sessionID); err != nil {
		// Mark the session failed so its state reflects reality, then surface the error.
		if _, ferr := s.repo.UpdateSessionStatus(ctx, sessionID, StatusFailed, nil); ferr != nil {
			s.log.Error("mark session failed", "sessionId", sessionID, "error", ferr)
		}
		return processing, err
	}

	endedAt := time.Now().UTC()
	completed, err := s.repo.UpdateSessionStatus(ctx, sessionID, StatusCompleted, &endedAt)
	if err != nil {
		return nil, err
	}
	return completed, nil
}

// finalize gathers messages, calls the ai-service, and persists summary/vocab/flashcards.
func (s *Service) finalize(ctx context.Context, sessionID string) error {
	messages, err := s.repo.ListMessages(ctx, sessionID)
	if err != nil {
		return err
	}

	payload := make([]ai_client.FinalizeMessage, 0, len(messages))
	for _, m := range messages {
		payload = append(payload, ai_client.FinalizeMessage{
			SourceText:     m.SourceText,
			TranslatedText: m.TranslatedText,
		})
	}

	fctx, cancel := context.WithTimeout(ctx, finalizeTimeout)
	defer cancel()

	result, err := s.ai.Finalize(fctx, sessionID, payload)
	if err != nil {
		return fmt.Errorf("finalize session %s: %w", sessionID, err)
	}

	now := time.Now().UTC()

	summary := &Summary{
		SessionID:   sessionID,
		SummaryTh:   result.Summary.SummaryTh,
		SummaryEn:   result.Summary.SummaryEn,
		KeyPointsTh: nonNilStrings(result.Summary.KeyPointsTh),
		KeyPointsEn: nonNilStrings(result.Summary.KeyPointsEn),
		CreatedAt:   now,
	}
	if err := s.repo.UpsertSummary(ctx, summary); err != nil {
		return err
	}

	vocab := make([]Vocabulary, 0, len(result.Vocabularies))
	for _, v := range result.Vocabularies {
		vocab = append(vocab, Vocabulary{
			SessionID:         sessionID,
			Word:              v.Word,
			Pronunciation:     v.Pronunciation,
			PartOfSpeech:      v.PartOfSpeech,
			MeaningTh:         v.MeaningTh,
			MeaningEn:         v.MeaningEn,
			ExampleSentenceEn: v.ExampleSentenceEn,
			ExampleSentenceTh: v.ExampleSentenceTh,
			DifficultyLevel:   v.DifficultyLevel,
			CreatedAt:         now,
		})
	}
	if err := s.repo.ReplaceVocabularies(ctx, sessionID, vocab); err != nil {
		return err
	}

	cards := make([]Flashcard, 0, len(result.Flashcards))
	for _, f := range result.Flashcards {
		cards = append(cards, Flashcard{
			SessionID:       sessionID,
			Front:           f.Front,
			Back:            f.Back,
			Type:            f.Type,
			Word:            f.Word,
			HintTh:          f.HintTh,
			ExampleSentence: f.ExampleSentence,
			CreatedAt:       now,
		})
	}
	if err := s.repo.ReplaceFlashcards(ctx, sessionID, cards); err != nil {
		return err
	}

	return nil
}

// HandleAudioChunk implements the realtime per-chunk pipeline. It returns transport-agnostic
// PipelineEvents; the caller (transport layer) is responsible for serialization and delivery.
//
// TODO(future): emit interim PipelineTranscriptPartial events from a streaming STT backend.
// The current contract uses self-contained webm segments, so the backend emits final
// transcripts per chunk; this is a deliberate scope choice, not a stub.
func (s *Service) HandleAudioChunk(ctx context.Context, sessionID, audioBase64, mimeType string, sequenceNo int) ([]PipelineEvent, error) {
	session, err := s.repo.GetSession(ctx, sessionID)
	if err != nil {
		if errors.Is(err, ErrSessionNotFound) {
			return pipelineErrors(sessionID, PipeErrSessionUnknown, "session not found"), nil
		}
		return nil, err
	}
	if session.Status != StatusActive {
		return pipelineErrors(sessionID, PipeErrSessionUnknown, "session is not active"), nil
	}

	if _, derr := base64.StdEncoding.DecodeString(audioBase64); derr != nil {
		return pipelineErrors(sessionID, PipeErrInvalidPayload, "audio is not valid base64"), nil
	}

	// 1) STT. Stage latency is measured at the backend, so each number includes
	// the round-trip to ai-service plus the upstream provider call (Google STT,
	// the LLM, Cartesia). That is exactly what we want to answer "which part is
	// slow" — the slowest stage in the log is the bottleneck.
	sttStart := time.Now()
	stt, err := s.ai.STT(ctx, ai_client.STTRequest{
		SessionID:   sessionID,
		AudioBase64: audioBase64,
		MimeType:    mimeType,
		SequenceNo:  sequenceNo,
	})
	sttMs := time.Since(sttStart).Milliseconds()
	if err != nil {
		s.log.Error("stt failed", "sessionId", sessionID, "seq", sequenceNo, "sttMs", sttMs, "error", err)
		return pipelineErrors(sessionID, PipeErrSTTFailed, "speech recognition failed"), nil
	}
	// Empty transcript (e.g. silence) is not an error; nothing to emit.
	if stt.Text == "" {
		s.log.Info("chunk latency (no speech)", "sessionId", sessionID, "seq", sequenceNo, "sttMs", sttMs)
		return nil, nil
	}

	events := make([]PipelineEvent, 0, 3)
	events = append(events, transcriptFinalEvent(sessionID, stt.Text))

	// Persist the source-side message immediately; translation is patched onto the same row.
	now := time.Now().UTC()
	msg := &Message{
		SessionID:      sessionID,
		SourceText:     stt.Text,
		SourceLanguage: SourceLanguage,
		TargetLanguage: TargetLanguage,
		Confidence:     stt.Confidence,
		IsFinal:        true,
		StartedAt:      &now,
		CreatedAt:      now,
	}

	// 2) Translate. Feed the lesson context note + a rolling glossary of recent
	// confirmed pairs so proper nouns/domain terms stay accurate and consistent.
	trStart := time.Now()
	tr, err := s.ai.Translate(ctx, sessionID, stt.Text, session.ContextNote, s.glossaryFor(sessionID))
	translateMs := time.Since(trStart).Milliseconds()
	if err != nil {
		s.log.Error("translate failed", "sessionId", sessionID, "seq", sequenceNo, "sttMs", sttMs, "translateMs", translateMs, "error", err)
		// Still persist the transcribed source so finalization sees it.
		if _, perr := s.repo.InsertMessage(ctx, msg); perr != nil {
			s.log.Error("persist source-only message", "sessionId", sessionID, "error", perr)
		}
		events = append(events, pipelineError(sessionID, PipeErrTranslateFailed, "translation failed"))
		return events, nil
	}

	msg.TranslatedText = tr.TranslatedText
	endedAt := time.Now().UTC()
	msg.EndedAt = &endedAt

	// Record this pair so later utterances translate the same term consistently.
	s.rememberTerm(sessionID, stt.Text, tr.TranslatedText)

	events = append(events, translationEvent(sessionID, stt.Text, tr.TranslatedText, sttMs, translateMs))

	// 3) TTS (non-fatal). Persist audioUrl when available before storing the message.
	ttsStart := time.Now()
	tts, ttsErr := s.ai.TTS(ctx, sessionID, tr.TranslatedText)
	ttsMs := time.Since(ttsStart).Milliseconds()
	if ttsErr == nil && tts != nil {
		msg.AudioURL = tts.AudioURL
	}

	persistStart := time.Now()
	if _, perr := s.repo.InsertMessage(ctx, msg); perr != nil {
		s.log.Error("persist message", "sessionId", sessionID, "error", perr)
		return nil, perr
	}
	persistMs := time.Since(persistStart).Milliseconds()

	if ttsErr != nil {
		s.log.Warn("tts failed (non-fatal)", "sessionId", sessionID, "seq", sequenceNo, "ttsMs", ttsMs, "error", ttsErr)
		s.log.Info("chunk latency",
			"sessionId", sessionID, "seq", sequenceNo,
			"sttMs", sttMs, "translateMs", translateMs, "ttsMs", ttsMs, "persistMs", persistMs,
			"totalMs", sttMs+translateMs+ttsMs+persistMs, "chars", len(stt.Text))
		events = append(events, pipelineError(sessionID, PipeErrTTSFailed, "text-to-speech failed"))
		return events, nil
	}

	// Per-stage breakdown: the largest of sttMs / translateMs / ttsMs is the
	// bottleneck for this chunk. Tail through `docker compose logs -f backend`.
	s.log.Info("chunk latency",
		"sessionId", sessionID, "seq", sequenceNo,
		"sttMs", sttMs, "translateMs", translateMs, "ttsMs", ttsMs, "persistMs", persistMs,
		"totalMs", sttMs+translateMs+ttsMs+persistMs, "chars", len(stt.Text))

	events = append(events, ttsAudioEvent(sessionID, tr.TranslatedText, tts.AudioURL, tts.AudioBase64))
	return events, nil
}

func nonNilStrings(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}
