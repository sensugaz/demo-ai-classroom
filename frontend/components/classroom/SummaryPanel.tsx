"use client";

import type { ClassroomSummary } from "@/lib/types";

interface SummaryPanelProps {
  summary: ClassroomSummary | null;
}

export function SummaryPanel({ summary }: SummaryPanelProps) {
  if (!summary) {
    return (
      <div className="rounded-none bg-surface p-8 text-center ring-1 ring-line">
        <p className="font-display text-sm font-extrabold uppercase tracking-wide text-ink-faint">
          No summary is available for this session yet.
        </p>
      </div>
    );
  }

  const hasContent =
    summary.summaryEn ||
    summary.summaryTh ||
    summary.keyPointsEn.length > 0 ||
    summary.keyPointsTh.length > 0;

  if (!hasContent) {
    return (
      <div className="rounded-none bg-surface p-8 text-center ring-1 ring-line">
        <p className="font-display text-sm font-extrabold uppercase tracking-wide text-ink-faint">
          The summary for this session is empty.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-none border-l-4 border-l-brand-600 bg-surface p-6 ring-1 ring-line">
          <p className="mb-1 font-display text-xs font-black uppercase tracking-wide text-brand-600">
            EN Summary
          </p>
          <h3 className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-wide text-ink">
            English Summary
          </h3>
          {summary.summaryEn ? (
            <p className="whitespace-pre-wrap text-base leading-relaxed text-ink">
              {summary.summaryEn}
            </p>
          ) : (
            <p className="font-display text-sm font-extrabold uppercase tracking-wide text-ink-faint">
              Not available.
            </p>
          )}
        </article>

        <article className="rounded-none border-l-4 border-l-clay-600 bg-surface p-6 ring-1 ring-line">
          <p className="mb-1 font-display text-xs font-black uppercase tracking-wide text-clay-600">
            TH Summary
          </p>
          <h3 className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-wide text-ink">
            Thai Summary
          </h3>
          {summary.summaryTh ? (
            <p lang="th" className="whitespace-pre-wrap font-thai text-base leading-relaxed text-ink">
              {summary.summaryTh}
            </p>
          ) : (
            <p className="font-display text-sm font-extrabold uppercase tracking-wide text-ink-faint">
              Not available.
            </p>
          )}
        </article>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-none border-l-4 border-l-brand-600 bg-surface p-6 ring-1 ring-line">
          <h3 className="mb-3 font-display text-sm font-extrabold uppercase tracking-wide text-ink">
            Key Points (English)
          </h3>
          {summary.keyPointsEn.length > 0 ? (
            <ul className="space-y-2.5">
              {summary.keyPointsEn.map((point, index) => (
                <li
                  key={`${index}-${point.slice(0, 12)}`}
                  className="flex gap-2.5 text-base leading-relaxed text-ink-soft"
                >
                  <span
                    className="mt-2 inline-block h-1.5 w-1.5 shrink-0 bg-ink"
                    aria-hidden="true"
                  />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="font-display text-sm font-extrabold uppercase tracking-wide text-ink-faint">
              Not available.
            </p>
          )}
        </article>

        <article className="rounded-none border-l-4 border-l-clay-600 bg-surface p-6 ring-1 ring-line">
          <h3 className="mb-3 font-display text-sm font-extrabold uppercase tracking-wide text-ink">
            Key Points (Thai)
          </h3>
          {summary.keyPointsTh.length > 0 ? (
            <ul className="space-y-2.5">
              {summary.keyPointsTh.map((point, index) => (
                <li
                  key={`${index}-${point.slice(0, 12)}`}
                  lang="th"
                  className="flex gap-2.5 font-thai text-base leading-relaxed text-ink-soft"
                >
                  <span
                    className="mt-2 inline-block h-1.5 w-1.5 shrink-0 bg-ink"
                    aria-hidden="true"
                  />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="font-display text-sm font-extrabold uppercase tracking-wide text-ink-faint">
              Not available.
            </p>
          )}
        </article>
      </div>
    </div>
  );
}

export default SummaryPanel;
