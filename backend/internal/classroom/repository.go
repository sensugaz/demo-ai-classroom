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

// Repository is the persistence contract for the classroom domain.
type Repository interface {
	CreateSession(ctx context.Context, s *Session) error
	GetSession(ctx context.Context, sessionID string) (*Session, error)
	ListSessions(ctx context.Context) ([]Session, error)
	UpdateSessionStatus(ctx context.Context, sessionID, status string, endedAt *time.Time) (*Session, error)

	InsertMessage(ctx context.Context, m *Message) (*Message, error)
	ListMessages(ctx context.Context, sessionID string) ([]Message, error)
	DeleteMessages(ctx context.Context, sessionID string) error

	UpsertSummary(ctx context.Context, s *Summary) error
	ReplaceVocabularies(ctx context.Context, sessionID string, vocab []Vocabulary) error
	ReplaceFlashcards(ctx context.Context, sessionID string, cards []Flashcard) error

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

// InsertMessage assigns the next sequenceNo for the session and inserts the message.
//
// The sequence is derived from the current max sequenceNo for the session. The unique
// (sessionId, sequenceNo) index guards against duplicates under races; a single retry
// recovers from a concurrent insert that claimed the same number.
func (r *MongoRepository) InsertMessage(ctx context.Context, m *Message) (*Message, error) {
	const maxRetries = 5
	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		next, err := r.nextSequenceNo(ctx, m.SessionID)
		if err != nil {
			return nil, err
		}
		m.SequenceNo = next
		if _, err := r.messages.InsertOne(ctx, m); err != nil {
			if mongo.IsDuplicateKeyError(err) {
				lastErr = err
				continue
			}
			return nil, fmt.Errorf("insert message: %w", err)
		}
		return m, nil
	}
	return nil, fmt.Errorf("insert message after retries: %w", lastErr)
}

func (r *MongoRepository) nextSequenceNo(ctx context.Context, sessionID string) (int, error) {
	opts := options.FindOne().
		SetSort(bson.D{{Key: "sequenceNo", Value: -1}}).
		SetProjection(bson.M{"sequenceNo": 1})

	var last Message
	err := r.messages.FindOne(ctx, bson.M{"sessionId": sessionID}, opts).Decode(&last)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return 1, nil
	}
	if err != nil {
		return 0, fmt.Errorf("compute next sequence: %w", err)
	}
	return last.SequenceNo + 1, nil
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
