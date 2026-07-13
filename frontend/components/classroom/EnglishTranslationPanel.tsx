"use client";

import type { TranslationLine } from "@/lib/types";

interface EnglishTranslationPanelProps {
  lines: TranslationLine[];
  isReviewing?: boolean;
}

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

export function EnglishTranslationPanel({
  lines,
  isReviewing = false,
}: EnglishTranslationPanelProps) {
  // Newest first, pinned to the TOP edge nearest the masthead (no auto-scroll).
  const newestFirst = [...lines].reverse();
  const count = String(lines.filter((line) => line.isFinal).length).padStart(2, "0");
  const latestCommitted = [...lines].reverse().find((line) => line.isFinal);

  return (
    <section
      aria-label="English translation"
      className="relative flex h-full overflow-hidden bg-en-wash"
    >
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {latestCommitted?.translatedText ?? ""}
      </p>
      {isReviewing && (
        <p className="sr-only" aria-live="polite">
          Checking translation.
        </p>
      )}
      <div className="live-transcript-content flex-1 overflow-y-auto px-4 py-4">
        {isReviewing && (
          <div
            aria-hidden="true"
            className="mb-3 flex min-h-9 items-center gap-2 text-clay-600"
          >
            <span className="h-2.5 w-2.5 shrink-0 animate-pulse bg-clay-600" />
            <span className="font-display text-xs font-extrabold uppercase">
              Checking translation
            </span>
          </div>
        )}
        {lines.length === 0 && !isReviewing ? (
          <p className="live-transcript-empty pt-10 font-display text-sm font-extrabold uppercase tracking-wide text-ink-faint">
            English translation appears here as you speak.
          </p>
        ) : lines.length > 0 ? (
          <div className="flex flex-col gap-3">
            {newestFirst.map((line, i) => (
              <div key={line.id} className="teleprompter-line">
                <p
                  className={`font-semibold leading-snug ${lineSize(i)} ${lineColor(i, line.isFinal)}`}
                >
                  {line.translatedText}
                </p>
                {line.sourceText && i <= 2 && (
                  <p
                    lang="th"
                    className="mt-0.5 font-thai text-sm text-ink-faint"
                  >
                    {line.sourceText}
                  </p>
                )}
                {line.latencyMs != null && (
                  <p className="mt-0.5 font-display text-[0.65rem] font-bold uppercase tracking-wide tabular-nums text-clay-600/70">
                    ⚡ {(line.latencyMs / 1000).toFixed(1)}s
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Vertical "ENGLISH" masthead pinned to the OUTER (right) edge + counter. */}
      <div className="live-language-masthead flex shrink-0 flex-col items-center justify-between border-l border-clay-600/20 px-1.5 py-4">
        <span className="live-masthead-long masthead-vertical font-display text-xl text-clay-600 landscape:text-[clamp(1.75rem,6vw,3rem)]">
          ENGLISH
        </span>
        <span className="live-masthead-short font-display text-xs font-black text-clay-600">
          EN
        </span>
        <span className="font-display text-lg font-black tabular-nums text-clay-600/70 landscape:text-2xl">
          {count}
        </span>
      </div>
    </section>
  );
}

export default EnglishTranslationPanel;
