# AI Classroom — Thai to English Live Translator

AI Classroom captures spoken **Thai (th-TH)** in a live classroom, transcribes
it, translates it to **English (en-US)**, speaks the English back, and—after the
session ends—generates a summary, vocabulary list, and flashcards.

The translation direction is **fixed**: Thai → English. There is no language
selector and no multi-language logic anywhere in the system.

---

## Architecture

```
                +-------------------+
                |     frontend      |  Next.js UI (port 3000)
                |  mic capture +    |
                |  live transcript  |
                +---------+---------+
                          |  WebRTC audio + transcript deltas
                          v
                +-------------------+
                | OpenAI Realtime   |
                | Translation       |
                +---------+---------+
                          | committed Thai/English text
                          v
                +-------------------+
                |      backend      |  Go REST + WebSocket (port 3001)
                | session + commit  |
                | persistence       |
                +----+----------+---+
                     |          |
        MongoDB (db) |          |  HTTP
                     v          v
            +-------------+   +-------------------+
            |   mongodb   |   |    ai-service     |  Python FastAPI (internal :8000)
            | (port 27017)|   |  Token/TTS/       |
            +-------------+   |  Finalize         |
                              +---------+---------+
                                        |
                  +---------------------+---------------------+
                  |                     |                     |
                  v                     v                     v
          OpenAI Realtime          LLM via OpenRouter  Cartesia TTS
          (Thai -> English text)   (post-class assets) (English audio)
```

| Service     | Tech                | Port             | Role                                            |
| ----------- | ------------------- | ---------------- | ----------------------------------------------- |
| frontend    | Next.js             | internal 3000    | Mic capture, live transcript/translation UI     |
| backend     | Go (REST + WS)      | host 3001        | Sessions, commit persistence, finalization       |
| ai-service  | Python (FastAPI)    | internal 8000    | Realtime secrets, TTS, session finalization      |
| mongodb     | MongoDB 7           | host 27017       | Persistence (db: `ai_classroom`)                |

External providers used by **ai-service**: OpenAI Realtime Translation,
an LLM via OpenRouter (summary + vocabulary + flashcards), OpenAI Images
(flashcard art), and Cartesia (English TTS).

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose v2
  (`docker compose`, not the legacy `docker-compose`).
- An **OpenAI API key** with Realtime API access.
- A **Cartesia** API key and voice id (for English TTS).
- An **OpenRouter** API key and model id (for summary, vocabulary, and
  flashcards). Get one at https://openrouter.ai/keys.

---

## Setup

### 1. Configure environment variables

Copy the example file and fill in your keys:

```bash
cp .env.example .env
```

Edit `.env` and set:

| Variable            | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `CARTESIA_API_KEY`  | Cartesia API key (English TTS).                          |
| `CARTESIA_VOICE_ID` | Cartesia voice id used for the spoken English output.    |
| `LLM_API_KEY`       | OpenRouter API key (https://openrouter.ai/keys).         |
| `LLM_MODEL`         | OpenRouter model id used for post-class assets.          |
| `LLM_BASE_URL`      | OpenAI-compatible base URL. Defaults to OpenRouter.      |
| `OPENAI_API_KEY`    | Required server-only key for Realtime and flashcard art. |
| `FLASHCARD_IMAGE_MAX_PER_SESSION` | Optional: cap generated flashcard images per finalized session. |

### 2. Run the stack

```bash
docker compose up --build
```

Or use the Makefile:

```bash
make up       # docker compose up --build
make logs     # tail logs from all services
make ps       # show service status
make down     # stop containers (keeps data)
make clean    # stop + remove volumes (wipes MongoDB data + audio/image caches)
```

---

## Service URLs

| Service    | URL                                             | Health                       |
| ---------- | ----------------------------------------------- | ---------------------------- |
| frontend   | http://localhost via nginx                      | —                            |
| backend    | http://localhost:3001                           | http://localhost:3001/health |
| ai-service | internal only: `http://ai-service:8000`         | internal `/health`           |
| mongodb    | mongodb://localhost:27017                       | —                            |

---

## How it works (Thai → English flow)

1. **Create session.** The UI calls `POST /api/classroom-sessions` with a
   classroom name and speaker name. The backend persists the session
   (`status: active`) and returns a `sessionId`. Languages are fixed:
   `sourceLanguage: th-TH`, `targetLanguage: en-US`.
2. **Open Realtime translation.** The backend validates the active classroom
   and obtains a short-lived client secret from ai-service. The standard
   `OPENAI_API_KEY` never reaches the browser.
3. **Stream and commit text.** The browser sends microphone audio to
   `gpt-realtime-translate` over WebRTC. Thai source and translated English
   transcript deltas appear immediately. Stable phrase pairs are committed to
   the backend with an idempotency key, persisted in MongoDB, and sent to
   Cartesia for the selected voice and speed. TTS failure remains non-fatal.
4. **End session.** The browser sends `session.close`, waits for
   `session.closed`, commits the final text, then calls `POST .../end`. The
   status moves to
   `processing`, the backend gathers all messages and calls
   `POST /ai/classroom/finalize` (LLM). The resulting summary, vocabularies,
   and flashcards are persisted, the status becomes `completed`, and
   `session:completed` is emitted.

Realtime transcript deltas are append-only. The browser preserves them exactly
and the backend only stores stable phrase commits.

---

## Backend REST API

Base URL: `http://localhost:3001`

| Method | Path                                            | Description                                           |
| ------ | ----------------------------------------------- | ----------------------------------------------------- |
| GET    | `/health`                                       | Health check: `{"status":"ok","service":"backend"}`   |
| POST   | `/api/classroom-sessions`                       | Create session `{classroomName, speakerName}`         |
| GET    | `/api/classroom-sessions`                       | List sessions                                         |
| GET    | `/api/classroom-sessions/:sessionId`            | Get one session                                       |
| POST   | `/api/classroom-sessions/:sessionId/realtime-translation/client-secret` | Create a short-lived OpenAI Realtime client secret |
| POST   | `/api/classroom-sessions/:sessionId/end`        | End session (processing → completed)                  |
| GET    | `/api/classroom-sessions/:sessionId/messages`   | Messages ordered by `sequenceNo`                      |
| GET    | `/api/classroom-sessions/:sessionId/summary`    | Session summary                                       |
| GET    | `/api/classroom-sessions/:sessionId/vocabularies` | Vocabularies                                        |
| GET    | `/api/classroom-sessions/:sessionId/flashcards` | Flashcards                                            |
| GET    | `/ws`                                            | WebSocket upgrade                                     |

### Create session response

```json
{
  "sessionId": "...",
  "sourceLanguage": "th-TH",
  "targetLanguage": "en-US",
  "status": "active"
}
```

The Realtime client-secret response contains only `clientSecret`, `expiresAt`,
`translationSessionId`, `lastCommitNo`, `model`, and `targetLanguage`. The
browser continues from `lastCommitNo` after a reconnect or reload; the standard
OpenAI API key is never returned.

---

## WebSocket events

URL: `ws://localhost:3001/ws` — envelope: `{ "event": "<name>", "payload": { ... } }`

**Client → Backend**

| Event                | Payload                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `session:join`       | `{ sessionId }`                                                                                           |
| `translation:commit` | `{ sessionId, translationSessionId, commitId, commitNo, commitKind, sourceText, translatedText, sourceElapsedMs, targetElapsedMs, voiceProfile, speechSpeed }` |
| `session:end`        | `{ sessionId }`                                                                                           |

**Backend → Client**

| Event                    | Payload                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `translation:committed`  | `{ sessionId, commitId, commitNo, commitKind, sequenceNo, duplicate }`                   |
| `tts:audio`              | `{ sessionId, commitId, commitNo, sequenceNo, text, language: "en-US", audioUrl: "", audioBase64: "..." }` |
| `session:completed`   | `{ sessionId, summaryReady: true, vocabularyReady: true, flashcardsReady: true, flashcardImagesReady, flashcardImageStatus }` |
| `error`               | `{ sessionId, code, message }`                                                           |

---

## AI-service HTTP API

Base URL (internal): `http://ai-service:8000` — called by the backend.

| Method | Path                                      | Request                                                     | Response                                                                 |
| ------ | ----------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/health`                                 | —                                                           | `{"status":"ok","service":"ai-service"}`                           |
| POST   | `/ai/realtime-translation/client-secret` | `{ sessionId }`                                             | `{ clientSecret, expiresAt, translationSessionId, model, targetLanguage }` |
| POST   | `/ai/tts/en`                              | `{ sessionId, text, voiceId, speed }`                       | `{ audioUrl: "", audioBase64, language: "en-US", durationMs }`         |
| POST   | `/ai/classroom/finalize`   | `{ sessionId, messages: [{ sourceText, translatedText }] }`   | `{ summary, vocabularies[], flashcards[] }` (see below)                  |
| POST   | `/ai/classroom/flashcard-images` | `{ sessionId, flashcards[], vocabularies[] }`           | `{ flashcards[], imageStatus, attemptedCount, readyCount, skippedCount, failedCount }` |

### Finalize response shape

```json
{
  "summary": {
    "summaryTh": "...",
    "summaryEn": "...",
    "keyPointsTh": [],
    "keyPointsEn": []
  },
  "vocabularies": [
    {
      "word": "...",
      "pronunciation": "...",
      "partOfSpeech": "...",
      "meaningTh": "...",
      "meaningEn": "...",
      "exampleSentenceEn": "...",
      "exampleSentenceTh": "...",
      "difficultyLevel": "..."
    }
  ],
  "flashcards": [
    {
      "front": "...",
      "back": "...",
      "type": "vocabulary|sentence|grammar",
      "word": "...",
      "hintTh": "...",
      "exampleSentence": "..."
    }
  ]
}
```

---

## MongoDB collections

Database: `ai_classroom`

| Collection               | Key fields                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `classroom_sessions`     | `sessionId, classroomName, speakerName, sourceLanguage, targetLanguage, status, startedAt, endedAt, createdAt, updatedAt`                        |
| `classroom_messages`     | `sessionId, translationSessionId, commitId, commitNo, commitKind, sequenceNo, sourceText, translatedText, sourceLanguage, targetLanguage, voiceProfile, speechSpeed, isFinal, sourceElapsedMs, targetElapsedMs, createdAt` |
| `classroom_summaries`    | `sessionId, summaryTh, summaryEn, keyPointsTh[], keyPointsEn[], createdAt`                                                                       |
| `classroom_vocabularies` | `sessionId, word, pronunciation, partOfSpeech, meaningTh, meaningEn, exampleSentenceEn, exampleSentenceTh, difficultyLevel, createdAt`           |
| `classroom_flashcards`   | `sessionId, front, back, type, word, hintTh, exampleSentence, createdAt`                                                                         |

`status` values: `active` → `processing` → `completed` (or `failed`).

## Deployment Boundary

The current Compose deployment is a trusted, single-teacher demo and runs one
backend replica. Before exposing it to multiple schools or the public internet,
add teacher authentication/session ownership, rate limits on client-secret and
commit endpoints, and a distributed commit lease or transaction before scaling
the backend horizontally.

---

## Troubleshooting

- **Microphone permission denied.** The browser must grant mic access on
  `http://localhost:3000`. If you blocked it, re-enable mic permission in the
  browser site settings and reload. Some browsers only allow `getUserMedia`
  on `localhost` or HTTPS.
- **No spoken English / TTS errors.** TTS is **non-fatal**. If Cartesia fails,
  you will receive an `error` event with code `TTS_FAILED`, but the
  translated text remains persisted. Verify
  `CARTESIA_API_KEY` and `CARTESIA_VOICE_ID` in `.env`.
- **Realtime translation does not start.** Verify the server-only
  `OPENAI_API_KEY`, Realtime API access, and browser microphone permission.
  The browser must receive only the temporary secret returned by the backend;
  never expose the standard key through `NEXT_PUBLIC_*` variables.
- **Realtime connects but no text appears.** Inspect the WebRTC data channel
  and SDP exchange for errors. Thai source text arrives in
  `session.input_transcript.delta`; translated English arrives in
  `session.output_transcript.delta`.
- **Translation / finalize fails.** Check `LLM_API_KEY` (OpenRouter key) and
  `LLM_MODEL` (valid OpenRouter model id). `LLM_BASE_URL` defaults to OpenRouter;
  override it only to use a different OpenAI-compatible gateway.
- **Services won't start in order.** Compose waits for healthchecks:
  `mongodb` and `ai-service` must be healthy before `backend`, and `backend`
  before `frontend`. Watch `make logs` for health status.
- **Mongo connection refused.** The backend connects to
  `mongodb://mongodb:27017` over the internal `ai-classroom-network`. Ensure
  the `mongodb` container is healthy (`make ps`).
