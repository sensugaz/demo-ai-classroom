package classroom

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/ai-classroom/backend/internal/ai_client"
	"github.com/ai-classroom/backend/pkg/uuid"
)

// finalizeTimeout bounds the (potentially long) LLM finalization call.
const finalizeTimeout = 120 * time.Second

// flashcardImageTimeout bounds the best-effort background image generation job.
const flashcardImageTimeout = 180 * time.Second

// flashcardImageConcurrency keeps OpenAI image generation from stampeding.
const flashcardImageConcurrency = 2

// maxCommittedTextBytes bounds each immutable source/translation slice.
const maxCommittedTextBytes = 24_000

const maxCommitIdentifierBytes = 256

// ErrInvalidTranslationCommit is returned for malformed immutable text pairs.
var ErrInvalidTranslationCommit = errors.New("invalid translation commit")

// SessionService is the orchestration contract for the classroom domain.
type SessionService interface {
	CreateSession(ctx context.Context, req CreateSessionRequest) (*Session, error)
	GetSession(ctx context.Context, sessionID string) (*Session, error)
	ListSessions(ctx context.Context) ([]Session, error)
	EndSession(ctx context.Context, sessionID string) (*Session, error)
	ResetSession(ctx context.Context, sessionID string) error
	ListMessages(ctx context.Context, sessionID string) ([]Message, error)
	GetSummary(ctx context.Context, sessionID string) (*Summary, error)
	UpdateSummary(ctx context.Context, sessionID string, req UpdateSummaryRequest) (*Summary, error)
	GetVocabularies(ctx context.Context, sessionID string) ([]Vocabulary, error)
	GetFlashcards(ctx context.Context, sessionID string) ([]Flashcard, error)
	GetFlashcardImage(ctx context.Context, sessionID, filename string) (*ai_client.BinaryAsset, error)
	CreateRealtimeTranslationClientSecret(ctx context.Context, sessionID string) (*RealtimeTranslationClientSecretResponse, error)
	CommitTranslationStream(ctx context.Context, input TranslationCommitInput, emit PipelineEventSink) error
}

// Service implements SessionService over a Repository and an AIClient.
type Service struct {
	repo Repository
	ai   ai_client.AIClient
	log  *slog.Logger

	imageJobsMu  sync.Mutex
	imageJobs    map[string]struct{}
	imageJobGate chan struct{}

	commitGatesMu       sync.Mutex
	commitGates         map[string]*sessionCommitGate
	messageOrderMu      sync.Mutex
	translationSessions map[string]string
}

var _ SessionService = (*Service)(nil)

type finalizedArtifacts struct {
	vocabularies []Vocabulary
	flashcards   []Flashcard
}

type sessionCommitGate struct {
	blocked    bool
	finalizing bool
	inFlight   int
	drained    chan struct{}
}

// NewService constructs a Service.
func NewService(repo Repository, ai ai_client.AIClient, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{
		repo:                repo,
		ai:                  ai,
		log:                 log,
		imageJobs:           make(map[string]struct{}),
		imageJobGate:        make(chan struct{}, flashcardImageConcurrency),
		commitGates:         make(map[string]*sessionCommitGate),
		translationSessions: make(map[string]string),
	}
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

// ResetSession discards a session's recorded messages so
// the teacher can re-record without ending the class. Sequence numbers restart
// from 1. Only valid while the session is still active.
func (s *Service) ResetSession(ctx context.Context, sessionID string) error {
	session, err := s.repo.GetSession(ctx, sessionID)
	if err != nil {
		return err
	}
	if session.Status != StatusActive {
		return ErrSessionNotActive
	}
	if err := s.repo.DeleteMessages(ctx, sessionID); err != nil {
		return err
	}
	s.messageOrderMu.Lock()
	delete(s.translationSessions, sessionID)
	s.messageOrderMu.Unlock()
	return nil
}

// GetSummary returns the summary of a session.
func (s *Service) GetSummary(ctx context.Context, sessionID string) (*Summary, error) {
	if _, err := s.repo.GetSession(ctx, sessionID); err != nil {
		return nil, err
	}
	valid, err := s.hasValidTranscript(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if !valid {
		return nil, nil
	}

	return s.repo.GetSummary(ctx, sessionID)
}

// UpdateSummary persists a teacher-reviewed summary draft. It only edits the
// summary artifact; transcript, vocabulary, and flashcards remain unchanged.
func (s *Service) UpdateSummary(ctx context.Context, sessionID string, req UpdateSummaryRequest) (*Summary, error) {
	if _, err := s.repo.GetSession(ctx, sessionID); err != nil {
		return nil, err
	}

	existing, err := s.repo.GetSummary(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, ErrSummaryNotFound
	}

	summary := &Summary{
		SessionID:   sessionID,
		SummaryTh:   strings.TrimSpace(req.SummaryTh),
		SummaryEn:   strings.TrimSpace(req.SummaryEn),
		KeyPointsTh: cleanStringList(req.KeyPointsTh),
		KeyPointsEn: cleanStringList(req.KeyPointsEn),
		CreatedAt:   existing.CreatedAt,
	}
	if summary.CreatedAt.IsZero() {
		summary.CreatedAt = time.Now().UTC()
	}
	if err := s.repo.UpsertSummary(ctx, summary); err != nil {
		return nil, err
	}
	return summary, nil
}

// GetVocabularies returns the vocabularies of a session.
func (s *Service) GetVocabularies(ctx context.Context, sessionID string) ([]Vocabulary, error) {
	if _, err := s.repo.GetSession(ctx, sessionID); err != nil {
		return nil, err
	}
	valid, err := s.hasValidTranscript(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if !valid {
		return []Vocabulary{}, nil
	}

	return s.repo.GetVocabularies(ctx, sessionID)
}

// GetFlashcards returns the flashcards of a session.
func (s *Service) GetFlashcards(ctx context.Context, sessionID string) ([]Flashcard, error) {
	if _, err := s.repo.GetSession(ctx, sessionID); err != nil {
		return nil, err
	}
	valid, err := s.hasValidTranscript(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if !valid {
		return []Flashcard{}, nil
	}

	return s.repo.GetFlashcards(ctx, sessionID)
}

// GetFlashcardImage returns a cached generated flashcard image owned by a session.
func (s *Service) GetFlashcardImage(ctx context.Context, sessionID, filename string) (*ai_client.BinaryAsset, error) {
	if _, err := s.repo.GetSession(ctx, sessionID); err != nil {
		return nil, err
	}
	cards, err := s.repo.GetFlashcards(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	found := false
	for _, card := range cards {
		if flashcardImageFilename(card.ImageURL) == filename {
			found = true
			break
		}
	}
	if !found {
		return nil, ErrFlashcardImageNotFound
	}

	asset, err := s.ai.GetFlashcardImage(ctx, filename)
	if err != nil {
		return nil, ErrFlashcardImageNotFound
	}
	return asset, nil
}

// EndSession transitions active -> processing, runs finalization, persists the derived
// text artifacts, transitions to completed, then schedules image generation in the background.
// It is idempotent for already-completed/processing sessions.
func (s *Service) EndSession(ctx context.Context, sessionID string) (*Session, error) {
	session, err := s.repo.GetSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Idempotency: completed or in-flight sessions simply return current state.
	if session.Status == StatusCompleted || session.Status == StatusProcessing {
		return session, nil
	}

	processing, started, err := s.repo.TryStartSessionProcessing(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if !started {
		return processing, nil
	}

	gate := s.blockCommits(sessionID)
	removeGate := true
	defer func() {
		if removeGate {
			s.removeCommitGate(sessionID, gate)
		}
	}()
	if err := s.waitForCommitDrain(ctx, gate); err != nil {
		s.failSession(sessionID)
		s.abandonCommitGate(sessionID, gate)
		removeGate = false

		return processing, err
	}

	artifacts, err := s.finalize(ctx, sessionID)
	if err != nil {
		s.failSession(sessionID)

		return processing, err
	}

	endedAt := time.Now().UTC()
	completed, err := s.repo.UpdateSessionStatus(ctx, sessionID, StatusCompleted, &endedAt)
	if err != nil {
		s.failSession(sessionID)

		return nil, err
	}
	s.messageOrderMu.Lock()
	delete(s.translationSessions, sessionID)
	s.messageOrderMu.Unlock()

	s.scheduleFlashcardImageJob(sessionID, artifacts.flashcards, artifacts.vocabularies)

	return completed, nil
}

// finalize gathers messages, calls the ai-service, and persists summary/vocab/flashcards.
func (s *Service) finalize(ctx context.Context, sessionID string) (*finalizedArtifacts, error) {
	messages, err := s.repo.ListMessages(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if !messagesHaveValidTranscript(messages) {
		if err := s.repo.DeleteSummary(ctx, sessionID); err != nil {
			return nil, err
		}
		if err := s.repo.ReplaceVocabularies(ctx, sessionID, []Vocabulary{}); err != nil {
			return nil, err
		}
		if err := s.repo.ReplaceFlashcards(ctx, sessionID, []Flashcard{}); err != nil {
			return nil, err
		}

		return &finalizedArtifacts{vocabularies: []Vocabulary{}, flashcards: []Flashcard{}}, nil
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
		return nil, fmt.Errorf("finalize session %s: %w", sessionID, err)
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
		return nil, err
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
			DictionarySource:  v.DictionarySource,
			CreatedAt:         now,
		})
	}
	if err := s.repo.ReplaceVocabularies(ctx, sessionID, vocab); err != nil {
		return nil, err
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
			ImageURL:        f.ImageURL,
			ImageStatus:     defaultFlashcardImageStatus(f),
			CreatedAt:       now,
		})
	}
	if err := s.repo.ReplaceFlashcards(ctx, sessionID, cards); err != nil {
		return nil, err
	}

	return &finalizedArtifacts{vocabularies: vocab, flashcards: cards}, nil
}

func (s *Service) scheduleFlashcardImageJob(sessionID string, cards []Flashcard, vocabularies []Vocabulary) {
	if len(cards) == 0 {
		return
	}

	s.imageJobsMu.Lock()
	if _, running := s.imageJobs[sessionID]; running {
		s.imageJobsMu.Unlock()
		return
	}
	s.imageJobs[sessionID] = struct{}{}
	s.imageJobsMu.Unlock()

	go func() {
		defer func() {
			s.imageJobsMu.Lock()
			delete(s.imageJobs, sessionID)
			s.imageJobsMu.Unlock()
		}()

		s.imageJobGate <- struct{}{}
		defer func() { <-s.imageJobGate }()

		ctx, cancel := context.WithTimeout(context.Background(), flashcardImageTimeout)
		defer cancel()

		if err := s.generateFlashcardImages(ctx, sessionID, cards, vocabularies); err != nil {
			s.log.Warn("flashcard image job failed", "sessionId", sessionID, "error", err)
			failCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if ferr := s.markFlashcardImageJobFailed(failCtx, sessionID, cards); ferr != nil {
				s.log.Warn("mark flashcard image job failed", "sessionId", sessionID, "error", ferr)
			}
		}
	}()
}

func (s *Service) generateFlashcardImages(ctx context.Context, sessionID string, cards []Flashcard, vocabularies []Vocabulary) error {
	generated, err := s.ai.GenerateFlashcardImages(
		ctx,
		sessionID,
		finalizeFlashcardsFromCards(cards),
		finalizeVocabulariesFromVocabularies(vocabularies),
	)
	if err != nil {
		return fmt.Errorf("generate flashcard images: %w", err)
	}
	if len(generated) == 0 {
		return nil
	}

	updates := make([]FlashcardImageUpdate, 0, len(cards))
	for i, card := range cards {
		if i >= len(generated) {
			if card.ImageStatus == FlashcardImageStatusPending {
				updates = append(updates, FlashcardImageUpdate{
					Front:       card.Front,
					Back:        card.Back,
					Type:        card.Type,
					Word:        card.Word,
					ImageURL:    "",
					ImageStatus: FlashcardImageStatusFailed,
				})
			}
			continue
		}
		status := normalizeFlashcardImageStatus(generated[i].ImageStatus, generated[i].ImageURL)
		updates = append(updates, FlashcardImageUpdate{
			Front:       card.Front,
			Back:        card.Back,
			Type:        card.Type,
			Word:        card.Word,
			ImageURL:    generated[i].ImageURL,
			ImageStatus: status,
		})
	}

	if err := s.repo.UpdateFlashcardImageStates(ctx, sessionID, updates); err != nil {
		return fmt.Errorf("persist flashcard image urls: %w", err)
	}

	s.log.Info("flashcard image job done", "sessionId", sessionID, "flashcards", len(updates))
	return nil
}

func (s *Service) markFlashcardImageJobFailed(ctx context.Context, sessionID string, cards []Flashcard) error {
	updates := make([]FlashcardImageUpdate, 0, len(cards))
	for _, card := range cards {
		if card.ImageStatus != FlashcardImageStatusPending {
			continue
		}
		updates = append(updates, FlashcardImageUpdate{
			Front:       card.Front,
			Back:        card.Back,
			Type:        card.Type,
			Word:        card.Word,
			ImageURL:    "",
			ImageStatus: FlashcardImageStatusFailed,
		})
	}
	return s.repo.UpdateFlashcardImageStates(ctx, sessionID, updates)
}

func finalizeFlashcardsFromCards(cards []Flashcard) []ai_client.FinalizeFlashcard {
	out := make([]ai_client.FinalizeFlashcard, 0, len(cards))
	for _, card := range cards {
		out = append(out, ai_client.FinalizeFlashcard{
			Front:           card.Front,
			Back:            card.Back,
			Type:            card.Type,
			Word:            card.Word,
			HintTh:          card.HintTh,
			ExampleSentence: card.ExampleSentence,
			ImageURL:        card.ImageURL,
			ImageStatus:     card.ImageStatus,
		})
	}
	return out
}

func finalizeVocabulariesFromVocabularies(vocabularies []Vocabulary) []ai_client.FinalizeVocabulary {
	out := make([]ai_client.FinalizeVocabulary, 0, len(vocabularies))
	for _, vocabulary := range vocabularies {
		out = append(out, ai_client.FinalizeVocabulary{
			Word:              vocabulary.Word,
			Pronunciation:     vocabulary.Pronunciation,
			PartOfSpeech:      vocabulary.PartOfSpeech,
			MeaningTh:         vocabulary.MeaningTh,
			MeaningEn:         vocabulary.MeaningEn,
			ExampleSentenceEn: vocabulary.ExampleSentenceEn,
			ExampleSentenceTh: vocabulary.ExampleSentenceTh,
			DifficultyLevel:   vocabulary.DifficultyLevel,
			DictionarySource:  vocabulary.DictionarySource,
		})
	}
	return out
}

func defaultFlashcardImageStatus(card ai_client.FinalizeFlashcard) string {
	if card.ImageStatus != "" {
		return normalizeFlashcardImageStatus(card.ImageStatus, card.ImageURL)
	}
	if card.ImageURL != "" {
		return FlashcardImageStatusReady
	}
	if card.Type != FlashcardTypeVocabulary || (strings.TrimSpace(card.Word) == "" && strings.TrimSpace(card.Front) == "") {
		return FlashcardImageStatusSkipped
	}
	return FlashcardImageStatusPending
}

func normalizeFlashcardImageStatus(status, imageURL string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case FlashcardImageStatusReady:
		if imageURL == "" {
			return FlashcardImageStatusFailed
		}
		return FlashcardImageStatusReady
	case FlashcardImageStatusSkipped:
		return FlashcardImageStatusSkipped
	case FlashcardImageStatusFailed:
		return FlashcardImageStatusFailed
	case FlashcardImageStatusPending:
		return FlashcardImageStatusPending
	default:
		if imageURL != "" {
			return FlashcardImageStatusReady
		}
		return FlashcardImageStatusFailed
	}
}

func flashcardImageFilename(imageURL string) string {
	clean := strings.TrimSpace(imageURL)
	if clean == "" {
		return ""
	}
	idx := strings.LastIndex(clean, "/")
	if idx < 0 {
		return clean
	}
	return clean[idx+1:]
}

// CreateRealtimeTranslationClientSecret validates the persisted session before
// asking ai-service for a short-lived browser credential.
func (s *Service) CreateRealtimeTranslationClientSecret(ctx context.Context, sessionID string) (*RealtimeTranslationClientSecretResponse, error) {
	session, err := s.repo.GetSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if session.Status != StatusActive {
		return nil, ErrSessionNotActive
	}
	secret, err := s.ai.MintRealtimeTranslationClientSecret(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("mint realtime translation client secret: %w", err)
	}
	session, err = s.repo.GetSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if session.Status != StatusActive {
		return nil, ErrSessionNotActive
	}
	s.messageOrderMu.Lock()
	session, err = s.repo.GetSession(ctx, sessionID)
	if err != nil {
		s.messageOrderMu.Unlock()
		return nil, err
	}
	if session.Status != StatusActive {
		s.messageOrderMu.Unlock()
		return nil, ErrSessionNotActive
	}
	messages, err := s.repo.ListMessages(ctx, sessionID)
	if err != nil {
		s.messageOrderMu.Unlock()
		return nil, err
	}
	lastCommitNo := 0
	for _, message := range messages {
		if message.SequenceNo > lastCommitNo {
			lastCommitNo = message.SequenceNo
		}
	}
	s.translationSessions[sessionID] = secret.TranslationSessionId
	s.messageOrderMu.Unlock()

	return &RealtimeTranslationClientSecretResponse{
		ClientSecret:         secret.ClientSecret,
		ExpiresAt:            secret.ExpiresAt,
		TranslationSessionId: secret.TranslationSessionId,
		LastCommitNo:         lastCommitNo,
		Model:                secret.Model,
		TargetLanguage:       secret.TargetLanguage,
	}, nil
}

// CommitTranslationStream persists one immutable transcript pair exactly once,
// runs non-fatal Cartesia TTS, then acknowledges completion.
func (s *Service) CommitTranslationStream(ctx context.Context, input TranslationCommitInput, emit PipelineEventSink) error {
	if err := validateTranslationCommit(input); err != nil {
		return err
	}

	gate, registered := s.startCommit(input.SessionID)
	if !registered {
		return ErrSessionNotActive
	}
	defer s.finishCommit(input.SessionID, gate)

	input.VoiceProfile = normalizeTTSVoiceProfile(input.VoiceProfile)
	input.SpeechSpeed = normalizeTTSSpeechSpeed(input.SpeechSpeed)
	now := time.Now().UTC()
	message := &Message{
		SessionID:            input.SessionID,
		CommitId:             input.CommitId,
		CommitHash:           translationCommitHash(input),
		TranslationSessionId: input.TranslationSessionId,
		CommitNo:             input.CommitNo,
		CommitKind:           input.CommitKind,
		SourceText:           input.SourceText,
		TranslatedText:       input.TranslatedText,
		SourceLanguage:       SourceLanguage,
		TargetLanguage:       TargetLanguage,
		VoiceProfile:         input.VoiceProfile,
		SpeechSpeed:          input.SpeechSpeed,
		IsFinal:              true,
		SourceElapsedMs:      input.SourceElapsedMs,
		TargetElapsedMs:      input.TargetElapsedMs,
		StartedAt:            &now,
		EndedAt:              &now,
		CreatedAt:            now,
	}

	persistStart := time.Now()
	s.messageOrderMu.Lock()
	activeTranslationSessionID := s.translationSessions[input.SessionID]
	if activeTranslationSessionID == "" {
		s.translationSessions[input.SessionID] = input.TranslationSessionId
	} else if activeTranslationSessionID != input.TranslationSessionId {
		s.messageOrderMu.Unlock()
		return ErrCommitConflict
	}
	persisted, created, err := s.repo.CommitMessage(ctx, message)
	s.messageOrderMu.Unlock()
	if err != nil {
		return err
	}
	if persisted.CommitHash != message.CommitHash {
		return ErrCommitConflict
	}
	persistMs := time.Since(persistStart).Milliseconds()

	ttsStart := time.Now()
	tts, err := s.ai.TTS(
		ctx,
		persisted.SessionID,
		persisted.TranslatedText,
		persisted.VoiceProfile,
		persisted.SpeechSpeed,
	)
	ttsMs := time.Since(ttsStart).Milliseconds()
	if err != nil || tts == nil || strings.TrimSpace(tts.AudioBase64) == "" {
		s.log.Warn(
			"tts failed (non-fatal)",
			"sessionId", persisted.SessionID,
			"commitId", persisted.CommitId,
			"ttsMs", ttsMs,
			"error", err,
		)
		if emit != nil {
			emit(pipelineCommitError(persisted, PipeErrTTSFailed, "text-to-speech failed"))
			emit(translationCommittedEvent(persisted, !created))
		}

		return nil
	}

	s.log.Info(
		"translation commit latency",
		"sessionId", persisted.SessionID,
		"commitId", persisted.CommitId,
		"sequenceNo", persisted.SequenceNo,
		"persistMs", persistMs,
		"ttsMs", ttsMs,
	)
	if emit != nil {
		emit(ttsAudioEvent(persisted, tts.AudioURL, tts.AudioBase64, tts.PlaybackRate))
		emit(translationCommittedEvent(persisted, !created))
	}

	return nil
}

func validateTranslationCommit(input TranslationCommitInput) error {
	if strings.TrimSpace(input.SessionID) == "" ||
		strings.TrimSpace(input.TranslationSessionId) == "" ||
		strings.TrimSpace(input.CommitId) == "" ||
		len(input.TranslationSessionId) > maxCommitIdentifierBytes ||
		len(input.CommitId) > maxCommitIdentifierBytes ||
		input.CommitNo <= 0 ||
		strings.TrimSpace(input.SourceText) == "" ||
		strings.TrimSpace(input.TranslatedText) == "" ||
		len(input.SourceText) > maxCommittedTextBytes ||
		len(input.TranslatedText) > maxCommittedTextBytes ||
		input.SourceElapsedMs < 0 ||
		input.TargetElapsedMs < 0 {
		return ErrInvalidTranslationCommit
	}
	if input.CommitKind != TranslationCommitKindDebounced && input.CommitKind != TranslationCommitKindFinal {
		return ErrInvalidTranslationCommit
	}

	return nil
}

func translationCommitHash(input TranslationCommitInput) string {
	canonical := fmt.Sprintf(
		"%d:%s|%d:%s|%d:%s|%d:%s|%d:%s|%d|%d|%d|%d:%s|%d:%s",
		len(input.SessionID), input.SessionID,
		len(input.TranslationSessionId), input.TranslationSessionId,
		len(input.CommitId), input.CommitId,
		len(input.CommitKind), input.CommitKind,
		len(input.SourceText), input.SourceText,
		input.CommitNo,
		input.SourceElapsedMs,
		input.TargetElapsedMs,
		len(input.TranslatedText), input.TranslatedText,
		len(input.VoiceProfile), input.VoiceProfile+"|"+input.SpeechSpeed,
	)
	sum := sha256.Sum256([]byte(canonical))

	return fmt.Sprintf("%x", sum)
}

func (s *Service) hasValidTranscript(ctx context.Context, sessionID string) (bool, error) {
	messages, err := s.repo.ListMessages(ctx, sessionID)
	if err != nil {
		return false, err
	}

	return messagesHaveValidTranscript(messages), nil
}

func messagesHaveValidTranscript(messages []Message) bool {
	for _, message := range messages {
		if strings.TrimSpace(message.SourceText) != "" {
			return true
		}
	}

	return false
}

func (s *Service) failSession(sessionID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := s.repo.UpdateSessionStatus(ctx, sessionID, StatusFailed, nil); err != nil {
		s.log.Error("mark session failed", "sessionId", sessionID, "error", err)
	}
}

func (s *Service) startCommit(sessionID string) (*sessionCommitGate, bool) {
	s.commitGatesMu.Lock()
	defer s.commitGatesMu.Unlock()

	gate := s.commitGates[sessionID]
	if gate == nil {
		gate = &sessionCommitGate{}
		s.commitGates[sessionID] = gate
	}
	if gate.blocked {
		return gate, false
	}
	if gate.inFlight == 0 {
		gate.drained = make(chan struct{})
	}
	gate.inFlight++

	return gate, true
}

func (s *Service) finishCommit(sessionID string, gate *sessionCommitGate) {
	s.commitGatesMu.Lock()
	defer s.commitGatesMu.Unlock()

	gate.inFlight--
	if gate.inFlight == 0 {
		close(gate.drained)
		if !gate.finalizing && s.commitGates[sessionID] == gate {
			delete(s.commitGates, sessionID)
		}
	}
}

func (s *Service) blockCommits(sessionID string) *sessionCommitGate {
	s.commitGatesMu.Lock()
	defer s.commitGatesMu.Unlock()

	gate := s.commitGates[sessionID]
	if gate == nil {
		gate = &sessionCommitGate{}
		s.commitGates[sessionID] = gate
	}
	gate.blocked = true
	gate.finalizing = true

	return gate
}

func (s *Service) waitForCommitDrain(ctx context.Context, gate *sessionCommitGate) error {
	s.commitGatesMu.Lock()
	if gate.inFlight == 0 {
		s.commitGatesMu.Unlock()

		return nil
	}
	drained := gate.drained
	s.commitGatesMu.Unlock()

	select {
	case <-drained:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Service) abandonCommitGate(sessionID string, gate *sessionCommitGate) {
	s.commitGatesMu.Lock()
	defer s.commitGatesMu.Unlock()

	if s.commitGates[sessionID] != gate {
		return
	}
	gate.finalizing = false
	if gate.inFlight == 0 {
		delete(s.commitGates, sessionID)
	}
}

func (s *Service) removeCommitGate(sessionID string, gate *sessionCommitGate) {
	s.commitGatesMu.Lock()
	defer s.commitGatesMu.Unlock()

	if s.commitGates[sessionID] == gate {
		delete(s.commitGates, sessionID)
	}
}

func nonNilStrings(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

func cleanStringList(in []string) []string {
	if len(in) == 0 {
		return []string{}
	}
	out := make([]string, 0, len(in))
	for _, item := range in {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		out = append(out, item)
	}
	return out
}

func normalizeTTSVoiceProfile(profile string) string {
	switch strings.ToLower(strings.TrimSpace(profile)) {
	case TTSVoiceProfileChildGirl:
		return TTSVoiceProfileChildGirl
	case TTSVoiceProfileChildBoy:
		return TTSVoiceProfileChildBoy
	case TTSVoiceProfileAdultMan:
		return TTSVoiceProfileAdultMan
	case TTSVoiceProfileAdultWoman:
		return TTSVoiceProfileAdultWoman
	default:
		return TTSVoiceProfileAdultWoman
	}
}

func normalizeTTSSpeechSpeed(speed string) string {
	switch strings.ToLower(strings.TrimSpace(speed)) {
	case TTSSpeechSpeedSlow:
		return TTSSpeechSpeedSlow
	case TTSSpeechSpeedFast:
		return TTSSpeechSpeedFast
	case TTSSpeechSpeedMedium:
		return TTSSpeechSpeedMedium
	default:
		return TTSSpeechSpeedMedium
	}
}
