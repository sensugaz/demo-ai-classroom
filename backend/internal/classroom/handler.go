package classroom

import (
	"errors"
	"net/http"
	"regexp"

	"github.com/gin-gonic/gin"

	"github.com/ai-classroom/backend/internal/response"
	appvalidator "github.com/ai-classroom/backend/pkg/validator"
)

var flashcardImageFilenamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*\.(webp|png|jpg|jpeg)$`)

// Handler exposes the classroom REST API over a SessionService.
type Handler struct {
	svc SessionService
}

// NewHandler constructs a Handler.
func NewHandler(svc SessionService) *Handler {
	return &Handler{svc: svc}
}

// RegisterRoutes mounts the classroom routes onto the router and the /health probe.
func (h *Handler) RegisterRoutes(r *gin.Engine) {
	r.GET("/health", h.Health)

	api := r.Group("/api/classroom-sessions")
	{
		api.POST("", h.CreateSession)
		api.GET("", h.ListSessions)
		api.GET("/:sessionId", h.GetSession)
		api.POST("/:sessionId/end", h.EndSession)
		api.POST("/:sessionId/reset", h.ResetSession)
		api.GET("/:sessionId/messages", h.ListMessages)
		api.GET("/:sessionId/summary", h.GetSummary)
		api.GET("/:sessionId/vocabularies", h.GetVocabularies)
		api.GET("/:sessionId/flashcards", h.GetFlashcards)
		api.GET("/:sessionId/flashcard-images/:filename", h.GetFlashcardImage)
	}
}

// Health is the liveness probe. It intentionally returns the bare contract shape.
func (h *Handler) Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "backend"})
}

// CreateSession creates a new classroom session.
func (h *Handler) CreateSession(c *gin.Context) {
	var req CreateSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "INVALID_BODY", "request body must be valid JSON")
		return
	}
	if err := appvalidator.Validate(req); err != nil {
		response.Error(c, http.StatusBadRequest, "VALIDATION_FAILED", err.Error())
		return
	}

	session, err := h.svc.CreateSession(c.Request.Context(), req)
	if err != nil {
		response.Error(c, http.StatusInternalServerError, "CREATE_FAILED", "failed to create session")
		return
	}
	response.Created(c, NewCreateSessionResponse(session))
}

// ListSessions returns all sessions.
func (h *Handler) ListSessions(c *gin.Context) {
	sessions, err := h.svc.ListSessions(c.Request.Context())
	if err != nil {
		response.Error(c, http.StatusInternalServerError, "LIST_FAILED", "failed to list sessions")
		return
	}
	response.Success(c, sessions)
}

// GetSession returns one session by id.
func (h *Handler) GetSession(c *gin.Context) {
	sessionID := c.Param("sessionId")
	session, err := h.svc.GetSession(c.Request.Context(), sessionID)
	if h.writeLookupError(c, err) {
		return
	}
	response.Success(c, session)
}

// EndSession finalizes a session. It is idempotent for already-completed sessions.
func (h *Handler) EndSession(c *gin.Context) {
	sessionID := c.Param("sessionId")
	session, err := h.svc.EndSession(c.Request.Context(), sessionID)
	if errors.Is(err, ErrSessionNotFound) {
		response.Error(c, http.StatusNotFound, "SESSION_NOT_FOUND", "session not found")
		return
	}
	if err != nil {
		response.Error(c, http.StatusBadGateway, "FINALIZE_FAILED", "failed to finalize session")
		return
	}
	response.Success(c, session)
}

// ResetSession discards a session's recorded messages + glossary so the teacher
// can re-record without ending the class. Valid only while the session is active.
func (h *Handler) ResetSession(c *gin.Context) {
	sessionID := c.Param("sessionId")
	err := h.svc.ResetSession(c.Request.Context(), sessionID)
	if errors.Is(err, ErrSessionNotFound) {
		response.Error(c, http.StatusNotFound, "SESSION_NOT_FOUND", "session not found")
		return
	}
	if errors.Is(err, ErrSessionNotActive) {
		response.Error(c, http.StatusConflict, "SESSION_NOT_ACTIVE", "session is not active")
		return
	}
	if err != nil {
		response.Error(c, http.StatusInternalServerError, "RESET_FAILED", "failed to reset session")
		return
	}
	response.Success(c, gin.H{"sessionId": sessionID, "status": "reset"})
}

// ListMessages returns a session's messages ordered by sequenceNo.
func (h *Handler) ListMessages(c *gin.Context) {
	sessionID := c.Param("sessionId")
	messages, err := h.svc.ListMessages(c.Request.Context(), sessionID)
	if h.writeLookupError(c, err) {
		return
	}
	response.Success(c, messages)
}

// GetSummary returns a session's summary.
func (h *Handler) GetSummary(c *gin.Context) {
	sessionID := c.Param("sessionId")
	summary, err := h.svc.GetSummary(c.Request.Context(), sessionID)
	if h.writeLookupError(c, err) {
		return
	}
	// A session may exist without a summary yet (not finalized): return null data.
	response.Success(c, summary)
}

// GetVocabularies returns a session's vocabularies.
func (h *Handler) GetVocabularies(c *gin.Context) {
	sessionID := c.Param("sessionId")
	vocab, err := h.svc.GetVocabularies(c.Request.Context(), sessionID)
	if h.writeLookupError(c, err) {
		return
	}
	response.Success(c, vocab)
}

// GetFlashcards returns a session's flashcards.
func (h *Handler) GetFlashcards(c *gin.Context) {
	sessionID := c.Param("sessionId")
	cards, err := h.svc.GetFlashcards(c.Request.Context(), sessionID)
	if h.writeLookupError(c, err) {
		return
	}
	response.Success(c, cards)
}

// GetFlashcardImage proxies a cached generated flashcard image from ai-service.
func (h *Handler) GetFlashcardImage(c *gin.Context) {
	sessionID := c.Param("sessionId")
	filename := c.Param("filename")
	if !flashcardImageFilenamePattern.MatchString(filename) {
		response.Error(c, http.StatusBadRequest, "INVALID_IMAGE_NAME", "invalid flashcard image name")
		return
	}
	asset, err := h.svc.GetFlashcardImage(c.Request.Context(), sessionID, filename)
	if h.writeLookupError(c, err) {
		return
	}

	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	c.Data(http.StatusOK, asset.ContentType, asset.Body)
}

// writeLookupError maps repository lookup errors to HTTP responses.
// It returns true when a response was written (caller should stop).
func (h *Handler) writeLookupError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrSessionNotFound) {
		response.Error(c, http.StatusNotFound, "SESSION_NOT_FOUND", "session not found")
		return true
	}
	if errors.Is(err, ErrFlashcardImageNotFound) {
		response.Error(c, http.StatusNotFound, "IMAGE_NOT_FOUND", "flashcard image not found")
		return true
	}
	response.Error(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	return true
}
