package middleware

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/ai-classroom/backend/internal/response"
)

// Recovery converts panics into a structured 500 JSON response and logs the cause.
func Recovery(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Error("panic recovered",
					"error", rec,
					"path", c.Request.URL.Path,
					"method", c.Request.Method,
				)
				if !c.Writer.Written() {
					response.Error(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
				}
				c.Abort()
			}
		}()
		c.Next()
	}
}
