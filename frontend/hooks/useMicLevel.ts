"use client";

/**
 * Drives a mic VU ring with ZERO React re-renders.
 *
 * One AudioContext + AnalyserNode reads the live MediaStream; a single rAF loop
 * computes RMS and writes it to `--level` (0..1) on the target element's style.
 * The `.mic-vu` CSS class turns that var into a box-shadow ring radius. We never
 * setState per frame (that would re-render the whole live board ~60x/s and burn
 * iPad battery). Under prefers-reduced-motion we skip the loop and leave a static
 * ring. Everything is torn down on stop/unmount.
 */

import { useEffect } from "react";
import type { RefObject } from "react";

export function useMicLevel(
  stream: MediaStream | null,
  targetRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    const el = targetRef.current;
    if (!active || !stream || !el) return;

    const prefersReduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced) {
      el.style.setProperty("--level", "0");
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;

    let ctx: AudioContext | null = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;

    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const v = ((data[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      // Scale up so normal speech visibly drives the ring; clamp to 1.
      const level = Math.min(1, rms * 2.4);
      el.style.setProperty("--level", level.toFixed(3));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      try {
        source.disconnect();
      } catch {
        // ignore
      }
      try {
        void ctx?.close();
      } catch {
        // ignore
      }
      ctx = null;
      el.style.setProperty("--level", "0");
    };
  }, [stream, active, targetRef]);
}

export default useMicLevel;
