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
- Native `WebSocket` for realtime, `MediaRecorder` for capture
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
2. The live page opens the WebSocket, sends `session:join`, then streams audio.
3. Audio capture is **segmented**: `useMicrophoneRecorder` records ~3 second
   self-contained `webm/opus` blobs (start → stop → emit → restart). This is
   required because `MediaRecorder` timeslice chunks after the first are not
   independently decodable, and the backend runs a per-chunk sync STT that needs
   a complete container with a header on every blob.
4. Each segment is base64-encoded and sent as an `audio:chunk` event.
5. Inbound `transcript:final` (Thai), `translation:result` (English), and
   `tts:audio` (English speech) events update the UI. TTS clips are queued so
   they never overlap.
6. `End class` sends `session:end` (plus a REST `/end` fallback). On
   `session:completed` the user is routed to the result page with the summary,
   transcript, vocabulary, and flash card tabs.

### Interim partial transcripts (future enhancement)

The contract includes `transcript:partial` for interim Thai text. The frontend
already renders partial lines (greyed/italic, replaced by the final line) so it
is ready the moment the backend begins streaming interim results. Until then the
backend emits `transcript:final` per chunk, which is fully supported.

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
  useClassroomSocket.ts              WebSocket orchestration + reconnect
  useMicrophoneRecorder.ts           segmented recorder
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
