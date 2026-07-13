import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import {
  act,
  create,
  type ReactTestRenderer,
} from "react-test-renderer";

import { useRealtimeTranslation } from "../hooks/useRealtimeTranslation.ts";
import type { TranslationCommitPayload } from "../lib/types.ts";

type HookResult = ReturnType<typeof useRealtimeTranslation>;
type DataListener = (event: { data: string }) => void;

class FakeAudioTrack {
  enabled = false;
  stopped = false;

  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream {
  constructor(readonly track: FakeAudioTrack) {}

  getAudioTracks() {
    return [this.track];
  }

  getTracks() {
    return [this.track];
  }
}

class FakeDataChannel {
  readyState = "open";
  readonly sent: string[] = [];
  private readonly listeners = new Set<DataListener>();

  addEventListener(type: string, listener: DataListener) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: DataListener) {
    if (type === "message") this.listeners.delete(listener);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = "closed";
  }

  emit(payload: Record<string, unknown>) {
    const event = { data: JSON.stringify(payload) };
    for (const listener of this.listeners) listener(event);
  }
}

class FakePeerConnection {
  static latest: FakePeerConnection | null = null;

  readonly channel = new FakeDataChannel();
  connectionState = "connected";
  ontrack: ((event: { track: FakeAudioTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePeerConnection.latest = this;
  }

  addTrack() {}

  createDataChannel() {
    return this.channel;
  }

  async createOffer() {
    return { type: "offer", sdp: "test-offer" };
  }

  async setLocalDescription() {}

  async setRemoteDescription() {}

  close() {
    this.connectionState = "closed";
  }
}

function restoreProperty(
  key: string,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, key);
  }
}

test("HOLD keeps complete commits and silently discards incomplete phrases", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalPeer = Object.getOwnPropertyDescriptor(
    globalThis,
    "RTCPeerConnection",
  );
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const originalActFlag = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  const track = new FakeAudioTrack();
  const stream = new FakeMediaStream(track);
  let getUserMediaCalls = 0;
  let renderer: ReactTestRenderer | null = null;

  t.after(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    restoreProperty("window", originalWindow);
    restoreProperty("navigator", originalNavigator);
    restoreProperty("document", originalDocument);
    restoreProperty("RTCPeerConnection", originalPeer);
    restoreProperty("fetch", originalFetch);
    restoreProperty("IS_REACT_ACT_ENVIRONMENT", originalActFlag);
    FakePeerConnection.latest = null;
  });

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          getUserMediaCalls += 1;
          return stream;
        },
      },
    },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: FakePeerConnection,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/realtime-translation/client-secret")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              clientSecret: "ek_test",
              expiresAt: 1_800_000_000,
              translationSessionId: "translation-test",
              lastCommitNo: 0,
              model: "gpt-realtime-translate",
              targetLanguage: "en-US",
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/realtime/translations/calls")) {
        return new Response("test-answer", { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const commits: Array<Omit<TranslationCommitPayload, "sessionId">> = [];
  let saveDrainCalls = 0;
  let resolveReleasedSave: ((saved: boolean) => void) | null = null;
  let hookResult: HookResult | null = null;
  const getHook = (): HookResult => {
    assert.ok(hookResult);
    return hookResult;
  };

  function Harness() {
    hookResult = useRealtimeTranslation({
      sessionId: "session-test",
      enabled: true,
      recordingMode: "ptt",
      voiceProfile: "child_girl",
      speechSpeed: "slow",
      onPhraseCommit: (payload) => commits.push(payload),
      waitForSaveDrain: async () => {
        saveDrainCalls += 1;
        if (saveDrainCalls === 2) {
          return new Promise<boolean>((resolve) => {
            resolveReleasedSave = resolve;
          });
        }
        return true;
      },
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Harness));
  });
  await act(async () => {
    const resumePromise = getHook().resume();
    assert.equal(
      getUserMediaCalls,
      1,
      "first capture must be requested synchronously from the mic gesture",
    );
    await resumePromise;
  });

  const peer = FakePeerConnection.latest;
  assert.ok(peer);
  assert.equal(track.enabled, true);
  assert.equal(getHook().captureStatus, "active");

  await act(async () => {
    peer.channel.emit({
      type: "session.input_transcript.delta",
      event_id: "input-1",
      delta: "สวัสดี",
      elapsed_ms: 1_000,
    });
    peer.channel.emit({
      type: "session.output_transcript.delta",
      event_id: "output-1",
      delta: "Hello",
      elapsed_ms: 1_100,
    });
  });

  let releasePromise: Promise<void> | null = null;
  await act(async () => {
    releasePromise = getHook().releasePushToTalk();
    assert.equal(track.enabled, false, "release must disable the track synchronously");
    assert.equal(commits.length, 1, "release must queue one bilingual commit");
    assert.equal(commits[0]?.sourceText, "สวัสดี");
    assert.equal(commits[0]?.translatedText, "Hello");
    assert.equal(
      peer.channel.sent.some((message) => message.includes("session.close")),
      false,
      "warm HOLD release must not close the Realtime call",
    );
  });

  let pausePromise: Promise<void> | null = null;
  await act(async () => {
    pausePromise = getHook().pause();
    await Promise.resolve();
    assert.equal(
      peer.channel.sent.some((message) => message.includes("session.close")),
      false,
      "pause must wait for the released phrase to save",
    );
  });

  assert.ok(resolveReleasedSave);
  await act(async () => {
    resolveReleasedSave?.(true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(
      peer.channel.sent.some((message) => message.includes("session.close")),
      true,
      "explicit pause must retain the close-and-drain path",
    );
    peer.channel.emit({ type: "session.closed", event_id: "closed-1" });
    await Promise.all([releasePromise, pausePromise]);
  });

  assert.equal(saveDrainCalls, 2);
  assert.equal(track.stopped, true);
  assert.equal(getHook().connectionStatus, "idle");

  await act(async () => {
    await getHook().resume();
  });
  const warmPeer = FakePeerConnection.latest;
  assert.ok(warmPeer);
  await act(async () => {
    warmPeer.channel.emit({
      type: "session.input_transcript.delta",
      event_id: "input-only",
      delta: "มีเฉพาะภาษาไทย",
      elapsed_ms: 2_000,
    });
    await getHook().releasePushToTalk();
  });

  assert.equal(commits.length, 1, "a one-sided phrase must not be committed");
  assert.equal(getHook().error, null);
  assert.equal(getHook().pipelineStatus, "idle");
  assert.equal(getHook().captureStatus, "paused");
  assert.equal(
    warmPeer.channel.sent.some((message) => message.includes("session.close")),
    false,
    "an incomplete HOLD phrase must keep the Realtime call warm",
  );

  await act(async () => {
    await getHook().resume();
    warmPeer.channel.emit({
      type: "session.input_transcript.delta",
      event_id: "input-misaligned",
      delta: "เวลาของประโยคไม่ตรงกัน",
      elapsed_ms: 3_000,
    });
    warmPeer.channel.emit({
      type: "session.output_transcript.delta",
      event_id: "output-misaligned",
      delta: "The phrase clocks do not align.",
      elapsed_ms: 2_000,
    });
    await getHook().releasePushToTalk();
  });

  assert.equal(commits.length, 1, "a misaligned phrase must not be committed");
  assert.equal(getHook().error, null);
  assert.equal(getHook().pipelineStatus, "idle");

  await act(async () => {
    await getHook().resume();
    warmPeer.channel.emit({
      type: "session.input_transcript.delta",
      event_id: "pause-input-only",
      delta: "หยุดก่อนคำแปลมา",
      elapsed_ms: 4_000,
    });
  });
  let incompletePause: Promise<void> | null = null;
  await act(async () => {
    incompletePause = getHook().pause();
    await Promise.resolve();
    warmPeer.channel.emit({
      type: "session.closed",
      event_id: "closed-incomplete",
    });
    await incompletePause;
  });

  assert.equal(commits.length, 1, "an incomplete paused phrase must not commit");
  assert.equal(getHook().error, null);
  assert.equal(getHook().pipelineStatus, "idle");
  assert.equal(getHook().captureStatus, "paused");

  await act(async () => {
    await getHook().resume();
  });
  const errorPeer = FakePeerConnection.latest;
  assert.ok(errorPeer);
  await act(async () => {
    errorPeer.channel.emit({
      type: "session.input_transcript.delta",
      event_id: "input-before-error",
      delta: "ประโยคที่ยังไม่มีคำแปล",
      elapsed_ms: 5_000,
    });
    errorPeer.channel.emit({
      type: "error",
      event_id: "realtime-error",
      error: {
        code: "REALTIME_TEST_ERROR",
        message: "A real Realtime failure remains visible.",
      },
    });
    await getHook().releasePushToTalk();
  });

  assert.equal(commits.length, 1, "an errored incomplete phrase must not commit");
  assert.equal(getHook().error?.code, "REALTIME_TEST_ERROR");
  assert.equal(getHook().pipelineStatus, "error");
});
