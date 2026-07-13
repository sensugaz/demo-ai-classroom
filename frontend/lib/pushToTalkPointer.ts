interface PointerCaptureTarget {
  hasPointerCapture(pointerId: number): boolean;
  releasePointerCapture(pointerId: number): void;
  setPointerCapture(pointerId: number): void;
}

/**
 * Pointer capture keeps mouse/stylus releases attached to the HOLD button, but
 * touch browsers may already provide implicit capture and Safari can reject an
 * explicit capture request. Starting the hold must never depend on capture.
 */
export function beginPointerHold(
  target: PointerCaptureTarget,
  pointerId: number,
  onBegin: () => void,
): void {
  onBegin();
  try {
    if (!target.hasPointerCapture(pointerId)) {
      target.setPointerCapture(pointerId);
    }
  } catch {
    // Pointer capture is best-effort; pointerup/cancel still end the hold.
  }
}

/** End the hold before releasing capture so a Safari release error cannot strand it. */
export function endPointerHold(
  target: PointerCaptureTarget,
  pointerId: number,
  onEnd: () => void,
): void {
  onEnd();
  try {
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  } catch {
    // The browser may have implicitly released capture before pointerup arrives.
  }
}
