"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import FlashCardViewer from "@/components/classroom/FlashCardViewer";
import SummaryPanel from "@/components/classroom/SummaryPanel";
import TranscriptTimeline from "@/components/classroom/TranscriptTimeline";
import VocabularyTable from "@/components/classroom/VocabularyTable";
import { useClassroomSession } from "@/hooks/useClassroomSession";
import type {
  ClassroomFlashcard,
  ClassroomMessage,
  ClassroomSession,
  ClassroomSummary,
  ClassroomVocabulary,
} from "@/lib/types";

type TabKey = "summary" | "transcript" | "vocabulary" | "flashcards";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "summary", label: "Summary" },
  { key: "transcript", label: "Transcript" },
  { key: "vocabulary", label: "Vocabulary" },
  { key: "flashcards", label: "Flash Cards" },
];

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong while loading this session.";
}

export default function ResultPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params?.sessionId ?? "";

  const {
    getSession,
    getMessages,
    getSummary,
    updateSummary,
    getVocabularies,
    getFlashcards,
  } = useClassroomSession();

  const [activeTab, setActiveTab] = useState<TabKey>("summary");

  const [session, setSession] = useState<ClassroomSession | null>(null);
  const [messages, setMessages] = useState<ClassroomMessage[]>([]);
  const [summary, setSummary] = useState<ClassroomSummary | null>(null);
  const [vocabularies, setVocabularies] = useState<ClassroomVocabulary[]>([]);
  const [flashcards, setFlashcards] = useState<ClassroomFlashcard[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const imagePollAttemptsRef = useRef(0);

  const load = useCallback(async (silent = false) => {
    if (!sessionId) return;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const sessionResult = await getSession(sessionId);
      setSession(sessionResult);

      const [messagesR, summaryR, vocabR, flashR] = await Promise.allSettled([
        getMessages(sessionId),
        getSummary(sessionId),
        getVocabularies(sessionId),
        getFlashcards(sessionId),
      ]);

      setMessages(messagesR.status === "fulfilled" ? messagesR.value : []);
      setSummary(summaryR.status === "fulfilled" ? summaryR.value : null);
      setVocabularies(vocabR.status === "fulfilled" ? vocabR.value : []);
      setFlashcards(flashR.status === "fulfilled" ? flashR.value : []);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(toMessage(cause));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [
    sessionId,
    getSession,
    getMessages,
    getSummary,
    getVocabularies,
    getFlashcards,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    imagePollAttemptsRef.current = 0;
  }, [sessionId]);

  const hasPendingFlashcardImages = useMemo(
    () =>
      flashcards.some(
        (card) =>
          card.type === "vocabulary" &&
          (card.imageStatus === "pending" ||
            (!card.imageStatus && !card.imageUrl)),
      ),
    [flashcards],
  );
  const sessionStatus = session?.status;
  const shouldShowImagePending =
    hasPendingFlashcardImages && imagePollAttemptsRef.current < 30;

  // Finalize and flashcard images run on the server. Poll quietly (no skeleton
  // flash) until text artifacts are done, then continue briefly for images.
  useEffect(() => {
    if (!sessionStatus) return;
    if (sessionStatus === "failed") return;

    const waitingForArtifacts = sessionStatus !== "completed";
    const waitingForImages =
      sessionStatus === "completed" &&
      hasPendingFlashcardImages &&
      imagePollAttemptsRef.current < 30;
    if (!waitingForArtifacts && !waitingForImages) return;

    let attempts = 0;
    const id = setInterval(() => {
      attempts += 1;
      if (waitingForImages) {
        imagePollAttemptsRef.current += 1;
      }
      if (attempts > 45) {
        clearInterval(id);
        return;
      }
      void load(true);
    }, 4000);
    return () => clearInterval(id);
  }, [sessionStatus, hasPendingFlashcardImages, load]);

  const isProcessing = sessionStatus === "processing";

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-10">
      <header className="mb-8 animate-rise">
        <Link
          href="/classroom"
          className="inline-flex items-center gap-1.5 font-display text-xs font-extrabold uppercase tracking-wide text-brand-700 transition hover:text-brand-800"
        >
          <span aria-hidden="true">←</span> All sessions
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {loading && !session ? (
              <div className="h-9 w-64 animate-pulse rounded-none bg-line" />
            ) : (
              <h1 className="truncate font-display text-[clamp(1.75rem,5vw,3rem)] font-black uppercase tracking-tight text-ink">
                {session?.classroomName ?? "Class results"}
              </h1>
            )}
            <p className="mt-1.5 font-display text-xs font-extrabold uppercase tracking-wide text-ink-faint">
              {session?.speakerName ? `${session.speakerName} · ` : ""}
              th-TH → en-US
            </p>
          </div>
          {session && (
            <span className="rounded-none px-3 py-1 font-display text-xs font-extrabold uppercase tracking-wide text-ink ring-2 ring-ink">
              {session.status}
            </span>
          )}
        </div>
      </header>

      {error && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 bg-[#b3251f] px-4 py-2.5 text-sm font-medium text-canvas">
          <span role="alert">{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="min-h-[36px] rounded-none bg-ink px-3 font-display text-xs font-extrabold uppercase tracking-wide text-canvas"
          >
            Retry
          </button>
        </div>
      )}

      {isProcessing && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 bg-[#c98a18] px-4 py-2.5 text-sm font-medium text-canvas">
          <span lang="th" className="font-thai">
            โปรดรอผลการประมวลผล สรุป คำศัพท์ และแฟลชการ์ดอาจยังไม่พร้อม
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="min-h-[36px] rounded-none bg-ink px-3 font-display text-xs font-extrabold uppercase tracking-wide text-canvas"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Signage tab rail: 4 butted slabs separated by ink hairlines. */}
      <div
        role="tablist"
        aria-label="Session results"
        className="mb-6 grid grid-cols-2 gap-px bg-ink ring-1 ring-ink sm:grid-cols-4"
      >
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`tab-${tab.key}`}
              aria-selected={active}
              aria-controls={`panel-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
              className={`min-h-[48px] border-b-[3px] font-display text-sm font-extrabold uppercase tracking-wide transition md:text-base ${
                active
                  ? "border-ink bg-ink text-canvas"
                  : "border-transparent bg-canvas text-ink-soft hover:bg-canvas-soft hover:border-brand-600 focus-visible:border-brand-600"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="space-y-3" aria-hidden="true">
          <div className="h-32 animate-pulse rounded-none bg-surface ring-1 ring-line" />
          <div className="h-32 animate-pulse rounded-none bg-surface ring-1 ring-line" />
        </div>
      ) : (
        <div className="animate-rise">
          <section
            role="tabpanel"
            id="panel-summary"
            aria-labelledby="tab-summary"
            hidden={activeTab !== "summary"}
          >
            {activeTab === "summary" && (
              <SummaryPanel
                summary={summary}
                processing={isProcessing}
                onSave={async (draft) => {
                  const updated = await updateSummary(sessionId, draft);
                  setSummary(updated);
                  return updated;
                }}
              />
            )}
          </section>

          <section
            role="tabpanel"
            id="panel-transcript"
            aria-labelledby="tab-transcript"
            hidden={activeTab !== "transcript"}
          >
            {activeTab === "transcript" && (
              <TranscriptTimeline messages={messages} />
            )}
          </section>

          <section
            role="tabpanel"
            id="panel-vocabulary"
            aria-labelledby="tab-vocabulary"
            hidden={activeTab !== "vocabulary"}
          >
            {activeTab === "vocabulary" && (
              <VocabularyTable vocabularies={vocabularies} />
            )}
          </section>

          <section
            role="tabpanel"
            id="panel-flashcards"
            aria-labelledby="tab-flashcards"
            hidden={activeTab !== "flashcards"}
          >
            {activeTab === "flashcards" && (
              <FlashCardViewer
                flashcards={flashcards}
                imagesPending={shouldShowImagePending}
              />
            )}
          </section>
        </div>
      )}
    </main>
  );
}
