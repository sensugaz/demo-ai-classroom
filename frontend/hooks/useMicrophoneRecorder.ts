"use client";

/**
 * Segmented microphone recorder.
 *
 * WHY SEGMENTS: MediaRecorder produces a single decodable container only for a
 * complete start..stop cycle. Chunks emitted by timeslice after the first are
 * NOT independently decodable (they lack the webm/opus header). The backend STT
 * does a per-chunk sync recognize and needs every blob to be self-contained.
 *
 * STRATEGY: start the recorder, stop it after ~segmentMs, collect the full blob
 * in onstop, hand it to onSegment(base64, mimeType, sequenceNo), then immediately
 * start a fresh recorder for the next segment. This yields a stream of complete,
 * header-bearing webm/opus blobs.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { RecorderStatus, RecordingMode } from "@/lib/types";

// Segment length trades responsiveness against phrase completeness. Shorter =>
// lower per-reply latency but clips mid-sentence; longer => fuller utterances
// reach STT (fewer cut words, fewer empty chars=0 segments) at the cost of a
// later reply. 5s captures whole spoken phrases for Thai classroom speech.
const DEFAULT_SEGMENT_MS = 5000;

// Opus speech is intelligible at low bitrates; a small bitrate keeps each blob
// tiny so encode + upload + STT latency stays low.
const AUDIO_BITS_PER_SECOND = 32000;

/**
 * getUserMedia constraints. Browser-side DSP (noise suppression, echo
 * cancellation, auto gain) cleans up classroom background noise before it ever
 * reaches STT, improving transcript accuracy. Mono is enough for speech.
 */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  channelCount: 1,
};

/** mimeTypes tried in order; first supported wins. */
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
] as const;

export interface MicrophoneSegment {
  /** Base64 (no data: prefix) of a complete, self-contained webm/opus blob. */
  base64: string;
  /** Always normalized to "audio/webm" to match the backend contract. */
  mimeType: "audio/webm";
  sequenceNo: number;
}

export interface UseMicrophoneRecorderOptions {
  segmentMs?: number;
  /**
   * "live" (default): auto-segment every segmentMs for continuous hands-free
   * streaming. "ptt": no auto-segmentation — record from start() until stop()
   * and emit a single self-contained utterance (push-to-talk).
   */
  mode?: RecordingMode;
  onSegment: (segment: MicrophoneSegment) => void | Promise<void>;
  onError?: (message: string) => void;
  /** Exposes the live MediaStream (on start) / null (on stop) for VU metering. */
  onStream?: (stream: MediaStream | null) => void;
}

interface UseMicrophoneRecorderResult {
  status: RecorderStatus;
  isRecording: boolean;
  isFlushing: boolean;
  isSupported: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  stopAndFlush: () => Promise<void>;
}

function pickMimeType(): string | null {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return null;
  }
  for (const candidate of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected FileReader result"));
        return;
      }
      // result is a data URL: "data:audio/webm;base64,XXXX" -> strip prefix.
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export function useMicrophoneRecorder(
  options: UseMicrophoneRecorderOptions,
): UseMicrophoneRecorderResult {
  const {
    segmentMs = DEFAULT_SEGMENT_MS,
    mode = "live",
    onSegment,
    onError,
    onStream,
  } = options;

  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState<boolean>(true);
  const [isFlushing, setIsFlushing] = useState<boolean>(false);

  // Latest mode without retriggering the recording effects.
  const modeRef = useRef<RecordingMode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Mutable refs hold transient recorder/stream state across renders.
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const segmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequenceRef = useRef<number>(0);
  const mimeTypeRef = useRef<string | null>(null);
  // recordingActive controls whether onstop should chain into a new segment.
  const recordingActiveRef = useRef<boolean>(false);
  const isFlushingRef = useRef<boolean>(false);
  const startingRef = useRef<boolean>(false);
  const startGenerationRef = useRef<number>(0);
  const recorderStopPromiseRef = useRef<Promise<void> | null>(null);
  const pendingWorkRef = useRef<Set<Promise<void>>>(new Set());
  // FileReader completion order is not guaranteed. Chain segment encoding and
  // sending so sequence N always reaches the socket before sequence N+1.
  const segmentSendChainRef = useRef<Promise<void>>(Promise.resolve());
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const pendingErrorRef = useRef<Error | null>(null);

  // Keep the latest onSegment / onError without retriggering effects.
  const onSegmentRef = useRef(onSegment);
  const onErrorRef = useRef(onError);
  const onStreamRef = useRef(onStream);
  useEffect(() => {
    onSegmentRef.current = onSegment;
  }, [onSegment]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    onStreamRef.current = onStream;
  }, [onStream]);

  useEffect(() => {
    const supported =
      typeof window !== "undefined" &&
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof MediaRecorder !== "undefined";
    setIsSupported(supported);
    if (!supported) {
      setStatus("unsupported");
    }
  }, []);

  const clearSegmentTimer = useCallback(() => {
    if (segmentTimerRef.current !== null) {
      clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
  }, []);

  const reportError = useCallback((message: string) => {
    setError(message);
    onErrorRef.current?.(message);
  }, []);

  /**
   * Begin a single segment: create a recorder on the live stream, capture its
   * full output on stop, and (if still recording) chain into the next segment.
   */
  const startSegment = useCallback(() => {
    const stream = streamRef.current;
    const mimeType = mimeTypeRef.current;
    if (!stream || !mimeType || !recordingActiveRef.current) {
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
    } catch (cause) {
      reportError(
        cause instanceof Error
          ? `Could not start recorder: ${cause.message}`
          : "Could not start recorder.",
      );
      setStatus("error");
      recordingActiveRef.current = false;
      return;
    }

    recorderRef.current = recorder;
    const parts: BlobPart[] = [];
    let resolveStopped = () => {};
    recorderStopPromiseRef.current = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        parts.push(event.data);
      }
    };

    recorder.onstop = () => {
      const wasActive = recordingActiveRef.current;
      if (recorderRef.current === recorder) {
        recorderRef.current = null;
      }

      // Reserve the sequence synchronously in recorder-stop order, then serialize
      // the asynchronous FileReader + socket work behind prior segments.
      const blob = new Blob(parts, { type: mimeType });
      const sequenceNo = blob.size > 0 ? ++sequenceRef.current : 0;
      const work = segmentSendChainRef.current.then(async () => {
        if (sequenceNo === 0) return;
        const base64 = await blobToBase64(blob);
        await onSegmentRef.current({ base64, mimeType: "audio/webm", sequenceNo });
      }).catch((cause) => {
        const failure =
          cause instanceof Error ? cause : new Error("Failed to send audio.");
        pendingErrorRef.current = failure;
        reportError(`Failed to send audio: ${failure.message}`);
      });
      segmentSendChainRef.current = work;
      pendingWorkRef.current.add(work);
      void work.finally(() => {
        pendingWorkRef.current.delete(work);
        resolveStopped();
      });

      // Chain into the next segment so recording is continuous.
      if (wasActive) {
        startSegment();
      }
    };

    try {
      recorder.start();
    } catch (cause) {
      reportError(
        cause instanceof Error
          ? `Could not start recording: ${cause.message}`
          : "Could not start recording.",
      );
      setStatus("error");
      recordingActiveRef.current = false;
      recorderStopPromiseRef.current = null;
      resolveStopped();
      return;
    }

    // Live mode: stop after segmentMs to flush a complete blob (onstop chains
    // into the next segment). Push-to-talk: no timer — keep recording until the
    // caller invokes stop() on button release, yielding one utterance per press.
    clearSegmentTimer();
    if (modeRef.current === "live") {
      segmentTimerRef.current = setTimeout(() => {
        if (recorderRef.current && recorderRef.current.state === "recording") {
          try {
            recorderRef.current.stop();
          } catch {
            // ignore; onstop chaining handles recovery
          }
        }
      }, segmentMs);
    }
  }, [clearSegmentTimer, reportError, segmentMs]);

  const start = useCallback(async (): Promise<void> => {
    if (
      recordingActiveRef.current ||
      isFlushingRef.current ||
      startingRef.current
    ) {
      return;
    }

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      setIsSupported(false);
      setStatus("unsupported");
      reportError("Microphone recording is not supported in this browser.");
      return;
    }

    const mimeType = pickMimeType();
    if (!mimeType) {
      setIsSupported(false);
      setStatus("unsupported");
      reportError("No supported webm/opus audio format is available.");
      return;
    }
    mimeTypeRef.current = mimeType;

    setError(null);
    setStatus("requesting");
    startingRef.current = true;
    const startGeneration = startGenerationRef.current;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
      });
    } catch (cause) {
      startingRef.current = false;
      // Distinguish a denied permission from other failures.
      const name =
        cause instanceof DOMException ? cause.name : "UnknownError";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setStatus("denied");
        reportError(
          "Microphone access was denied. Enable it in your browser settings and try again.",
        );
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setStatus("error");
        reportError("No microphone was found on this device.");
      } else {
        setStatus("error");
        reportError(
          cause instanceof Error
            ? `Could not access microphone: ${cause.message}`
            : "Could not access microphone.",
        );
      }
      return;
    }

    startingRef.current = false;
    if (
      startGeneration !== startGenerationRef.current ||
      isFlushingRef.current
    ) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return;
    }

    streamRef.current = stream;
    onStreamRef.current?.(stream);
    recordingActiveRef.current = true;
    setStatus("recording");
    startSegment();
  }, [reportError, startSegment]);

  const stopAndFlush = useCallback((): Promise<void> => {
    if (flushPromiseRef.current) {
      return flushPromiseRef.current;
    }

    recordingActiveRef.current = false;
    startGenerationRef.current += 1;
    isFlushingRef.current = true;
    setIsFlushing(true);
    clearSegmentTimer();

    let flushPromise: Promise<void>;
    flushPromise = (async () => {
      const recorder = recorderRef.current;
      const recorderStopped = recorderStopPromiseRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          // Final stop flushes the last segment via onstop (no re-chain because
          // recordingActiveRef is already false).
          recorder.stop();
        } catch {
          // An already-stopped recorder will have queued onstop itself.
        }
      }

      if (recorderStopped) {
        await recorderStopped;
      }

      while (pendingWorkRef.current.size > 0) {
        await Promise.all([...pendingWorkRef.current]);
      }

      const pendingError = pendingErrorRef.current;
      pendingErrorRef.current = null;

      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
      streamRef.current = null;
      onStreamRef.current?.(null);

      setStatus((prev) =>
        prev === "denied" || prev === "unsupported" || prev === "error"
          ? prev
          : "stopped",
      );

      if (pendingError) {
        throw pendingError;
      }
    })().finally(() => {
      if (flushPromiseRef.current === flushPromise) {
        flushPromiseRef.current = null;
      }
      recorderRef.current = null;
      recorderStopPromiseRef.current = null;
      pendingErrorRef.current = null;
      isFlushingRef.current = false;
      setIsFlushing(false);
    });

    flushPromiseRef.current = flushPromise;
    return flushPromise;
  }, [clearSegmentTimer]);

  const stop = useCallback(() => {
    void stopAndFlush().catch(() => {
      // The hook already exposes the failure through error/onError.
    });
  }, [stopAndFlush]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      recordingActiveRef.current = false;
      startingRef.current = false;
      startGenerationRef.current += 1;
      if (segmentTimerRef.current !== null) {
        clearTimeout(segmentTimerRef.current);
        segmentTimerRef.current = null;
      }
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
      recorderRef.current = null;
      recorderStopPromiseRef.current = null;
      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
      streamRef.current = null;
      onStreamRef.current?.(null);
    };
  }, []);

  return {
    status,
    isRecording: status === "recording",
    isFlushing,
    isSupported,
    error,
    start,
    stop,
    stopAndFlush,
  };
}
