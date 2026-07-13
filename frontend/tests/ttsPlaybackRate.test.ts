import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTtsPlaybackRate,
  prepareTtsPlayback,
  resolveTtsPlaybackRate,
  TTS_PLAYBACK_RATES,
} from "../lib/ttsPlaybackRate.ts";

test("uses exact kindergarten playback-rate mappings", () => {
  assert.deepEqual(TTS_PLAYBACK_RATES, {
    slow: 0.78,
    medium: 0.86,
    fast: 1,
  });
});

test("prefers event rate, then event speed, then selected fallback", () => {
  assert.equal(resolveTtsPlaybackRate(0.81, "fast", "slow"), 0.81);
  assert.equal(resolveTtsPlaybackRate(Number.NaN, "slow", "fast"), 0.78);
  assert.equal(resolveTtsPlaybackRate(0, "medium", "fast"), 0.86);
  assert.equal(resolveTtsPlaybackRate(undefined, "unknown", "fast"), 1);
});

test("loads the source before applying default and active playback rates", () => {
  const operations: string[] = [];
  const audio = {
    _src: "",
    _defaultPlaybackRate: 1,
    _playbackRate: 1,
    preservesPitch: false,
    webkitPreservesPitch: false,
    set src(value: string) {
      this._src = value;
      operations.push(`src:${value}`);
    },
    get src() {
      return this._src;
    },
    set defaultPlaybackRate(value: number) {
      this._defaultPlaybackRate = value;
      operations.push(`default:${value}`);
    },
    get defaultPlaybackRate() {
      return this._defaultPlaybackRate;
    },
    set playbackRate(value: number) {
      this._playbackRate = value;
      operations.push(`active:${value}`);
    },
    get playbackRate() {
      return this._playbackRate;
    },
    load() {
      operations.push("load");
      this._defaultPlaybackRate = 1;
      this._playbackRate = 1;
    },
  };

  prepareTtsPlayback(audio, "blob:clip", 0.78);

  assert.deepEqual(operations, [
    "src:blob:clip",
    "load",
    "default:0.78",
    "active:0.78",
  ]);
  assert.equal(audio.defaultPlaybackRate, 0.78);
  assert.equal(audio.playbackRate, 0.78);
  assert.equal(audio.preservesPitch, true);
  assert.equal(audio.webkitPreservesPitch, true);

  audio._defaultPlaybackRate = 1;
  audio._playbackRate = 1;
  applyTtsPlaybackRate(audio, 0.78);
  assert.equal(audio.defaultPlaybackRate, 0.78);
  assert.equal(audio.playbackRate, 0.78);
});
