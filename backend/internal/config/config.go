// Package config loads runtime configuration from environment variables.
package config

import (
	"os"
	"strings"
)

// Config holds all runtime configuration for the backend service.
type Config struct {
	AppPort string
	AppEnv  string
	IsLocal bool

	MongoURI      string
	MongoDatabase string

	AIServiceURL string
	FrontendURL  string

	SourceLanguage string
	TargetLanguage string
}

// Load reads configuration from the environment, applying production-safe defaults.
func Load() *Config {
	cfg := &Config{
		AppPort:        getEnv("APP_PORT", "3001"),
		AppEnv:         getEnv("APP_ENV", "local"),
		MongoURI:       getEnv("MONGODB_URI", "mongodb://mongodb:27017"),
		MongoDatabase:  getEnv("MONGODB_DATABASE", "ai_classroom"),
		AIServiceURL:   strings.TrimRight(getEnv("AI_SERVICE_URL", "http://ai-service:8000"), "/"),
		FrontendURL:    getEnv("FRONTEND_URL", "http://localhost:3000"),
		SourceLanguage: getEnv("SOURCE_LANGUAGE", "th-TH"),
		TargetLanguage: getEnv("TARGET_LANGUAGE", "en-US"),
	}
	cfg.IsLocal = strings.EqualFold(cfg.AppEnv, "local")
	return cfg
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
