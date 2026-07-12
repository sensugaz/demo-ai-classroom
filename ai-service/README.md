# ai-service

Python FastAPI service for AI Classroom. It mints short-lived OpenAI Realtime
Translation credentials, synthesizes English speech with Cartesia, and creates
post-class summaries, vocabulary, flashcards, and cached flashcard images. Every
live phrase is reviewed against its Thai transcript before English is released.

Language direction is fixed: **th-TH -> en-US**.

## Stack

- Python 3.12, FastAPI, Uvicorn, Pydantic v2
- OpenAI Realtime Translation (`gpt-realtime-translate`)
- Cartesia TTS for the only audible translated output
- OpenRouter-compatible chat completion for post-class learning material
- OpenAI Images for cached, kindergarten-friendly flashcard art

## HTTP API

| Method | Path                                      | Purpose |
| ------ | ----------------------------------------- | ------- |
| GET    | `/health`                                 | Liveness probe |
| POST   | `/ai/realtime-translation/client-secret` | Mint a short-lived browser credential |
| POST   | `/ai/realtime-translation/review`        | Produce canonical English for one phrase |
| POST   | `/ai/tts/en`                              | English text-to-speech as base64 MP3 |
| POST   | `/ai/classroom/finalize`                  | Summary, vocabulary, and flashcards |
| POST   | `/ai/classroom/flashcard-images`          | Generate/cache flashcard images |
| GET    | `/ai/classroom/flashcard-images/:file`    | Read a cached image |

Interactive docs are served at `/docs` when running.

The client-secret endpoint returns HTTP 503 when `OPENAI_API_KEY` is missing
and HTTP 502 when OpenAI rejects or cannot complete the request. Upstream bodies
and the standard API key are never returned to the browser.

## Environment Variables

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `APP_PORT` | `8000` | HTTP port |
| `OPENAI_API_KEY` | _(empty)_ | Required server-only key for Realtime, phrase review, and flashcard images |
| `CARTESIA_API_KEY` | _(empty)_ | Cartesia API key |
| `CARTESIA_VOICE_ID` | _(empty)_ | Default Cartesia voice ID |
| `CARTESIA_VOICE_CHILD_GIRL_ID` | `32b3f3c5-7171-46aa-abe7-b598964aa793` | Child-girl profile |
| `CARTESIA_VOICE_CHILD_BOY_ID` | `79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e` | Child-boy profile |
| `CARTESIA_VOICE_ADULT_WOMAN_ID` | `f786b574-daa5-4673-aa0c-cbe3e8534c02` | Adult-woman profile |
| `CARTESIA_VOICE_ADULT_MAN_ID` | `47c38ca4-5f35-497b-b1a3-415245fb35e1` | Adult-man profile |
| `CARTESIA_TTS_LANGUAGE` | `en` | Cartesia language |
| `LLM_API_KEY` | _(empty)_ | OpenRouter API key |
| `LLM_MODEL` | _(empty)_ | OpenRouter model ID |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible LLM base URL |
| `FLASHCARD_IMAGE_MODEL` | `gpt-image-2` | Flashcard image model |
| `FLASHCARD_IMAGE_SIZE` | `1024x1024` | Generated image size |
| `FLASHCARD_IMAGE_OUTPUT_FORMAT` | `webp` | Cached image format |
| `FLASHCARD_IMAGE_QUALITY` | `low` | Image quality/cost setting |
| `FLASHCARD_IMAGE_DIR` | `/tmp/flashcard-images` | Persistent image cache |
| `FLASHCARD_IMAGE_MAX_PER_SESSION` | `8` | Generation cap per session |
| `FLASHCARD_IMAGE_CACHE_TTL_HOURS` | `720` | Startup cache cleanup age |

Never expose `OPENAI_API_KEY` through a frontend variable or client bundle.
The browser receives only the expiring secret minted for one translation call.

## Run

From the repository root:

```bash
docker compose up --build
```

For local development:

```bash
cd ai-service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export OPENAI_API_KEY=...
export LLM_API_KEY=...
export LLM_MODEL=openai/gpt-4o-mini
export CARTESIA_API_KEY=...

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

The browser streams audio directly to OpenAI; this service never receives raw
classroom microphone chunks. Cartesia TTS failures are non-fatal after a text
commit has been durably stored. Phrase-review failures are fail-closed: no
English is persisted or synthesized. Flashcard image generation runs after class
finalization and uses the persistent cache volume.
