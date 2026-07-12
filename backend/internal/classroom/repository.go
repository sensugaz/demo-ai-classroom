package classroom

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"github.com/ai-classroom/backend/internal/database"
)

// ErrSessionNotFound is returned when a session lookup yields no document.
var ErrSessionNotFound = errors.New("session not found")

// ErrSessionNotActive is returned when an operation (e.g. reset) requires an
// active session but the session is processing/completed/failed.
var ErrSessionNotActive = errors.New("session is not active")

// ErrCommitConflict is returned when an idempotency identity is reused for different content.
var ErrCommitConflict = errors.New("translation commit conflicts with an existing message")

// ErrFlashcardImageNotFound is returned when an image is absent or not owned by the session.
var ErrFlashcardImageNotFound = errors.New("flashcard image not found")

// ErrSummaryNotFound is returned when a teacher tries to edit a summary before
// finalization has generated one.
var ErrSummaryNotFound = errors.New("summary not found")

// Repository is the persistence contract for the classroom domain.
type Repository interface {
	CreateSession(ctx context.Context, s *Session) error
	GetSession(ctx context.Context, sessionID string) (*Session, error)
	ListSessions(ctx context.Context) ([]Session, error)
	TryStartSessionProcessing(ctx context.Context, sessionID string) (*Session, bool, error)
	UpdateSessionStatus(ctx context.Context, sessionID, status string, endedAt *time.Time) (*Session, error)

	CommitMessage(ctx context.Context, m *Message) (*Message, bool, error)
	GetMessageByCommitId(ctx context.Context, sessionID, commitId string) (*Message, error)
	ListMessages(ctx context.Context, sessionID string) ([]Message, error)
	DeleteMessages(ctx context.Context, sessionID string) error

	UpsertSummary(ctx context.Context, s *Summary) error
	DeleteSummary(ctx context.Context, sessionID string) error
	ReplaceVocabularies(ctx context.Context, sessionID string, vocab []Vocabulary) error
	ReplaceFlashcards(ctx context.Context, sessionID string, cards []Flashcard) error
	UpdateFlashcardImageStates(ctx context.Context, sessionID string, updates []FlashcardImageUpdate) error

	GetSummary(ctx context.Context, sessionID string) (*Summary, error)
	GetVocabularies(ctx context.Context, sessionID string) ([]Vocabulary, error)
	GetFlashcards(ctx context.Context, sessionID string) ([]Flashcard, error)
}

// MongoRepository is the MongoDB-backed Repository implementation.
type MongoRepository struct {
	sessions     *mongo.Collection
	messages     *mongo.Collection
	summaries    *mongo.Collection
	vocabularies *mongo.Collection
	flashcards   *mongo.Collection
}

var _ Repository = (*MongoRepository)(nil)

// NewMongoRepository wires collection handles from the given database.
func NewMongoRepository(db *mongo.Database) *MongoRepository {
	return &MongoRepository{
		sessions:     db.Collection(database.CollectionSessions),
		messages:     db.Collection(database.CollectionMessages),
		summaries:    db.Collection(database.CollectionSummaries),
		vocabularies: db.Collection(database.CollectionVocabularies),
		flashcards:   db.Collection(database.CollectionFlashcards),
	}
}

// CreateSession inserts a new session.
func (r *MongoRepository) CreateSession(ctx context.Context, s *Session) error {
	if _, err := r.sessions.InsertOne(ctx, s); err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	return nil
}

// GetSession fetches a session by id, returning ErrSessionNotFound when absent.
func (r *MongoRepository) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	var s Session
	err := r.sessions.FindOne(ctx, bson.M{"sessionId": sessionID}).Decode(&s)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrSessionNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}
	return &s, nil
}

// ListSessions returns all sessions, newest first.
func (r *MongoRepository) ListSessions(ctx context.Context) ([]Session, error) {
	opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}})
	cur, err := r.sessions.Find(ctx, bson.M{}, opts)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer func() { _ = cur.Close(ctx) }()

	sessions := make([]Session, 0)
	if err := cur.All(ctx, &sessions); err != nil {
		return nil, fmt.Errorf("decode sessions: %w", err)
	}
	return sessions, nil
}

// TryStartSessionProcessing atomically moves an active or failed session to processing.
func (r *MongoRepository) TryStartSessionProcessing(ctx context.Context, sessionID string) (*Session, bool, error) {
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var updated Session
	err := r.sessions.FindOneAndUpdate(
		ctx,
		bson.M{"sessionId": sessionID, "status": bson.M{"$in": []string{StatusActive, StatusFailed}}},
		bson.M{"$set": bson.M{"status": StatusProcessing, "updatedAt": time.Now().UTC()}},
		opts,
	).Decode(&updated)
	if err == nil {
		return &updated, true, nil
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, false, fmt.Errorf("start session processing: %w", err)
	}

	session, err := r.GetSession(ctx, sessionID)
	if err != nil {
		return nil, false, err
	}
	return session, false, nil
}

// UpdateSessionStatus sets the status (and optionally endedAt) and returns the updated doc.
func (r *MongoRepository) UpdateSessionStatus(ctx context.Context, sessionID, status string, endedAt *time.Time) (*Session, error) {
	set := bson.M{"status": status, "updatedAt": time.Now().UTC()}
	if endedAt != nil {
		set["endedAt"] = endedAt.UTC()
	}

	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var updated Session
	err := r.sessions.FindOneAndUpdate(ctx, bson.M{"sessionId": sessionID}, bson.M{"$set": set}, opts).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrSessionNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("update session status: %w", err)
	}
	return &updated, nil
}

// CommitMessage atomically inserts one immutable translation pair by commitId.
// It returns created=false for a retry that already exists.
func (r *MongoRepository) CommitMessage(ctx context.Context, message *Message) (*Message, bool, error) {
	existing, err := r.findMessageByCommitId(ctx, message.SessionID, message.CommitId)
	if err != nil {
		return nil, false, err
	}
	if existing != nil {
		return existing, false, nil
	}

	var session Session
	err = r.sessions.FindOne(ctx, bson.M{"sessionId": message.SessionID}).Decode(&session)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, false, ErrSessionNotFound
	}
	if err != nil {
		return nil, false, fmt.Errorf("check commit session: %w", err)
	}
	if session.Status != StatusActive {
		return nil, false, ErrSessionNotActive
	}
	message.SequenceNo = message.CommitNo

	result, err := r.messages.UpdateOne(
		ctx,
		bson.M{"sessionId": message.SessionID, "commitId": message.CommitId},
		bson.M{"$setOnInsert": message},
		options.Update().SetUpsert(true),
	)
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			existing, err := r.findMessageByCommitId(ctx, message.SessionID, message.CommitId)
			if err != nil {
				return nil, false, err
			}
			if existing != nil {
				return existing, false, nil
			}

			return nil, false, ErrCommitConflict
		}

		return nil, false, fmt.Errorf("commit message: %w", err)
	}

	persisted, err := r.findMessageByCommitId(ctx, message.SessionID, message.CommitId)
	if err != nil {
		return nil, false, err
	}
	if persisted == nil {
		return nil, false, fmt.Errorf("commit message: inserted message not found")
	}

	return persisted, result.UpsertedCount == 1, nil
}

// GetMessageByCommitId returns a previously persisted idempotent commit.
func (r *MongoRepository) GetMessageByCommitId(ctx context.Context, sessionID, commitId string) (*Message, error) {
	return r.findMessageByCommitId(ctx, sessionID, commitId)
}

func (r *MongoRepository) findMessageByCommitId(ctx context.Context, sessionID, commitId string) (*Message, error) {
	var message Message
	err := r.messages.FindOne(ctx, bson.M{"sessionId": sessionID, "commitId": commitId}).Decode(&message)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find message by commit id: %w", err)
	}

	return &message, nil
}

// ListMessages returns messages for a session ordered by sequenceNo ascending.
func (r *MongoRepository) ListMessages(ctx context.Context, sessionID string) ([]Message, error) {
	opts := options.Find().SetSort(bson.D{{Key: "sequenceNo", Value: 1}})
	cur, err := r.messages.Find(ctx, bson.M{"sessionId": sessionID}, opts)
	if err != nil {
		return nil, fmt.Errorf("list messages: %w", err)
	}
	defer func() { _ = cur.Close(ctx) }()

	messages := make([]Message, 0)
	if err := cur.All(ctx, &messages); err != nil {
		return nil, fmt.Errorf("decode messages: %w", err)
	}
	return messages, nil
}

// DeleteMessages removes all messages for a session (used by Reset so the
// teacher can re-record; sequence numbers then restart from 1).
func (r *MongoRepository) DeleteMessages(ctx context.Context, sessionID string) error {
	if _, err := r.messages.DeleteMany(ctx, bson.M{"sessionId": sessionID}); err != nil {
		return fmt.Errorf("delete messages: %w", err)
	}
	if _, err := r.sessions.UpdateOne(
		ctx,
		bson.M{"sessionId": sessionID},
		bson.M{"$set": bson.M{"updatedAt": time.Now().UTC()}, "$unset": bson.M{"messageSequenceNo": ""}},
	); err != nil {
		return fmt.Errorf("reset message sequence: %w", err)
	}

	return nil
}

// UpsertSummary inserts or replaces the summary for a session.
func (r *MongoRepository) UpsertSummary(ctx context.Context, s *Summary) error {
	opts := options.Replace().SetUpsert(true)
	if _, err := r.summaries.ReplaceOne(ctx, bson.M{"sessionId": s.SessionID}, s, opts); err != nil {
		return fmt.Errorf("upsert summary: %w", err)
	}
	return nil
}

// DeleteSummary removes a session summary if one exists.
func (r *MongoRepository) DeleteSummary(ctx context.Context, sessionID string) error {
	if _, err := r.summaries.DeleteOne(ctx, bson.M{"sessionId": sessionID}); err != nil {
		return fmt.Errorf("delete summary: %w", err)
	}

	return nil
}

// ReplaceVocabularies atomically swaps a session's vocabularies for the supplied set.
func (r *MongoRepository) ReplaceVocabularies(ctx context.Context, sessionID string, vocab []Vocabulary) error {
	if _, err := r.vocabularies.DeleteMany(ctx, bson.M{"sessionId": sessionID}); err != nil {
		return fmt.Errorf("clear vocabularies: %w", err)
	}
	if len(vocab) == 0 {
		return nil
	}
	docs := make([]any, len(vocab))
	for i := range vocab {
		docs[i] = vocab[i]
	}
	if _, err := r.vocabularies.InsertMany(ctx, docs); err != nil {
		return fmt.Errorf("insert vocabularies: %w", err)
	}
	return nil
}

// ReplaceFlashcards atomically swaps a session's flashcards for the supplied set.
func (r *MongoRepository) ReplaceFlashcards(ctx context.Context, sessionID string, cards []Flashcard) error {
	if _, err := r.flashcards.DeleteMany(ctx, bson.M{"sessionId": sessionID}); err != nil {
		return fmt.Errorf("clear flashcards: %w", err)
	}
	if len(cards) == 0 {
		return nil
	}
	docs := make([]any, len(cards))
	for i := range cards {
		docs[i] = cards[i]
	}
	if _, err := r.flashcards.InsertMany(ctx, docs); err != nil {
		return fmt.Errorf("insert flashcards: %w", err)
	}
	return nil
}

// UpdateFlashcardImageStates updates image fields in place without clearing cards.
func (r *MongoRepository) UpdateFlashcardImageStates(ctx context.Context, sessionID string, updates []FlashcardImageUpdate) error {
	if len(updates) == 0 {
		return nil
	}

	models := make([]mongo.WriteModel, 0, len(updates))
	for _, update := range updates {
		models = append(models, mongo.NewUpdateManyModel().
			SetFilter(bson.M{
				"sessionId": sessionID,
				"front":     update.Front,
				"back":      update.Back,
				"type":      update.Type,
				"word":      update.Word,
			}).
			SetUpdate(bson.M{
				"$set": bson.M{
					"imageUrl":    update.ImageURL,
					"imageStatus": update.ImageStatus,
				},
			}))
	}

	opts := options.BulkWrite().SetOrdered(false)
	if _, err := r.flashcards.BulkWrite(ctx, models, opts); err != nil {
		return fmt.Errorf("update flashcard image states: %w", err)
	}
	return nil
}

// GetSummary returns the summary for a session, or nil when none exists.
func (r *MongoRepository) GetSummary(ctx context.Context, sessionID string) (*Summary, error) {
	var s Summary
	err := r.summaries.FindOne(ctx, bson.M{"sessionId": sessionID}).Decode(&s)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get summary: %w", err)
	}
	return &s, nil
}

// GetVocabularies returns the vocabularies for a session ordered by creation.
func (r *MongoRepository) GetVocabularies(ctx context.Context, sessionID string) ([]Vocabulary, error) {
	opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}})
	cur, err := r.vocabularies.Find(ctx, bson.M{"sessionId": sessionID}, opts)
	if err != nil {
		return nil, fmt.Errorf("get vocabularies: %w", err)
	}
	defer func() { _ = cur.Close(ctx) }()

	vocab := make([]Vocabulary, 0)
	if err := cur.All(ctx, &vocab); err != nil {
		return nil, fmt.Errorf("decode vocabularies: %w", err)
	}
	return vocab, nil
}

// GetFlashcards returns the flashcards for a session ordered by creation.
func (r *MongoRepository) GetFlashcards(ctx context.Context, sessionID string) ([]Flashcard, error) {
	opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}})
	cur, err := r.flashcards.Find(ctx, bson.M{"sessionId": sessionID}, opts)
	if err != nil {
		return nil, fmt.Errorf("get flashcards: %w", err)
	}
	defer func() { _ = cur.Close(ctx) }()

	cards := make([]Flashcard, 0)
	if err := cur.All(ctx, &cards); err != nil {
		return nil, fmt.Errorf("decode flashcards: %w", err)
	}
	return cards, nil
}
