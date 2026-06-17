// Package uuid wraps google/uuid to provide a stable, minimal API surface.
package uuid

import "github.com/google/uuid"

// New returns a random (v4) UUID as a string.
func New() string {
	return uuid.NewString()
}
