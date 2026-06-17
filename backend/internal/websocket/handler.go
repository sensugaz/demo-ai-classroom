package websocket

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/ai-classroom/backend/internal/classroom"
)

// Handler upgrades HTTP requests to WebSocket connections and wires them to the Hub/Service.
type Handler struct {
	hub      *Hub
	svc      classroom.SessionService
	log      *slog.Logger
	maxAudio int64
	upgrader websocket.Upgrader
}

// NewHandler builds a WebSocket handler. allowedOrigin is matched against the
// request Origin header (the configured FRONTEND_URL).
func NewHandler(hub *Hub, svc classroom.SessionService, log *slog.Logger, allowedOrigin string, maxAudioBytes int64) *Handler {
	return &Handler{
		hub:      hub,
		svc:      svc,
		log:      log,
		maxAudio: maxAudioBytes,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin: func(r *http.Request) bool {
				origin := r.Header.Get("Origin")
				// Allow same-origin / non-browser clients that omit Origin.
				if origin == "" {
					return true
				}
				return origin == allowedOrigin
			},
		},
	}
}

// Upgrade is the Gin handler for GET /ws.
func (h *Handler) Upgrade(c *gin.Context) {
	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		// Upgrade writes its own HTTP error response on failure.
		h.log.Warn("ws upgrade failed", "error", err)
		return
	}

	client := NewClient(conn, h.hub, h.svc, h.log, h.maxAudio)
	client.Run()
}
