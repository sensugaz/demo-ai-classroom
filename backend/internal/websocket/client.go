package websocket

import (
	"context"
	"encoding/json"
	"log/slog"
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
)

// Client is a single WebSocket connection bound (after session:join) to one session.
type Client struct {
	conn     *websocket.Conn
	send     chan []byte
	hub      *Hub
	svc      classroom.SessionService
	log      *slog.Logger
	maxAudio int64

	mu        sync.Mutex
	sessionID string
	closed    bool
	closeOnce sync.Once
}

// NewClient wires a Client around an upgraded connection.
func NewClient(conn *websocket.Conn, hub *Hub, svc classroom.SessionService, log *slog.Logger, maxAudioBytes int64) *Client {
	return &Client{
		conn:     conn,
		send:     make(chan []byte, sendBuffer),
		hub:      hub,
		svc:      svc,
		log:      log,
		maxAudio: maxAudioBytes,
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

// readPump reads frames, enforces the audio size limit, and dispatches events.
func (c *Client) readPump() {
	defer c.shutdown()

	c.conn.SetReadLimit(c.maxReadLimit())
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

// maxReadLimit derives the socket read limit from the audio cap with headroom for base64
// inflation (~4/3) plus JSON framing overhead.
func (c *Client) maxReadLimit() int64 {
	if c.maxAudio <= 0 {
		return 8 << 20
	}
	return c.maxAudio*2 + (1 << 20)
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

	case EventAudioChunk:
		var p AudioChunkPayload
		if err := json.Unmarshal(env.Payload, &p); err != nil || p.SessionID == "" {
			c.TrySend(errorFrame(c.getSessionID(), ErrCodeInvalidPayload, "invalid audio:chunk payload"))
			return
		}
		c.handleAudioChunk(p)

	case EventSessionEnd:
		var p SessionEndPayload
		if err := json.Unmarshal(env.Payload, &p); err != nil || p.SessionID == "" {
			c.TrySend(errorFrame(c.getSessionID(), ErrCodeInvalidPayload, "invalid session:end payload"))
			return
		}
		c.handleSessionEnd(p.SessionID)

	default:
		c.TrySend(errorFrame(c.getSessionID(), ErrCodeInvalidPayload, "unknown event: "+env.Event))
	}
}

// handleJoin binds the connection to a session after verifying it exists.
func (c *Client) handleJoin(sessionID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := c.svc.GetSession(ctx, sessionID); err != nil {
		c.TrySend(errorFrame(sessionID, ErrCodeSessionUnknown, "session not found"))
		return
	}

	// Re-key in the hub if joining a different session on the same connection.
	if prev := c.getSessionID(); prev != "" && prev != sessionID {
		c.hub.Unregister(prev, c)
	}
	c.setSessionID(sessionID)
	c.hub.Register(sessionID, c)
}

// handleAudioChunk validates size and runs the pipeline in a goroutine so reads stay responsive.
func (c *Client) handleAudioChunk(p AudioChunkPayload) {
	if c.maxAudio > 0 && int64(len(p.Audio)) > c.maxReadLimit() {
		c.TrySend(errorFrame(p.SessionID, ErrCodeAudioTooLarge, "audio chunk exceeds size limit"))
		return
	}

	mime := p.MimeType
	if mime == "" {
		mime = "audio/webm"
	}

	go func(payload AudioChunkPayload, mimeType string) {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()

		events, err := c.svc.HandleAudioChunk(ctx, payload.SessionID, payload.Audio, mimeType, payload.SequenceNo)
		if err != nil {
			c.log.Error("audio pipeline error", "sessionId", payload.SessionID, "seq", payload.SequenceNo, "error", err)
			c.hub.Broadcast(payload.SessionID, errorFrame(payload.SessionID, ErrCodeInternal, "audio processing failed"))
			return
		}
		for _, ev := range events {
			c.hub.Broadcast(payload.SessionID, frameFromPipelineEvent(ev))
		}
	}(p, mime)
}

// handleSessionEnd finalizes the session in a goroutine and broadcasts completion.
func (c *Client) handleSessionEnd(sessionID string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
		defer cancel()

		if _, err := c.svc.EndSession(ctx, sessionID); err != nil {
			c.log.Error("session end error", "sessionId", sessionID, "error", err)
			c.hub.Broadcast(sessionID, errorFrame(sessionID, ErrCodeFinalizeFailed, "failed to finalize session"))
			return
		}
		c.hub.Broadcast(sessionID, MustEnvelope(EventSessionCompleted, SessionCompletedPayload{
			SessionID:       sessionID,
			SummaryReady:    true,
			VocabularyReady: true,
			FlashcardsReady: true,
		}))
	}()
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
