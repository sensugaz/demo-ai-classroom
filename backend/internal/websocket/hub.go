package websocket

import "sync"

// Hub tracks connected clients indexed by sessionId and fans out broadcasts.
// It is safe for concurrent use across many sessions.
type Hub struct {
	mu sync.RWMutex
	// sessions maps a sessionId to the set of clients joined to it.
	sessions map[string]map[*Client]struct{}
}

// NewHub creates an empty Hub.
func NewHub() *Hub {
	return &Hub{
		sessions: make(map[string]map[*Client]struct{}),
	}
}

// Register adds a client to a session's broadcast set.
func (h *Hub) Register(sessionID string, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.sessions[sessionID]
	if !ok {
		set = make(map[*Client]struct{})
		h.sessions[sessionID] = set
	}
	set[c] = struct{}{}
}

// Unregister removes a client from a session's broadcast set, pruning empty sets.
func (h *Hub) Unregister(sessionID string, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.sessions[sessionID]
	if !ok {
		return
	}
	delete(set, c)
	if len(set) == 0 {
		delete(h.sessions, sessionID)
	}
}

// Broadcast sends message to every client joined to sessionID.
// Slow clients whose send buffer is full are skipped (non-blocking) so one
// stalled connection cannot block the hub or its peers.
func (h *Hub) Broadcast(sessionID string, message []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.sessions[sessionID] {
		c.TrySend(message)
	}
}
