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
After canonical review and durable persistence, `translation:committed` is queued on the
critical delivery path before synthesis starts. The acknowledgement means the transcript
is recoverably stored; it does not mean audio is ready. TTS is **non-fatal** after that
acknowledgement: success emits exactly one `tts:audio`, while failure emits exactly one
correlated `TTS_FAILED`. End-session and reset processing block new commits and wait for
in-flight TTS before finalization or deletion.

The originating connection receives ephemeral `translation:progress` frames with
`{ sessionId, commitId, commitNo, stage }`. Stages are typed as `reviewing`, `persisting`,
and `synthesizing`. A new commit emits them in that monotonic order immediately before
review, before durable persistence, and before TTS respectively. A canonical duplicate
skips review and persistence, so its observable order starts with `translation:committed`
and then `synthesizing`. Reconnects may therefore observe skipped or repeated stages; the
browser owns the initial local `queued` state.
Progress uses the best-effort per-client path and is never persisted or broadcast to
other session clients. If a slow connection drops a progress frame, the browser keeps
showing its local `queued` fallback until a later stage or terminal event arrives.

Event ordering is stable. A new success is `reviewing` → `persisting` →
`translation:committed` → `synthesizing` → `tts:audio`; a new TTS failure has the same
prefix and ends in `TTS_FAILED`. A duplicate success or failure starts with
`translation:committed`, then `synthesizing`, then its single TTS terminal event. Review
failure remains `reviewing` → `translation:rejected`. Fatal persistence errors use the
correlated `error` frame with the original commit id and number.

Text persistence is exactly-once. Concurrent duplicate or reconnect calls that reach TTS
while the same process-local `{sessionId, commitId}` flight is active share its terminal
result. Each flight has its own bounded lifetime, so one disconnected browser waiter does
not cancel synthesis for reconnecting waiters; Reset and End Class still wait for that
flight to finish. The flight is removed when it completes, so a later retry synthesizes
at least once again and can recover missing audio without duplicating the stored transcript.

Every accepted commit writes one content-safe latency record with commit identity plus
`queueMs`, `reviewMs`, `persistMs`, `canonicalMs`, `ttsMs`, and `totalMs`. Source text,
translated text, provider error bodies, and credentials are not included.

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

The current Compose topology intentionally runs one backend replica. Commit draining,
translation-session generation state, and TTS singleflight are process-local constraints;
multiple backend replicas would not share them. Add authentication, per-teacher session
ownership, rate limiting, and distributed commit/drain/singleflight coordination before
public or horizontally scaled deployment.
