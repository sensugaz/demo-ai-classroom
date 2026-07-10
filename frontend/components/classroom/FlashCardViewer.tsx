"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";

import type { ClassroomFlashcard, FlashcardType } from "@/lib/types";

interface FlashCardViewerProps {
  flashcards: ClassroomFlashcard[];
  imagesPending?: boolean;
}

type FilterValue = "all" | FlashcardType;

const FILTERS: ReadonlyArray<{ value: FilterValue; label: string }> = [
  { value: "all", label: "All" },
  { value: "vocabulary", label: "Vocabulary" },
  { value: "sentence", label: "Sentence" },
  { value: "grammar", label: "Grammar" },
];

const TYPE_BADGE: Record<FlashcardType, string> = {
  vocabulary: "bg-brand-50 text-brand-600 ring-brand-600",
  sentence: "bg-en-wash text-ink ring-ink",
  grammar: "bg-clay-50 text-clay-600 ring-clay-600",
};

export function FlashCardViewer({
  flashcards,
  imagesPending = false,
}: FlashCardViewerProps) {
  const [filter, setFilter] = useState<FilterValue>("all");
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const filtered = useMemo(() => {
    if (filter === "all") return flashcards;
    return flashcards.filter((card) => card.type === filter);
  }, [flashcards, filter]);

  // Reset position whenever the filtered set changes.
  useEffect(() => {
    setIndex(0);
    setFlipped(false);
  }, [filter]);

  // Keep index in range if the data set shrinks.
  useEffect(() => {
    if (index > filtered.length - 1) {
      setIndex(filtered.length > 0 ? filtered.length - 1 : 0);
    }
  }, [filtered.length, index]);

  if (flashcards.length === 0) {
    return (
      <div className="rounded-none bg-surface p-8 text-center ring-1 ring-line">
        <p className="text-sm text-ink-faint">
          No flash cards were generated for this session.
        </p>
      </div>
    );
  }

  const goPrev = () => {
    setFlipped(false);
    setIndex((i) => (i - 1 + filtered.length) % filtered.length);
  };

  const goNext = () => {
    setFlipped(false);
    setIndex((i) => (i + 1) % filtered.length);
  };

  const current = filtered[index];

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goPrev();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      goNext();
    }
  };

  return (
    <div className="space-y-5">
      {imagesPending && (
        <div className="bg-en-wash px-4 py-2.5 text-sm font-medium text-ink ring-1 ring-ink/15">
          <span lang="th" className="font-thai">
            กำลังสร้างรูปภาพสำหรับแฟลชการ์ด ระบบจะแสดงรูปให้อัตโนมัติเมื่อพร้อม
          </span>
        </div>
      )}

      {/* Filter chips */}
      <div
        role="tablist"
        aria-label="Filter flash cards by type"
        className="flex flex-wrap gap-2"
      >
        {FILTERS.map((option) => {
          const active = filter === option.value;
          const count =
            option.value === "all"
              ? flashcards.length
              : flashcards.filter((c) => c.type === option.value).length;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(option.value)}
              className={`min-h-[44px] rounded-none px-4 py-2 font-display text-sm font-extrabold uppercase tracking-wide transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                active
                  ? "bg-ink text-canvas"
                  : "text-ink-soft ring-1 ring-ink hover:bg-canvas-soft"
              }`}
            >
              {option.label}
              <span
                className={`ml-1.5 text-xs tabular-nums ${
                  active ? "text-canvas" : "text-ink-faint"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {!current ? (
        <div className="rounded-none bg-surface p-8 text-center ring-1 ring-line">
          <p className="text-sm text-ink-faint">
            No flash cards match this filter.
          </p>
        </div>
      ) : (
        <>
          {/* Flip card */}
          <button
            type="button"
            onClick={() => setFlipped((f) => !f)}
            onKeyDown={handleCardKeyDown}
            aria-label={
              flipped
                ? "Showing back of card. Activate to flip to front."
                : "Showing front of card. Activate to flip to back."
            }
            aria-pressed={flipped}
            className="group relative block h-[clamp(24rem,56svh,34rem)] min-h-[28rem] w-full [perspective:1200px] focus:outline-none"
          >
            <div
              className={`relative h-full w-full rounded-none transition-transform duration-500 [transform-style:preserve-3d] group-focus-visible:ring-2 group-focus-visible:ring-brand-600 group-focus-visible:ring-offset-2 ${
                flipped ? "[transform:rotateY(180deg)]" : ""
              }`}
            >
              {/* Front */}
              <div className="absolute inset-0 grid grid-rows-[auto_minmax(0,1fr)_auto_auto] gap-3 rounded-none border-t-4 border-brand-600 bg-surface p-5 text-center ring-1 ring-line [backface-visibility:hidden] md:p-6">
                <div className="flex items-center justify-between gap-3">
                  <span
                    className={`rounded-none px-2.5 py-0.5 font-display text-xs font-extrabold uppercase tracking-wide ring-1 ${TYPE_BADGE[current.type] ?? "bg-canvas-soft text-ink-soft ring-line"}`}
                  >
                    {current.type}
                  </span>
                  <span className="font-display text-[0.65rem] font-extrabold uppercase tracking-wide text-ink-faint">
                    Image
                  </span>
                </div>

                <div className="relative min-h-0 w-full overflow-hidden bg-canvas-soft/40">
                  {current.imageUrl ? (
                    <Image
                      src={current.imageUrl}
                      alt={current.word || current.front}
                      fill
                      sizes="(max-width: 768px) 92vw, 840px"
                      unoptimized
                      className="object-contain p-3 md:p-5"
                    />
                  ) : (
                    <div className="grid h-full place-items-center px-6">
                      <p className="break-words text-[clamp(1.75rem,7vw,3.25rem)] font-extrabold leading-tight text-ink">
                        {current.front}
                      </p>
                    </div>
                  )}
                </div>

                <div className="min-h-[4.25rem] max-w-full overflow-hidden px-2">
                  <p className="break-words font-display text-[clamp(1.2rem,4vw,2rem)] font-extrabold leading-tight text-ink">
                    {current.word || current.front}
                  </p>
                  {current.hintTh && (
                    <p lang="th" className="mt-1 max-h-12 overflow-hidden font-thai text-sm leading-relaxed text-ink-soft">
                      {current.hintTh}
                    </p>
                  )}
                </div>

                <span className="font-display text-xs font-extrabold uppercase tracking-wide text-ink-faint">
                  Tap to flip
                </span>
              </div>

              {/* Back */}
              <div className="absolute inset-0 grid grid-rows-[auto_minmax(0,1fr)_auto] gap-4 rounded-none bg-brand-600 p-6 text-center text-canvas [backface-visibility:hidden] [transform:rotateY(180deg)] md:p-8">
                <div className="flex items-center justify-between gap-3">
                  <span className="rounded-none px-2.5 py-0.5 font-display text-xs font-extrabold uppercase tracking-wide ring-1 ring-canvas/40">
                    {current.type}
                  </span>
                  <span className="font-display text-[0.65rem] font-extrabold uppercase tracking-wide text-canvas/80">
                    English
                  </span>
                </div>

                <div className="min-h-0 overflow-y-auto px-1">
                  <p className="break-words text-[clamp(2rem,7vw,4rem)] font-extrabold leading-tight">
                    {current.word || current.front}
                  </p>
                  <p className="mx-auto mt-4 max-w-2xl whitespace-pre-wrap break-words text-base font-semibold leading-relaxed text-canvas md:text-lg">
                    {current.back}
                  </p>
                  {current.exampleSentence && (
                    <p className="mx-auto mt-4 max-w-2xl break-words text-sm italic leading-relaxed text-canvas/85 md:text-base">
                      “{current.exampleSentence}”
                    </p>
                  )}
                  {current.hintTh && (
                    <p lang="th" className="mx-auto mt-4 max-w-2xl break-words font-thai text-sm leading-relaxed text-canvas/80">
                      {current.hintTh}
                    </p>
                  )}
                </div>

                <span className="font-display text-xs font-extrabold uppercase tracking-wide text-canvas/85">
                  Tap to flip
                </span>
              </div>
            </div>
          </button>

          {/* Controls */}
          <div className="flex items-center justify-between gap-4">
            <button
              type="button"
              onClick={goPrev}
              disabled={filtered.length <= 1}
              className="inline-flex min-h-[48px] items-center gap-1.5 rounded-none px-4 py-2 font-display text-sm font-extrabold uppercase tracking-wide text-ink-soft ring-1 ring-ink transition hover:bg-canvas-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true">←</span> Prev
            </button>

            <p
              className="text-sm font-extrabold tabular-nums text-ink-soft"
              aria-live="polite"
            >
              {index + 1} / {filtered.length}
            </p>

            <button
              type="button"
              onClick={goNext}
              disabled={filtered.length <= 1}
              className="inline-flex min-h-[48px] items-center gap-1.5 rounded-none px-4 py-2 font-display text-sm font-extrabold uppercase tracking-wide text-ink-soft ring-1 ring-ink transition hover:bg-canvas-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next <span aria-hidden="true">→</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default FlashCardViewer;
