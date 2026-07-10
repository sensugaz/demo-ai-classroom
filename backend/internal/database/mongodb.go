// Package database provides MongoDB connection helpers and index management.
package database

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// Collection names used across the persistence layer.
const (
	CollectionSessions     = "classroom_sessions"
	CollectionMessages     = "classroom_messages"
	CollectionSummaries    = "classroom_summaries"
	CollectionVocabularies = "classroom_vocabularies"
	CollectionFlashcards   = "classroom_flashcards"
)

// Connect dials MongoDB, verifies connectivity with a ping, and returns the target database handle.
func Connect(ctx context.Context, uri, dbName string) (*mongo.Client, *mongo.Database, error) {
	clientOpts := options.Client().
		ApplyURI(uri).
		SetServerSelectionTimeout(10 * time.Second)

	client, err := mongo.Connect(ctx, clientOpts)
	if err != nil {
		return nil, nil, fmt.Errorf("connect mongo: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx, nil); err != nil {
		_ = client.Disconnect(ctx)
		return nil, nil, fmt.Errorf("ping mongo: %w", err)
	}

	return client, client.Database(dbName), nil
}

// EnsureIndexes creates all indexes required by the application. It is idempotent.
func EnsureIndexes(ctx context.Context, db *mongo.Database) error {
	idxCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Unique sessionId on sessions.
	if _, err := db.Collection(CollectionSessions).Indexes().CreateOne(idxCtx, mongo.IndexModel{
		Keys:    bson.D{{Key: "sessionId", Value: 1}},
		Options: options.Index().SetUnique(true).SetName("uniq_sessionId"),
	}); err != nil {
		return fmt.Errorf("index sessions.sessionId: %w", err)
	}

	// Message ordering and idempotency indexes. Partial filters allow legacy
	// pre-migration messages, which do not have commit identity fields.
	if _, err := db.Collection(CollectionMessages).Indexes().CreateMany(idxCtx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "sessionId", Value: 1}, {Key: "sequenceNo", Value: 1}},
			Options: options.Index().SetUnique(true).SetName("uniq_session_sequence"),
		},
		{
			Keys: bson.D{{Key: "sessionId", Value: 1}, {Key: "commitId", Value: 1}},
			Options: options.Index().
				SetUnique(true).
				SetName("uniq_session_commit").
				SetPartialFilterExpression(bson.M{"commitId": bson.M{"$type": "string"}}),
		},
		{
			Keys: bson.D{{Key: "sessionId", Value: 1}, {Key: "translationSessionId", Value: 1}, {Key: "commitNo", Value: 1}},
			Options: options.Index().
				SetUnique(true).
				SetName("uniq_session_translation_commit_no").
				SetPartialFilterExpression(bson.M{
					"translationSessionId": bson.M{"$type": "string"},
					"commitNo":             bson.M{"$type": "number"},
				}),
		},
	}); err != nil {
		return fmt.Errorf("index messages: %w", err)
	}

	// sessionId lookup indexes on the derived collections.
	for _, coll := range []string{CollectionSummaries, CollectionVocabularies, CollectionFlashcards} {
		if _, err := db.Collection(coll).Indexes().CreateOne(idxCtx, mongo.IndexModel{
			Keys:    bson.D{{Key: "sessionId", Value: 1}},
			Options: options.Index().SetName("idx_sessionId"),
		}); err != nil {
			return fmt.Errorf("index %s.sessionId: %w", coll, err)
		}
	}

	return nil
}
