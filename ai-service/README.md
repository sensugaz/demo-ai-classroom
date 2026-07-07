# ai-service

Python FastAPI AI backend for the AI Classroom Thai -> English translator.
It exposes the speech-to-text, translation, text-to-speech, and session
finalization (summary / vocabulary / flashcards) HTTP endpoints consumed by the
Go backend.

Language direction is fixed: **th-TH -> en-US**. There is no language selection
logic anywhere in this service.

## Stack

- Python 3.12, FastAPI + Uvicorn
- Pydantic v2 + pydantic-settings
- Google Cloud Speech-to-Text (`google-cloud-speech`) — real synchronous recognize
- OpenRouter Chat Completions via the OpenAI-compatible `openai` AsyncOpenAI SDK — translation, summary, vocabulary, flashcards
- Cartesia TTS (REST `https://api.cartesia.ai/tts/bytes` via `httpx`) — real English speech synthesis

## HTTP API

| Method | Path                       | Purpose                                  |
| ------ | -------------------------- | ---------------------------------------- |
| GET    | `/health`                  | Liveness: `{"status":"ok","service":"ai-service"}` |
| POST   | `/ai/stt/th`               | Thai speech-to-text (per WEBM/Opus chunk) |
| POST   | `/ai/translate/th-to-en`   | Thai -> English translation               |
| POST   | `/ai/tts/en`               | English text-to-speech -> base64 mp3      |
| POST   | `/ai/classroom/finalize`   | Summary + vocabulary + flashcards         |

Interactive docs are served at `/docs` when running.

### Error semantics

- `/ai/stt/th`: HTTP 400 on undecodable audio, HTTP 502 on recognition failure.
- `/ai/translate/th-to-en`: HTTP 502 on LLM failure.
- `/ai/tts/en`: HTTP 502 on Cartesia failure (the backend treats TTS as
  non-fatal — translation has already been delivered to the client).
- `/ai/classroom/finalize`: HTTP 502 only on hard LLM misconfiguration
  (missing key/model). Transient per-stage failures degrade gracefully to an
  empty summary / empty lists so the session can still complete.

## Environment variables

| Variable                         | Default                                            | Description                                            |
| -------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `APP_PORT`                       | `8000`                                             | HTTP port.                                             |
| `GOOGLE_APPLICATION_CREDENTIALS` | `/app/credentials/google-service-account.json`     | Path to the mounted Google service-account JSON.       |
| `GOOGLE_STT_LANGUAGE_CODE`       | `th-TH`                                            | STT language code.                                     |
| `CARTESIA_API_KEY`               | _(empty)_                                          | Cartesia API key.                                      |
| `CARTESIA_VOICE_ID`              | _(empty)_                                          | Cartesia voice id used for synthesis.                  |
| `CARTESIA_TTS_LANGUAGE`          | `en`                                               | TTS language passed to Cartesia.                       |
| `LLM_API_KEY`                    | _(empty)_                                          | OpenRouter API key (https://openrouter.ai/keys).       |
| `LLM_MODEL`                      | _(empty)_                                          | OpenRouter model id, e.g. `openai/gpt-4o-mini`.        |
| `LLM_BASE_URL`                   | `https://openrouter.ai/api/v1`                     | OpenAI-compatible base URL. Defaults to OpenRouter; override for another gateway. |
| `LLM_HTTP_REFERER`               | `http://localhost:3000`                            | Optional OpenRouter attribution header (`HTTP-Referer`). |
| `LLM_APP_TITLE`                  | `AI Classroom`                                     | Optional OpenRouter attribution header (`X-Title`).    |
| `OPENAI_API_KEY`                 | _(empty)_                                          | Optional OpenAI Images key for generated flashcard art. |
| `FLASHCARD_IMAGE_BASE_URL`       | `https://api.openai.com/v1`                        | OpenAI Images API base URL.                             |
| `FLASHCARD_IMAGE_MODEL`          | `gpt-image-2`                                      | Image model used for generated flashcard art.           |
| `FLASHCARD_IMAGE_SIZE`           | `1024x1024`                                        | Generated flashcard image size.                         |
| `FLASHCARD_IMAGE_OUTPUT_FORMAT`  | `webp`                                             | Cached flashcard image format.                          |
| `FLASHCARD_IMAGE_QUALITY`        | `low`                                              | Image quality setting for faster/cheaper flashcards.    |
| `FLASHCARD_IMAGE_DIR`            | `/tmp/flashcard-images`                            | Persistent image cache directory.                       |
| `FLASHCARD_IMAGE_MAX_PER_SESSION`| `8`                                                | Maximum generated images per finalized session.         |
| `FLASHCARD_IMAGE_CACHE_TTL_HOURS`| `720`                                              | Deletes cached images older than this on startup.       |
| `TEMP_AUDIO_DIR`                 | `/tmp/audio`                                       | Scratch dir for optional temp audio writes.            |

## Google credentials note

The Google Speech client resolves credentials from
`GOOGLE_APPLICATION_CREDENTIALS`. Mount the service-account JSON into the
container and point the env var at it. With Docker Compose:

```yaml
services:
  ai-service:
    build: ./ai-service
    environment:
      GOOGLE_APPLICATION_CREDENTIALS: /app/credentials/google-service-account.json
    volumes:
      - ./ai-service/credentials/google-service-account.json:/app/credentials/google-service-account.json:ro
```

The JSON file is never committed; provide it out-of-band.

## Run with Docker (whole system)

From the repository root:

```bash
docker compose up --build
```

The service listens on port `8000` and its health probe is wired into the
container `HEALTHCHECK`.

## Run locally (without Docker)

```bash
cd ai-service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export GOOGLE_APPLICATION_CREDENTIALS=$(pwd)/credentials/google-service-account.json
export GOOGLE_STT_LANGUAGE_CODE=th-TH
export LLM_API_KEY=sk-or-...                    # OpenRouter key
export LLM_MODEL=openai/gpt-4o-mini             # OpenRouter model id
export LLM_BASE_URL=https://openrouter.ai/api/v1  # default; override for another gateway
export CARTESIA_API_KEY=...
export CARTESIA_VOICE_ID=...
export CARTESIA_TTS_LANGUAGE=en

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

## Notes & future work

- STT uses Google **synchronous** recognize per self-contained WEBM/Opus chunk
  (the frontend restarts MediaRecorder per segment so every blob carries its own
  header). Interim `transcript:partial` streaming via `streaming_recognize` is a
  labeled future enhancement (see `TODO(streaming)` in
  `app/services/google_stt_service.py`); the current contract emits final
  transcripts per chunk and there is no mocked STT.
- All translation/summary/vocabulary/flashcard output comes from a real LLM; no
  canned responses.
- TTS calls the real Cartesia API and returns base64 mp3.
