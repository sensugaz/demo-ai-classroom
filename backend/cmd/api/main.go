// Command api is the entrypoint for the AI Classroom backend service.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/ai-classroom/backend/internal/ai_client"
	"github.com/ai-classroom/backend/internal/classroom"
	"github.com/ai-classroom/backend/internal/config"
	"github.com/ai-classroom/backend/internal/database"
	"github.com/ai-classroom/backend/internal/middleware"
	ws "github.com/ai-classroom/backend/internal/websocket"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg := config.Load()

	rootCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// --- Persistence ---
	connectCtx, cancelConnect := context.WithTimeout(rootCtx, 15*time.Second)
	client, db, err := database.Connect(connectCtx, cfg.MongoURI, cfg.MongoDatabase)
	cancelConnect()
	if err != nil {
		logger.Error("mongo connect failed", "error", err)
		os.Exit(1)
	}
	defer func() {
		disconnectCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if derr := client.Disconnect(disconnectCtx); derr != nil {
			logger.Error("mongo disconnect failed", "error", derr)
		}
	}()

	if err := database.EnsureIndexes(rootCtx, db); err != nil {
		logger.Error("ensure indexes failed", "error", err)
		os.Exit(1)
	}

	// --- Dependency wiring: repo -> service -> ai_client -> handlers ---
	repo := classroom.NewMongoRepository(db)
	aiClient := ai_client.NewClient(cfg.AIServiceURL)
	service := classroom.NewService(repo, aiClient, logger)

	restHandler := classroom.NewHandler(service)
	hub := ws.NewHub()
	wsHandler := ws.NewHandler(hub, service, logger, cfg.FrontendURL)

	// --- HTTP router ---
	if cfg.IsLocal {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	router := gin.New()
	router.Use(middleware.Recovery(logger))
	router.Use(middleware.Logger(logger))
	router.Use(middleware.CORS(cfg.FrontendURL))

	restHandler.RegisterRoutes(router)
	router.GET("/ws", wsHandler.Upgrade)

	srv := &http.Server{
		Addr:              ":" + cfg.AppPort,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// --- Serve with graceful shutdown ---
	serverErr := make(chan error, 1)
	go func() {
		logger.Info("backend listening", "port", cfg.AppPort, "env", cfg.AppEnv)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case err := <-serverErr:
		logger.Error("server error", "error", err)
		os.Exit(1)
	case <-rootCtx.Done():
		logger.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
	}
	logger.Info("backend stopped")
}
