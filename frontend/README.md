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
5. The live Phrase Journey starts a local `queued` state as soon as a commit is
   created. Typed WebSocket `translation:progress` events advance that commit
   through `reviewing`, `persisting`, and `synthesizing`. Repeated stages are
   harmless, skipped stages are accepted, and older stages or late events for a
   terminal commit are ignored.
   An exact `translation:committed` ACK atomically moves the original payload
   from pending-save to acknowledged-awaiting-audio and publishes the canonical
   English immediately. The journey remains on VOICE / `synthesizing` until the
   matching TTS terminal event. Duplicate ACKs remain awaiting audio; they are
   never inferred to be no-audio outcomes.
6. Progress, `tts:audio`, and `TTS_FAILED` events accept an exact `{ commitId,
   commitNo }` from either unresolved map. TTS audio or failure removes the
   acknowledged-awaiting-audio entry and completes the full drain. Correlated
   fatal save errors settle the commit as a no-audio outcome and ask the teacher
   to repeat the phrase. On reconnect, pending-save and awaiting-audio payloads
   are resent together in `commitNo` order with their original voice settings.
7. When several phrases overlap, the indicator shows the oldest unresolved
   commit and TTS clips remain ordered by commit number even when audio arrives
   out of order. A browser-confirmed audio `playing` event temporarily takes
   priority. Audio arrival is only queued/ready: playback is never inferred from
   receiving `tts:audio` or from calling `HTMLMediaElement.play()`.
   Playback, mute, replay, and autoplay permission do not block either drain.
   Each clip snapshots its effective rate when queued: event `playbackRate` is
   authoritative, followed by event `speechSpeed`, with the selected live speed
   used only as a fallback. Slow, medium, and fast map to `0.78`, `0.86`, and
   `1.0`; changing the selector never retimes queued or playing audio.
8. LIVE uses quiet and maximum-window phrase boundaries while the microphone is
   active. HOLD disables those timers: pressing enables the existing WebRTC
   track, and releasing disables it synchronously and queues one complete,
   time-aligned Thai/English pair for canonical review without `session.close`.
   Missing or misaligned pairs fail closed, clear the incomplete draft silently,
   and leave the warm connection ready for the next HOLD phrase.
9. The HOLD connection stays warm between phrases. Deltas arriving after release
   are quarantined until a 400 ms no-delta barrier completes; a two-second hard
   cap marks the call dirty so the next press reconnects instead of mixing phrase
   generations. The next press waits only for that barrier and pending saves, so
   acknowledged phrases do not hold the microphone while TTS is synthesizing.
   Reset and `End class` use
   the full pending-save plus awaiting-audio drain. `End class` sends
   `session.close`, consumes remaining deltas, commits the final phrase, waits
   for save and TTS terminal outcomes, then calls REST `/end` and routes to the
   result page. The result page refreshes until summary, transcript, vocabulary,
   flash cards, and delayed flashcard images are ready.

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
  phraseJourney.ts                   pure commit/progress/audio state machine
  realtimeCommitState.ts             immutable save/ACK/TTS lifecycle helpers
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
- A five-step Thai-first Phrase Journey uses `aria-current="step"`, textual
  current/completed markers, and one visible polite, atomic live message.
- Review, TTS, and playback failures are announced without moving focus.
- `aria-live` regions for transcript, translation, and status updates.
- Flash cards flip on click and support Arrow Left/Right navigation.
- Handled states: microphone permission denied, unsupported browser, WebSocket
  disconnect/reconnect, loading skeletons, empty states, and non-fatal TTS
  failures.
- Honors `prefers-reduced-motion`.
```
