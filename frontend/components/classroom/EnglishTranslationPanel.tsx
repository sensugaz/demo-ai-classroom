"use client";

import type { TranslationLine } from "@/lib/types";

interface EnglishTranslationPanelProps {
  lines: TranslationLine[];
}

function lineSize(i: number): string {
  if (i === 0) return "text-3xl landscape:text-[clamp(1.5rem,3vw,2.25rem)]";
  if (i === 1) return "text-2xl";
  if (i === 2) return "text-xl";
  return "text-lg";
}
function lineColor(i: number): string {
  if (i === 0) return "text-ink";
  if (i <= 2) return "text-ink-soft";
  return "text-ink-faint";
}

export function EnglishTranslationPanel({
  lines,
}: EnglishTranslationPanelProps) {
  // Newest first, pinned to the TOP edge nearest the masthead (no auto-scroll).
  const newestFirst = [...lines].reverse();
  const count = String(lines.length).padStart(2, "0");

  return (
    <section
      aria-label="English translation"
      className="relative flex h-full overflow-hidden bg-en-wash"
    >
      <div className="flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        {lines.length === 0 ? (
          <p className="pt-10 font-display text-sm font-extrabold uppercase tracking-wide text-ink-faint">
            English translation appears here as you speak.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {newestFirst.map((line, i) => (
              <div key={line.id} className="teleprompter-line">
                <p
                  className={`font-semibold leading-snug ${lineSize(i)} ${lineColor(i)}`}
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
        )}
      </div>

      {/* Vertical "ENGLISH" masthead pinned to the OUTER (right) edge + counter. */}
      <div className="flex shrink-0 flex-col items-center justify-between border-l border-clay-600/20 px-1.5 py-4">
        <span className="masthead-vertical font-display text-[clamp(1.75rem,6vw,3rem)] text-clay-600">
          ENGLISH
        </span>
        <span className="font-display text-2xl font-black tabular-nums text-clay-600/70">
          {count}
        </span>
      </div>
    </section>
  );
}

export default EnglishTranslationPanel;
