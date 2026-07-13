# Backend Service — AI Classroom (Thai → English)

Go REST + WebSocket service that orchestrates the realtime Thai-to-English classroom
pipeline. The browser sends microphone audio directly to OpenAI Realtime over WebRTC,
then sends stable Thai/English text pairs here for idempotent persistence and Cartesia
text-to-speech. Session finalization produces a bilingual summary, vocabularies, and
flashcards.

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
| `SOURCE_LANGUAGE`         | `th-TH`                     | Fixed source language                         |
| `TARGET_LANGUAGE`         | `en-US`                     | Fixed target language                         |

## REST API

| Method | Path                                            | Description                                  |
| ------ | ----------------------------------------------- | -------------------------------------------- |
| GET    | `/health`                                       | Liveness probe                               |
| POST   | `/api/classroom-sessions`                       | Create a session                             |
| GET    | `/api/classroom-sessions`                       | List sessions                                |
| GET    | `/api/classroom-sessions/:sessionId`            | Get one session                              |
| POST   | `/api/classroom-sessions/:sessionId/realtime-translation/client-secret` | Mint a short-lived browser credential |
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

**Client → server:** `session:join`, `translation:commit`, `session:end`.
**Server → client:** `translation:progress`, `translation:committed`,
`translation:rejected`, `tts:audio`, `session:completed`, `error`.

### Commit pipeline

For each `translation:commit` the service validates the active session and immutable
commit identity, reviews the candidate against the Thai source and server-owned lesson
context, persists canonical English exactly once, then calls `/ai/tts/en`. Review is
fail-closed: failure emits terminal `translation:rejected` with no persistence or TTS.
TTS is **non-fatal** after review: success emits `tts:audio`, failure emits `TTS_FAILED`,
and both paths end with `translation:committed`. End-session processing blocks new
commits and waits for in-flight work before finalization.

The originating connection receives ephemeral `translation:progress` frames with
`{ sessionId, commitId, commitNo, stage }`. Stages are typed as `reviewing`, `persisting`,
and `synthesizing`. A new commit emits them in that monotonic order immediately before
review, before durable persistence, and before TTS respectively. A canonical duplicate
skips review and persistence, so it emits only `synthesizing`. Reconnects may therefore
observe skipped or repeated stages; the browser owns the initial local `queued` state.
Progress uses the best-effort per-client path and is never persisted or broadcast to
other session clients. If a slow connection drops a progress frame, the browser keeps
showing its local `queued` fallback until a later stage or terminal event arrives.

Terminal ordering is stable: success is `synthesizing` → `tts:audio` →
`translation:committed`; TTS failure is `synthesizing` → `TTS_FAILED` →
`translation:committed`; review failure is `reviewing` → `translation:rejected`.
Fatal persistence errors use the correlated `error` frame with the original commit id
and number.

Text persistence is exactly-once. If the connection drops before the ordered TTS/ACK
frames are queued, the same commit retry may synthesize TTS again so the teacher can
recover the missing audio without duplicating the stored transcript.

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
  service.go               SessionService interface + commit/TTS/finalize orchestration
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

The standard `OPENAI_API_KEY` is held only by ai-service. This backend returns only the
short-lived credential and whitelisted translation-session metadata to the browser.

The current Compose topology intentionally runs one backend replica. Add authentication,
per-teacher session ownership, rate limiting, and a distributed commit lease/transaction
before public or horizontally scaled deployment.
