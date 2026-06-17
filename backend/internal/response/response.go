// Package response provides consistent JSON envelopes for HTTP handlers.
package response

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// Envelope is the standard success wrapper returned by the API.
type Envelope struct {
	Success bool `json:"success"`
	Data    any  `json:"data,omitempty"`
}

// ErrorBody describes an error payload.
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ErrorEnvelope is the standard error wrapper returned by the API.
type ErrorEnvelope struct {
	Success bool      `json:"success"`
	Error   ErrorBody `json:"error"`
}

// Success writes a 200 response wrapping data.
func Success(c *gin.Context, data any) {
	c.JSON(http.StatusOK, Envelope{Success: true, Data: data})
}

// Created writes a 201 response wrapping data.
func Created(c *gin.Context, data any) {
	c.JSON(http.StatusCreated, Envelope{Success: true, Data: data})
}

// Error writes an error response with the given HTTP status, error code, and message.
func Error(c *gin.Context, status int, code, message string) {
	c.JSON(status, ErrorEnvelope{
		Success: false,
		Error:   ErrorBody{Code: code, Message: message},
	})
}
