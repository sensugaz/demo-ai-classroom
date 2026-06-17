"use client";

import type { TranscriptLine } from "@/lib/types";

interface LiveThaiTranscriptProps {
  lines: TranscriptLine[];
}

// Teleprompter scale: newest line largest, older lines step down. Thai never
// shrinks below text-lg (hard legibility constraint).
function lineSize(i: number): string {
  if (i === 0) return "text-3xl landscape:text-[clamp(1.5rem,3vw,2.25rem)]";
  if (i === 1) return "text-2xl";
  if (i === 2) return "text-xl";
  return "text-lg";
}
function lineColor(i: number, isFinal: boolean): string {
  if (!isFinal) return "text-ink-soft italic";
  if (i === 0) return "text-ink";
  if (i <= 2) return "text-ink-soft";
  return "text-ink-faint";
}

export function LiveThaiTranscript({ lines }: LiveThaiTranscriptProps) {
  // Newest first, pinned to the TOP edge nearest the masthead (no auto-scroll).
  const newestFirst = [...lines].reverse();
  const count = String(lines.length).padStart(2, "0");

  return (
    <section
      aria-label="Live Thai transcript"
      className="relative flex h-full overflow-hidden bg-th-wash"
    >
      {/* Vertical "THAI" masthead pinned to the left edge + line counter. */}
      <div className="flex shrink-0 flex-col items-center justify-between border-r border-brand-600/20 px-1.5 py-4">
        <span className="masthead-vertical font-display text-[clamp(1.75rem,6vw,3rem)] text-brand-600">
          THAI
        </span>
        <div className="flex flex-col items-center gap-1">
          <span lang="th" className="font-thai text-xs font-semibold text-brand-700">
            ไทย
          </span>
          <span className="font-display text-2xl font-black tabular-nums text-brand-600/70">
            {count}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        {lines.length === 0 ? (
          <p className="pt-10 font-display text-sm font-extrabold uppercase tracking-wide text-ink-faint">
            Tap the mic to start live Thai transcription.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {newestFirst.map((line, i) => (
              <p
                key={line.id}
                lang="th"
                className={`teleprompter-line font-thai font-medium leading-snug ${lineSize(i)} ${lineColor(i, line.isFinal)}`}
              >
                {line.text}
                {!line.isFinal && (
                  <span className="ml-1 align-middle text-xs not-italic text-ink-faint/70">
                    (interim)
                  </span>
                )}
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default LiveThaiTranscript;
