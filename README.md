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
                          |  REST (http) + WebSocket (ws)
                          v
                +-------------------+
                |      backend      |  Go REST + WebSocket (port 3001)
                |  session + ws hub |
                |  pipeline orchestr |
                +----+----------+---+
                     |          |
        MongoDB (db) |          |  HTTP
                     v          v
            +-------------+   +-------------------+
            |   mongodb   |   |    ai-service     |  Python FastAPI (internal :8000)
            | (port 27017)|   |  STT/Translate/   |
            +-------------+   |  TTS/Finalize     |
                              +---------+---------+
                                        |
                  +---------------------+---------------------+
                  |                     |                     |
                  v                     v                     v
          Google Speech-to-Text     LLM via OpenRouter  Cartesia TTS
            (Thai STT, th-TH)        (Chat Completions)  (English audio,
                                                          en-US)
```

| Service     | Tech                | Port             | Role                                            |
| ----------- | ------------------- | ---------------- | ----------------------------------------------- |
| frontend    | Next.js             | internal 3000    | Mic capture, live transcript/translation UI     |
| backend     | Go (REST + WS)      | host 3001        | Sessions, WebSocket hub, pipeline orchestration |
| ai-service  | Python (FastAPI)    | internal 8000    | STT, translation, TTS, session finalization     |
| mongodb     | MongoDB 7           | host 27017       | Persistence (db: `ai_classroom`)                |

External providers used by **ai-service**: Google Speech-to-Text (Thai STT),
an LLM via OpenRouter (translation + summary + vocabulary + flashcards),
OpenAI Images (optional flashcard art), and Cartesia (English TTS).

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose v2
  (`docker compose`, not the legacy `docker-compose`).
- A **Google Cloud service account** JSON with Speech-to-Text enabled.
- A **Cartesia** API key and voice id (for English TTS).
- An **OpenRouter** API key and model id (for translation, summary,
  vocabulary, and flashcards). Get one at https://openrouter.ai/keys.

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
| `LLM_MODEL`         | OpenRouter model id (e.g. `openai/gpt-4o-mini`).         |
| `LLM_BASE_URL`      | OpenAI-compatible base URL. Defaults to OpenRouter.      |
| `OPENAI_API_KEY`    | Optional: OpenAI Images key for generated flashcard art. |
| `FLASHCARD_IMAGE_MAX_PER_SESSION` | Optional: cap generated flashcard images per finalized session. |

### 2. Place Google credentials

Download your Google service account key and save it as:

```
credentials/google-service-account.json
```

This file is git-ignored. See [`credentials/README.md`](./credentials/README.md)
for step-by-step instructions on obtaining it.

### 3. Run the stack

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
2. **Open the stream.** The client opens the `/ws` WebSocket, sends
   `session:join`, then streams `audio:chunk` events. Each chunk is a
   self-contained ~3s WebM/Opus blob (the recorder restarts per segment so
   every blob has a valid header).
3. **Per audio chunk**, the backend:
   - validates the `sessionId` and audio size,
   - calls `POST /ai/stt/th` (Google STT, Thai) and emits `transcript:final`
     while persisting the Thai `sourceText`,
   - calls `POST /ai/translate/th-to-en` (LLM) and emits `translation:result`
     while persisting the English `translatedText`,
   - calls `POST /ai/tts/en` (Cartesia) and emits `tts:audio`. **TTS is
     non-fatal:** if it fails, the backend emits `error` with code
     `TTS_FAILED` but the translation has already been delivered and the
     pipeline keeps running.
4. **End session.** On `session:end` (or `POST .../end`), the status moves to
   `processing`, the backend gathers all messages and calls
   `POST /ai/classroom/finalize` (LLM). The resulting summary, vocabularies,
   and flashcards are persisted, the status becomes `completed`, and
   `session:completed` is emitted.

> **Note on partial transcripts:** `transcript:partial` exists in the contract,
> but the backend currently emits `transcript:final` per chunk. Interim partial
> streaming is a planned future enhancement (TODO), not a mock.

---

## Backend REST API

Base URL: `http://localhost:3001`

| Method | Path                                            | Description                                           |
| ------ | ----------------------------------------------- | ----------------------------------------------------- |
| GET    | `/health`                                       | Health check: `{"status":"ok","service":"backend"}`   |
| POST   | `/api/classroom-sessions`                       | Create session `{classroomName, speakerName}`         |
| GET    | `/api/classroom-sessions`                       | List sessions                                         |
| GET    | `/api/classroom-sessions/:sessionId`            | Get one session                                       |
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

---

## WebSocket events

URL: `ws://localhost:3001/ws` — envelope: `{ "event": "<name>", "payload": { ... } }`

**Client → Backend**

| Event           | Payload                                                       |
| --------------- | ------------------------------------------------------------- |
| `session:join`  | `{ sessionId }`                                               |
| `audio:chunk`   | `{ sessionId, audio (base64), mimeType: "audio/webm", sequenceNo }` |
| `session:end`   | `{ sessionId }`                                               |

**Backend → Client**

| Event                 | Payload                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `transcript:partial`  | `{ sessionId, text, language: "th-TH", isFinal: false }`                                 |
| `transcript:final`    | `{ sessionId, text, language: "th-TH", isFinal: true }`                                  |
| `translation:result`  | `{ sessionId, sourceText, translatedText, sourceLanguage: "th-TH", targetLanguage: "en-US" }` |
| `tts:audio`           | `{ sessionId, text, language: "en-US", audioUrl: "", audioBase64: "..." }`               |
| `session:completed`   | `{ sessionId, summaryReady: true, vocabularyReady: true, flashcardsReady: true, flashcardImagesReady, flashcardImageStatus }` |
| `error`               | `{ sessionId, code, message }`                                                           |

---

## AI-service HTTP API

Base URL (internal): `http://ai-service:8000` — called by the backend.

| Method | Path                       | Request                                                       | Response                                                                 |
| ------ | -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/health`                  | —                                                             | `{"status":"ok","service":"ai-service"}`                                 |
| POST   | `/ai/stt/th`               | `{ sessionId, audioBase64, mimeType: "audio/webm", sequenceNo }` | `{ sessionId, text, language: "th-TH", isFinal, confidence }`          |
| POST   | `/ai/translate/th-to-en`   | `{ sessionId, sourceText }`                                   | `{ translatedText, sourceLanguage: "th-TH", targetLanguage: "en-US" }`   |
| POST   | `/ai/tts/en`               | `{ sessionId, text }`                                         | `{ audioUrl: "", audioBase64, language: "en-US", durationMs }`           |
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
| `classroom_messages`     | `sessionId, sequenceNo, sourceText, translatedText, sourceLanguage, targetLanguage, confidence, audioUrl, isFinal, startedAt, endedAt, createdAt` |
| `classroom_summaries`    | `sessionId, summaryTh, summaryEn, keyPointsTh[], keyPointsEn[], createdAt`                                                                       |
| `classroom_vocabularies` | `sessionId, word, pronunciation, partOfSpeech, meaningTh, meaningEn, exampleSentenceEn, exampleSentenceTh, difficultyLevel, createdAt`           |
| `classroom_flashcards`   | `sessionId, front, back, type, word, hintTh, exampleSentence, createdAt`                                                                         |

`status` values: `active` → `processing` → `completed` (or `failed`).

---

## Troubleshooting

- **Microphone permission denied.** The browser must grant mic access on
  `http://localhost:3000`. If you blocked it, re-enable mic permission in the
  browser site settings and reload. Some browsers only allow `getUserMedia`
  on `localhost` or HTTPS.
- **No spoken English / TTS errors.** TTS is **non-fatal**. If Cartesia fails,
  you will receive an `error` event with code `TTS_FAILED`, but the
  `translation:result` is still delivered and persisted. Verify
  `CARTESIA_API_KEY` and `CARTESIA_VOICE_ID` in `.env`.
- **STT returns nothing / errors.** Confirm `credentials/google-service-account.json`
  exists and the service account has Speech-to-Text enabled. Each audio chunk
  must be a complete WebM/Opus blob (the recorder restarts per segment).
- **Translation / finalize fails.** Check `LLM_API_KEY` (OpenRouter key) and
  `LLM_MODEL` (valid OpenRouter model id). `LLM_BASE_URL` defaults to OpenRouter;
  override it only to use a different OpenAI-compatible gateway.
- **Services won't start in order.** Compose waits for healthchecks:
  `mongodb` and `ai-service` must be healthy before `backend`, and `backend`
  before `frontend`. Watch `make logs` for health status.
- **Mongo connection refused.** The backend connects to
  `mongodb://mongodb:27017` over the internal `ai-classroom-network`. Ensure
  the `mongodb` container is healthy (`make ps`).
