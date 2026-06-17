"use client";

import type { ClassroomVocabulary } from "@/lib/types";

interface VocabularyTableProps {
  vocabularies: ClassroomVocabulary[];
}

function difficultyClass(level: string): string {
  const normalized = level.trim().toLowerCase();
  if (normalized.includes("begin") || normalized.includes("easy") || normalized === "1") {
    return "bg-emerald-100 text-emerald-700 ring-emerald-600";
  }
  if (normalized.includes("inter") || normalized.includes("medium") || normalized === "2") {
    return "bg-amber-100 text-amber-700 ring-amber-600";
  }
  if (normalized.includes("adv") || normalized.includes("hard") || normalized === "3") {
    return "bg-rose-100 text-rose-700 ring-rose-600";
  }
  return "bg-canvas-soft text-ink-soft ring-line";
}

export function VocabularyTable({ vocabularies }: VocabularyTableProps) {
  if (vocabularies.length === 0) {
    return (
      <div className="rounded-none bg-surface p-10 text-center ring-1 ring-line">
        <p className="text-sm text-ink-faint">
          No vocabulary was generated for this session.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Table layout for medium+ screens. */}
      <div className="hidden overflow-hidden rounded-none bg-surface ring-1 ring-line md:block">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line-soft text-left text-sm">
            <caption className="sr-only">
              Vocabulary words from this classroom session
            </caption>
            <thead className="bg-ink font-display text-xs font-extrabold uppercase tracking-wide text-canvas">
              <tr>
                <th scope="col" className="px-5 py-3">
                  Word
                </th>
                <th scope="col" className="px-5 py-3">
                  Part of speech
                </th>
                <th scope="col" className="px-5 py-3">
                  Meaning
                </th>
                <th scope="col" className="px-5 py-3">
                  Example
                </th>
                <th scope="col" className="px-5 py-3">
                  Level
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {vocabularies.map((item, index) => (
                <tr key={`${item.word}-${index}`} className="align-top">
                  <td className="px-5 py-4 font-display font-extrabold text-ink">
                    {item.word}
                  </td>
                  <td className="px-5 py-4 text-ink-soft">
                    {item.partOfSpeech || "—"}
                  </td>
                  <td className="px-5 py-4">
                    <p className="text-ink">{item.meaningEn || "—"}</p>
                    {item.meaningTh && (
                      <p lang="th" className="mt-1 font-thai text-base text-ink-faint">
                        {item.meaningTh}
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {item.exampleSentenceEn ? (
                      <p className="text-ink-soft">{item.exampleSentenceEn}</p>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                    {item.exampleSentenceTh && (
                      <p lang="th" className="mt-1 font-thai text-base text-ink-faint">
                        {item.exampleSentenceTh}
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {item.difficultyLevel ? (
                      <span
                        className={`inline-flex rounded-none px-2.5 py-0.5 text-xs font-extrabold uppercase tracking-wide tabular-nums ring-1 ${difficultyClass(
                          item.difficultyLevel,
                        )}`}
                      >
                        {item.difficultyLevel}
                      </span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Card layout for small screens. */}
      <ul className="space-y-3 md:hidden">
        {vocabularies.map((item, index) => (
          <li
            key={`${item.word}-${index}`}
            className="rounded-none bg-surface p-5 ring-1 ring-line"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-display text-base font-extrabold text-ink">{item.word}</p>
                {item.partOfSpeech && (
                  <p className="text-xs text-ink-faint">{item.partOfSpeech}</p>
                )}
              </div>
              {item.difficultyLevel && (
                <span
                  className={`inline-flex shrink-0 rounded-none px-2.5 py-0.5 text-xs font-extrabold uppercase tracking-wide tabular-nums ring-1 ${difficultyClass(
                    item.difficultyLevel,
                  )}`}
                >
                  {item.difficultyLevel}
                </span>
              )}
            </div>
            <p className="mt-2 text-sm text-ink">{item.meaningEn || "—"}</p>
            {item.meaningTh && (
              <p lang="th" className="font-thai text-base text-ink-faint">
                {item.meaningTh}
              </p>
            )}
            {item.exampleSentenceEn && (
              <p className="mt-2 text-sm italic text-ink-soft">
                “{item.exampleSentenceEn}”
              </p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export default VocabularyTable;
