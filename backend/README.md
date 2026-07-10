# Backend Service — AI Classroom (Thai → English)

Go REST + WebSocket service that orchestrates the realtime Thai-to-English classroom
pipeline. It accepts segmented audio over WebSocket, calls the Python `ai-service` for
speech-to-text, translation, and text-to-speech, persists everything to MongoDB, and on
session end produces a bilingual summary, vocabularies, and flashcards.

- REST + WebSocket on port **3001**
- Fixed language contract: `th-TH` → `en-US` (no language switching)

## Run

The service is designed to run as part of the full stack:

```bash
docker compose up --build
```

Run only this service locally:

```bash
go run ./cmd/api
```

Build the container image directly:

```bash
docker build -t ai-classroom-backend .
docker run -p 3001:3001 --env-file .env ai-classroom-backend
```

Liveness check:

```bash
curl http://localhost:3001/health
# {"status":"ok","service":"backend"}
```

## Environment

| Variable                  | Default                     | Description                                   |
| ------------------------- | --------------------------- | --------------------------------------------- |
| `APP_PORT`                | `3001`                      | HTTP/WebSocket listen port                    |
| `APP_ENV`                 | `local`                     | `local` enables debug mode; otherwise release |
| `MONGODB_URI`             | `mongodb://mongodb:27017`   | MongoDB connection string                     |
| `MONGODB_DATABASE`        | `ai_classroom`              | Database name                                 |
| `AI_SERVICE_URL`          | `http://ai-service:8000`    | Base URL of the Python ai-service             |
| `FRONTEND_URL`            | `http://localhost:3000`     | Allowed CORS / WebSocket origin               |
| `MAX_AUDIO_CHUNK_SIZE_MB` | `5`                         | Per-chunk audio size cap (megabytes)          |
| `SOURCE_LANGUAGE`         | `th-TH`                     | Fixed source language                         |
| `TARGET_LANGUAGE`         | `en-US`                     | Fixed target language                         |

## REST API

| Method | Path                                            | Description                                  |
| ------ | ----------------------------------------------- | -------------------------------------------- |
| GET    | `/health`                                       | Liveness probe                               |
| POST   | `/api/classroom-sessions`                       | Create a session                             |
| GET    | `/api/classroom-sessions`                       | List sessions                                |
| GET    | `/api/classroom-sessions/:sessionId`            | Get one session                              |
| POST   | `/api/classroom-sessions/:sessionId/end`        | Finalize a session (idempotent)              |
| GET    | `/api/classroom-sessions/:sessionId/messages`   | Messages ordered by `sequenceNo`             |
| GET    | `/api/classroom-sessions/:sessionId/summary`    | Bilingual summary                            |
| PUT    | `/api/classroom-sessions/:sessionId/summary`    | Save teacher-reviewed summary edits          |
| GET    | `/api/classroom-sessions/:sessionId/vocabularies` | Extracted vocabularies                     |
| GET    | `/api/classroom-sessions/:sessionId/flashcards` | Generated flashcards                         |
| GET    | `/ws`                                           | WebSocket upgrade                            |

REST responses use a consistent envelope: `{ "success": true, "data": ... }` for success
and `{ "success": false, "error": { "code", "message" } }` for errors.

## WebSocket protocol

Every frame is `{ "event": "<name>", "payload": { ... } }`.

**Client → server:** `session:join`, `audio:chunk`, `session:end`.
**Server → client:** `transcript:partial`, `transcript:final`, `translation:result`,
`tts:audio`, `session:completed`, `error`.

### Per-chunk pipeline

For each `audio:chunk` the service: validates the session and audio size → STT (`/ai/stt/th`)
→ emits `transcript:final` and persists the source message → translate (`/ai/translate/th-to-en`)
→ emits `translation:result` and persists the translation → TTS (`/ai/tts/en`, **non-fatal**)
→ emits `tts:audio`. A TTS failure emits an `error` frame with code `TTS_FAILED` but the
translation has already been delivered and persisted.

## Architecture

Clean, layered, dependency-inverted via interfaces:

```
cmd/api/main.go            wiring + graceful shutdown
internal/config            typed env configuration
internal/database          MongoDB connect + index management
internal/classroom         domain core
  model.go                 entities + status/language constants
  dto.go                   request/response shapes
  repository.go            Repository interface + MongoRepository
  service.go               SessionService interface + orchestration (STT→translate→TTS, finalize)
  handler.go               Gin REST handlers
internal/ai_client         AIClient interface + HTTP gateway to ai-service
internal/websocket         Hub, Client (read/write pumps), upgrade handler, event protocol
internal/middleware        CORS, structured logger, panic recovery
internal/response          JSON envelope helpers
pkg/uuid                   UUID wrapper
pkg/validator              validator singleton
```

The transport layers depend on `SessionService`; the service depends on `Repository` and
`AIClient`. All three are interfaces, so each layer is independently swappable and testable.

## Notes / future enhancements

- Interim partial transcription (`transcript:partial`) is part of the wire contract but the
  backend currently emits `transcript:final` per self-contained chunk. Streaming interim
  results is a clearly-scoped future enhancement (see `service.go`), not a stub of core logic.
