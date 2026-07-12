package websocket

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ai-classroom/backend/internal/classroom"
)

const (
	// writeWait is how long a write may block before timing out.
	writeWait = 10 * time.Second
	// pongWait is how long we wait for a pong before considering the peer dead.
	pongWait = 60 * time.Second
	// pingPeriod must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10
	// sendBuffer is the per-client outbound queue depth.
	sendBuffer = 64
	// maxInboundMessageSize bounds JSON text commits and control frames.
	maxInboundMessageSize = 1 << 20
)

// Client is a single WebSocket connection bound (after session:join) to one session.
type Client struct {
	conn      *websocket.Conn
	send      chan []byte
	hub       *Hub
	svc       classroom.SessionService
	log       *slog.Logger
	mu        sync.Mutex
	sessionID string
	closed    bool
	closeOnce sync.Once
}

// NewClient wires a Client around an upgraded connection.
func NewClient(conn *websocket.Conn, hub *Hub, svc classroom.SessionService, log *slog.Logger) *Client {
	return &Client{
		conn: conn,
		send: make(chan []byte, sendBuffer),
		hub:  hub,
		svc:  svc,
		log:  log,
	}
}

// Run starts the read and write pumps and blocks until the connection closes.
func (c *Client) Run() {
	go c.writePump()
	c.readPump()
}

// TrySend enqueues a frame without blocking; it drops the frame if the buffer is full
// or the client has already shut down. The mutex guards against a send on a closed channel
// racing with shutdown.
func (c *Client) TrySend(message []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	select {
	case c.send <- message:
	default:
		c.log.Warn("dropping frame for slow client", "sessionId", c.sessionID)
	}
}

// SendCritical enqueues a frame that participates in client-side correctness.
// Unlike live display frames, a persistence acknowledgement must not be dropped just
// because the outbound queue is briefly full.
func (c *Client) SendCritical(message []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}

	timer := time.NewTimer(writeWait)
	defer timer.Stop()
	select {
	case c.send <- message:
		return true
	case <-timer.C:
		c.log.Warn("critical frame timed out", "sessionId", c.sessionID)

		return false
	}
}

func (c *Client) getSessionID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sessionID
}

func (c *Client) setSessionID(id string) {
	c.mu.Lock()
	c.sessionID = id
	c.mu.Unlock()
}

// readPump reads bounded JSON frames and dispatches events.
func (c *Client) readPump() {
	defer c.shutdown()

	c.conn.SetReadLimit(maxInboundMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				c.log.Warn("ws read error", "sessionId", c.getSessionID(), "error", err)
			}
			return
		}

		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			c.TrySend(errorFrame(c.getSessionID(), ErrCodeInvalidPayload, "malformed envelope"))
			continue
		}
		c.dispatch(env)
	}
}

func (c *Client) dispatch(env Envelope) {
	switch env.Event {
	case EventSessionJoin:
		var p SessionJoinPayload
		if err := json.Unmarshal(env.Payload, &p); err != nil || p.SessionID == "" {
			c.TrySend(errorFrame(c.getSessionID(), ErrCodeInvalidPayload, "invalid session:join payload"))
			return
		}
		c.handleJoin(p.SessionID)

	case EventTranslationCommit:
		var p TranslationCommitPayload
		if err := json.Unmarshal(env.Payload, &p); err != nil || p.SessionID == "" {
			c.TrySend(errorFrame(c.getSessionID(), ErrCodeInvalidPayload, "invalid translation:commit payload"))
			return
		}
		if p.SessionID != c.getSessionID() {
			c.TrySend(errorFrame(p.SessionID, ErrCodeSessionUnknown, "session is not joined on this connection"))
			return
		}
		c.handleTranslationCommit(p)

	case EventSessionEnd:
		var p SessionEndPayload
		if err := json.Unmarshal(env.Payload, &p); err != nil || p.SessionID == "" {
			c.TrySend(errorFrame(c.getSessionID(), ErrCodeInvalidPayload, "invalid session:end payload"))
			return
		}
		if p.SessionID != c.getSessionID() {
			c.TrySend(errorFrame(p.SessionID, ErrCodeSessionUnknown, "session is not joined on this connection"))
			return
		}
		c.handleSessionEnd(p.SessionID)

	default:
		c.TrySend(errorFrame(c.getSessionID(), ErrCodeInvalidPayload, "unknown event: "+env.Event))
	}
}

// handleJoin binds the connection to a session after verifying it exists.
func (c *Client) handleJoin(sessionID string) {
	// A connection is permanently bound after its first successful join. Allowing
	// it to move while an audio goroutine is still running can deliver that old
	// chunk's acknowledgement to a newly joined session with the same sequence.
	if current := c.getSessionID(); current != "" && current != sessionID {
		c.TrySend(errorFrame(sessionID, ErrCodeInvalidPayload, "connection is already joined to another session"))

		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := c.svc.GetSession(ctx, sessionID); err != nil {
		c.TrySend(errorFrame(sessionID, ErrCodeSessionUnknown, "session not found"))
		return
	}

	c.setSessionID(sessionID)
	c.hub.Register(sessionID, c)
}

// handleTranslationCommit runs persistence and TTS without blocking socket reads.
func (c *Client) handleTranslationCommit(payload TranslationCommitPayload) {
	go c.processTranslationCommit(payload)
}

func (c *Client) processTranslationCommit(payload TranslationCommitPayload) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	deliveryFailed := false

	err := c.svc.CommitTranslationStream(ctx, classroom.TranslationCommitInput{
		SessionID:            payload.SessionID,
		TranslationSessionId: payload.TranslationSessionId,
		CommitId:             payload.CommitId,
		CommitNo:             payload.CommitNo,
		CommitKind:           payload.CommitKind,
		SourceText:           payload.SourceText,
		TranslatedText:       payload.TranslatedText,
		SourceElapsedMs:      payload.SourceElapsedMs,
		TargetElapsedMs:      payload.TargetElapsedMs,
		VoiceProfile:         payload.VoiceProfile,
		SpeechSpeed:          payload.SpeechSpeed,
	}, func(event classroom.PipelineEvent) {
		if deliveryFailed {
			return
		}
		frame := frameFromPipelineEvent(event)
		switch event.Type {
		case classroom.PipelineTranslationCommitted, classroom.PipelineTranslationRejected, classroom.PipelineTTSAudio, classroom.PipelineError:
			if !c.SendCritical(frame) {
				deliveryFailed = true
				go c.shutdown()
			}
		}
	})
	if err == nil {
		return
	}

	code, message := translationCommitError(err)
	c.log.Error("translation commit failed", "sessionId", payload.SessionID, "commitId", payload.CommitId, "error", err)
	c.SendCritical(commitErrorFrame(payload.SessionID, payload.CommitId, payload.CommitNo, code, message))
}

func translationCommitError(err error) (string, string) {
	switch {
	case errors.Is(err, classroom.ErrInvalidTranslationCommit):
		return ErrCodeInvalidPayload, "invalid translation commit"
	case errors.Is(err, classroom.ErrSessionNotFound):
		return ErrCodeSessionUnknown, "session not found"
	case errors.Is(err, classroom.ErrSessionNotActive):
		return ErrCodeSessionInactive, "session is not active"
	case errors.Is(err, classroom.ErrCommitConflict):
		return ErrCodeCommitConflict, "translation commit conflicts with existing content"
	default:
		return ErrCodeInternal, "translation commit failed"
	}
}

// handleSessionEnd finalizes the session in a goroutine and broadcasts completion.
func (c *Client) handleSessionEnd(sessionID string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
		defer cancel()

		session, err := c.svc.EndSession(ctx, sessionID)
		if err != nil {
			c.log.Error("session end error", "sessionId", sessionID, "error", err)
			c.hub.Broadcast(sessionID, errorFrame(sessionID, ErrCodeFinalizeFailed, "failed to finalize session"))
			return
		}
		if session.Status != classroom.StatusCompleted {
			return
		}
		readinessCtx, readinessCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer readinessCancel()

		messages, err := c.svc.ListMessages(readinessCtx, sessionID)
		if err != nil {
			c.log.Error("completed session transcript readiness error", "sessionId", sessionID, "error", err)
			c.hub.Broadcast(sessionID, errorFrame(sessionID, ErrCodeInternal, "failed to load completed session readiness"))

			return
		}
		hasTranscript := messagesContainTranscript(messages)
		imageReady, imageStatus, err := c.flashcardImageReadiness(readinessCtx, sessionID)
		if err != nil {
			c.log.Error("completed session flashcard readiness error", "sessionId", sessionID, "error", err)
			c.hub.Broadcast(sessionID, errorFrame(sessionID, ErrCodeInternal, "failed to load completed session readiness"))

			return
		}
		c.hub.Broadcast(sessionID, MustEnvelope(EventSessionCompleted, SessionCompletedPayload{
			SessionID:            sessionID,
			SummaryReady:         hasTranscript,
			VocabularyReady:      hasTranscript,
			FlashcardsReady:      hasTranscript,
			FlashcardImagesReady: imageReady,
			FlashcardImageStatus: imageStatus,
		}))
	}()
}

func messagesContainTranscript(messages []classroom.Message) bool {
	for _, message := range messages {
		if strings.TrimSpace(message.SourceText) != "" {
			return true
		}
	}

	return false
}

func (c *Client) flashcardImageReadiness(ctx context.Context, sessionID string) (bool, string, error) {
	cards, err := c.svc.GetFlashcards(ctx, sessionID)
	if err != nil {
		return false, "", err
	}
	if len(cards) == 0 {
		return true, classroom.FlashcardImageStatusSkipped, nil
	}

	hasPending := false
	hasFailed := false
	hasReady := false
	hasSkipped := false
	for _, card := range cards {
		switch card.ImageStatus {
		case classroom.FlashcardImageStatusPending:
			hasPending = true
		case classroom.FlashcardImageStatusFailed:
			hasFailed = true
		case classroom.FlashcardImageStatusReady:
			hasReady = true
		case classroom.FlashcardImageStatusSkipped:
			hasSkipped = true
		}
	}
	if hasPending {
		return false, classroom.FlashcardImageStatusPending, nil
	}
	if hasFailed {
		return true, classroom.FlashcardImageStatusFailed, nil
	}
	if hasReady {
		return true, classroom.FlashcardImageStatusReady, nil
	}
	if hasSkipped {
		return true, classroom.FlashcardImageStatusSkipped, nil
	}
	return true, classroom.FlashcardImageStatusSkipped, nil
}

// writePump drains the send channel and emits periodic pings.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.shutdown()
	}()

	for {
		select {
		case message, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}

		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// shutdown unregisters the client, closes the send channel once, and closes the socket.
func (c *Client) shutdown() {
	c.closeOnce.Do(func() {
		if sid := c.getSessionID(); sid != "" {
			c.hub.Unregister(sid, c)
		}
		c.mu.Lock()
		c.closed = true
		close(c.send)
		c.mu.Unlock()
		_ = c.conn.Close()
	})
}
