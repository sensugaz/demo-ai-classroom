"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { ClassroomSummary, UpdateSummaryRequest } from "@/lib/types";

interface SummaryPanelProps {
  summary: ClassroomSummary | null;
  processing?: boolean;
  onSave?: (draft: UpdateSummaryRequest) => Promise<ClassroomSummary>;
}

interface SummaryDraft {
  summaryEn: string;
  summaryTh: string;
  keyPointsEnText: string;
  keyPointsThText: string;
}

function listToText(items: string[]): string {
  return items.join("\n");
}

function textToList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function draftFromSummary(summary: ClassroomSummary | null): SummaryDraft {
  return {
    summaryEn: summary?.summaryEn ?? "",
    summaryTh: summary?.summaryTh ?? "",
    keyPointsEnText: listToText(summary?.keyPointsEn ?? []),
    keyPointsThText: listToText(summary?.keyPointsTh ?? []),
  };
}

function draftToRequest(draft: SummaryDraft): UpdateSummaryRequest {
  return {
    summaryEn: draft.summaryEn.trim(),
    summaryTh: draft.summaryTh.trim(),
    keyPointsEn: textToList(draft.keyPointsEnText),
    keyPointsTh: textToList(draft.keyPointsThText),
  };
}

function sameDraft(a: SummaryDraft, b: SummaryDraft): boolean {
  return (
    a.summaryEn === b.summaryEn &&
    a.summaryTh === b.summaryTh &&
    a.keyPointsEnText === b.keyPointsEnText &&
    a.keyPointsThText === b.keyPointsThText
  );
}

function EmptyText({ children }: { children: ReactNode }) {
  return (
    <p className="font-display text-sm font-extrabold uppercase tracking-wide text-ink-faint">
      {children}
    </p>
  );
}

export function SummaryPanel({
  summary,
  processing = false,
  onSave,
}: SummaryPanelProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<SummaryDraft>(() => draftFromSummary(summary));

  useEffect(() => {
    if (!editing) {
      setDraft(draftFromSummary(summary));
      setSaveError(null);
    }
  }, [editing, summary]);

  const originalDraft = useMemo(() => draftFromSummary(summary), [summary]);
  const dirty = !sameDraft(draft, originalDraft);
  const canEdit = Boolean(onSave);
  const requestDraft = draftToRequest(draft);
  const hasContent =
    requestDraft.summaryEn ||
    requestDraft.summaryTh ||
    requestDraft.keyPointsEn.length > 0 ||
    requestDraft.keyPointsTh.length > 0;

  if (!summary) {
    return (
      <div
        className="rounded-none bg-surface p-8 text-center ring-1 ring-line"
        aria-live="polite"
      >
        <p
          lang={processing ? "th" : undefined}
          className={`text-sm text-ink-faint ${
            processing
              ? "font-thai font-bold"
              : "font-display font-extrabold uppercase tracking-wide"
          }`}
        >
          {processing
            ? "โปรดรอผลการประมวลผล"
            : "No summary is available for this session yet."}
        </p>
      </div>
    );
  }

  const handleCancel = () => {
    setDraft(originalDraft);
    setEditing(false);
    setSaveError(null);
  };

  const handleSave = async () => {
    if (!onSave || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const updated = await onSave(requestDraft);
      setDraft(draftFromSummary(updated));
      setEditing(false);
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save summary.");
    } finally {
      setSaving(false);
    }
  };

  if (!hasContent && !editing && !canEdit) {
    return (
      <div className="rounded-none bg-surface p-8 text-center ring-1 ring-line">
        <EmptyText>The summary for this session is empty.</EmptyText>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-none bg-surface px-4 py-3 ring-1 ring-line">
          <div className="min-w-0">
            <p className="font-display text-xs font-extrabold uppercase tracking-wide text-ink">
              Teacher review
            </p>
            <p lang="th" className="font-thai text-sm text-ink-soft">
              ครูสามารถแก้สรุปก่อนส่งให้นักเรียนอ่านทบทวน
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={saving}
                  className="min-h-[40px] rounded-none px-3 font-display text-xs font-extrabold uppercase tracking-wide text-ink ring-1 ring-ink transition hover:bg-canvas-soft disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving || !dirty}
                  className="min-h-[40px] rounded-none bg-ink px-4 font-display text-xs font-extrabold uppercase tracking-wide text-canvas transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditing(true);
                  setSaved(false);
                }}
                className="min-h-[40px] rounded-none bg-ink px-4 font-display text-xs font-extrabold uppercase tracking-wide text-canvas transition hover:bg-brand-700"
              >
                Edit
              </button>
            )}
          </div>
          {(saveError || saved) && (
            <p
              role={saveError ? "alert" : "status"}
              className={`basis-full text-sm ${saveError ? "text-[#b3251f]" : "text-brand-700"}`}
            >
              {saveError ?? "Saved teacher edits."}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-none border-l-4 border-l-brand-600 bg-surface p-6 ring-1 ring-line">
          <p className="mb-1 font-display text-xs font-black uppercase tracking-wide text-brand-600">
            EN Summary
          </p>
          <h3 className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-wide text-ink">
            English Summary
          </h3>
          {editing ? (
            <textarea
              value={draft.summaryEn}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, summaryEn: event.target.value }))
              }
              rows={9}
              className="min-h-48 w-full resize-y rounded-none bg-canvas p-3 text-base leading-relaxed text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          ) : summary.summaryEn ? (
            <p className="whitespace-pre-wrap text-base leading-relaxed text-ink">
              {summary.summaryEn}
            </p>
          ) : (
            <EmptyText>Not available.</EmptyText>
          )}
        </article>

        <article className="rounded-none border-l-4 border-l-clay-600 bg-surface p-6 ring-1 ring-line">
          <p className="mb-1 font-display text-xs font-black uppercase tracking-wide text-clay-600">
            TH Summary
          </p>
          <h3 className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-wide text-ink">
            Thai Summary
          </h3>
          {editing ? (
            <textarea
              lang="th"
              value={draft.summaryTh}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, summaryTh: event.target.value }))
              }
              rows={9}
              className="min-h-48 w-full resize-y rounded-none bg-canvas p-3 font-thai text-base leading-relaxed text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-clay-600"
            />
          ) : summary.summaryTh ? (
            <p lang="th" className="whitespace-pre-wrap font-thai text-base leading-relaxed text-ink">
              {summary.summaryTh}
            </p>
          ) : (
            <EmptyText>Not available.</EmptyText>
          )}
        </article>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-none border-l-4 border-l-brand-600 bg-surface p-6 ring-1 ring-line">
          <h3 className="mb-3 font-display text-sm font-extrabold uppercase tracking-wide text-ink">
            Key Points (English)
          </h3>
          {editing ? (
            <textarea
              value={draft.keyPointsEnText}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, keyPointsEnText: event.target.value }))
              }
              rows={7}
              className="min-h-40 w-full resize-y rounded-none bg-canvas p-3 text-base leading-relaxed text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          ) : summary.keyPointsEn.length > 0 ? (
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
            <EmptyText>Not available.</EmptyText>
          )}
        </article>

        <article className="rounded-none border-l-4 border-l-clay-600 bg-surface p-6 ring-1 ring-line">
          <h3 className="mb-3 font-display text-sm font-extrabold uppercase tracking-wide text-ink">
            Key Points (Thai)
          </h3>
          {editing ? (
            <textarea
              lang="th"
              value={draft.keyPointsThText}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, keyPointsThText: event.target.value }))
              }
              rows={7}
              className="min-h-40 w-full resize-y rounded-none bg-canvas p-3 font-thai text-base leading-relaxed text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-clay-600"
            />
          ) : summary.keyPointsTh.length > 0 ? (
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
            <EmptyText>Not available.</EmptyText>
          )}
        </article>
      </div>
    </div>
  );
}

export default SummaryPanel;
