"use client";

import type { ClassroomMessage } from "@/lib/types";

interface TranscriptTimelineProps {
  messages: ClassroomMessage[];
}

export function TranscriptTimeline({ messages }: TranscriptTimelineProps) {
  if (messages.length === 0) {
    return (
      <div className="rounded-none bg-surface p-10 text-center ring-1 ring-line">
        <p className="font-display text-sm font-extrabold uppercase tracking-wide text-ink-faint">
          No transcript was recorded for this session.
        </p>
      </div>
    );
  }

  // Defensive ordering by sequenceNo in case the API order ever changes.
  const ordered = [...messages].sort((a, b) => a.sequenceNo - b.sequenceNo);

  return (
    <>
      {/* Column legend so the side-by-side comparison reads clearly. */}
      <div className="mb-3 hidden items-center gap-6 px-1 font-display text-[0.7rem] font-extrabold uppercase tracking-wide sm:flex">
        <span className="flex items-center gap-2 text-brand-600">
          <span className="h-2.5 w-2.5 rounded-none bg-brand-600" aria-hidden="true" />
          Thai · th-TH
        </span>
        <span className="flex items-center gap-2 text-clay-600">
          <span className="h-2.5 w-2.5 rounded-none bg-clay-600" aria-hidden="true" />
          English · en-US
        </span>
      </div>

      <ol className="space-y-3">
        {ordered.map((message, index) => (
          <li
            key={`${message.sessionId}-${message.sequenceNo}-${index}`}
            className="overflow-hidden rounded-none bg-surface ring-1 ring-line"
          >
            {/* Meta strip: line number + STT confidence */}
            <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5 text-xs text-ink-faint">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-none bg-ink font-display text-xs font-black tabular-nums text-canvas">
                {message.sequenceNo + 1}
              </span>
              {typeof message.confidence === "number" && (
                <span className="font-display text-[0.7rem] font-extrabold uppercase tracking-wide text-ink-soft">
                  Confidence <span className="tabular-nums">{Math.round(message.confidence * 100)}%</span>
                </span>
              )}
            </div>

            {/* Bilingual comparison: Thai | English, 3px ink seam between */}
            <div className="grid gap-[3px] bg-seam sm:grid-cols-2">
              <div className="bg-th-wash px-4 py-4">
                <p className="mb-1.5 font-display text-[0.7rem] font-extrabold uppercase tracking-wide text-brand-600">
                  Thai
                </p>
                <p
                  lang="th"
                  className="font-thai text-base leading-relaxed text-ink-soft"
                >
                  {message.sourceText || "—"}
                </p>
              </div>
              <div className="bg-en-wash px-4 py-4">
                <p className="mb-1.5 font-display text-[0.7rem] font-extrabold uppercase tracking-wide text-clay-600">
                  English
                </p>
                <p className="text-base font-medium leading-relaxed text-ink">
                  {message.translatedText || "—"}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

export default TranscriptTimeline;
