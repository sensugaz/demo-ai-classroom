# AI Classroom — Frontend

Next.js 15 (App Router) + React 19 + TypeScript (strict) + Tailwind CSS v4 UI for
the AI Classroom Thai → English translator.

The interface lets a teacher start a class, speak Thai into the microphone, and
see a live English translation with auto-played English audio. After the class
ends, an auto-generated summary, vocabulary list, and flash cards are available.

Language is fixed end to end: source `th-TH`, target `en-US`. There is no
language selector.

## Tech stack

- Next.js 15 App Router, React 19, TypeScript strict mode
- Tailwind CSS v4 (PostCSS plugin, no JS config)
- Browser WebRTC to OpenAI for live translation
- Native `WebSocket` for backend phrase commits and Cartesia TTS
- Standalone server output for Docker (`output: "standalone"`)

## Environment variables

Copy `.env.example` to `.env.local` for local development.

| Variable                   | Default                  | Purpose                              |
| -------------------------- | ------------------------ | ------------------------------------ |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:3001`  | Backend REST base URL                |
| `NEXT_PUBLIC_WS_URL`       | `ws://localhost:3001/ws` | Backend WebSocket endpoint           |

Both are read at build/runtime by the browser (the `NEXT_PUBLIC_` prefix is
required so they are inlined into the client bundle).

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
```

Other scripts:

```bash
npm run build    # production build (standalone output)
npm run start    # serve the production build
npm run lint     # eslint
```

## How the realtime pipeline works

1. The classroom page (`/classroom`) creates a session via REST and routes to
   the live page.
2. The live page opens the backend WebSocket for `translation:commit`
   persistence and Cartesia TTS events.
3. On the first mic action, the browser requests a short-lived credential from
   `/realtime-translation/client-secret`, then opens a WebRTC translation call using
   `gpt-realtime-translate`.
4. Source and translated transcript deltas are buffered verbatim, but Realtime
   English remains private and untrusted. Stable phrases are sent to the backend,
   reviewed against Thai and lesson context, then canonical English is displayed
   and sent to Cartesia as the only audible translated output.
5. HOLD enables the microphone track only while pressed. LIVE keeps the same
   WebRTC call open and toggles the track between active and paused.
6. `End class` sends `session.close`, consumes remaining deltas, commits the
   final phrase, waits for every terminal `translation:committed` or
   `translation:rejected` outcome, then
   calls REST `/end` and routes to the result page. The result page refreshes
   until summary, transcript, vocabulary, flash cards, and delayed flashcard
   images are ready.

## Project structure

```
app/
  layout.tsx                         root layout + globals
  page.tsx                           landing, links to /classroom
  classroom/
    page.tsx                         start form + recent sessions
    [sessionId]/live/page.tsx        live mic, transcript, translation, audio
    [sessionId]/result/page.tsx      tabs: Summary / Transcript / Vocabulary / Flash Cards
components/classroom/                presentational + interactive UI pieces
hooks/
  useClassroomSession.ts             REST: create/get/list/end + artifacts
  useClassroomSocket.ts              commit ACKs, reconnect, and Cartesia events
  useRealtimeTranslation.ts          OpenAI WebRTC, text deltas, phrase commits
lib/
  api.ts                             typed REST client
  websocket.ts                       typed WS envelope wrapper
  types.ts                           all contract types (exact field names)
```

## Docker

Multi-stage build on `node:22-alpine` producing the Next.js standalone server.

```bash
docker build -t ai-classroom-frontend .
docker run --rm -p 3000:3000 \
  -e NEXT_PUBLIC_API_BASE_URL=http://localhost:3001 \
  -e NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws \
  ai-classroom-frontend
```

Within the full system this service is started by `docker compose up --build`
alongside the backend, AI service, and MongoDB.

> Note: `NEXT_PUBLIC_*` values are inlined into the client bundle at build time.
> When changing them for a different host, rebuild the image so the new values
> are baked in.

## Accessibility & UX

- Keyboard-focusable controls with visible focus rings.
- `aria-live` regions for transcript, translation, and status updates.
- Flash cards flip on click and support Arrow Left/Right navigation.
- Handled states: microphone permission denied, unsupported browser, WebSocket
  disconnect/reconnect, loading skeletons, empty states, and non-fatal TTS
  failures.
- Honors `prefers-reduced-motion`.
```
