"use client";

import Link from "next/link";
import { useEffect } from "react";

import StartSessionForm from "@/components/classroom/StartSessionForm";
import { useClassroomSession } from "@/hooks/useClassroomSession";
import type { ClassroomSession, SessionStatus } from "@/lib/types";

// Left status spine color per session state (4px left border).
const STATUS_BORDER: Record<SessionStatus, string> = {
  active: "border-l-brand-600",
  processing: "border-l-[#c98a18]",
  completed: "border-l-brand-700",
  failed: "border-l-[#b3251f]",
};

function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sessionHref(session: ClassroomSession): string {
  const id = encodeURIComponent(session.sessionId);
  // Active/processing sessions go live; finished ones go to results.
  if (session.status === "active") {
    return `/classroom/${id}/live`;
  }
  return `/classroom/${id}/result`;
}

export default function ClassroomPage() {
  const {
    createSession,
    createLoading,
    createError,
    sessions,
    refreshSessions,
    listLoading,
    listError,
  } = useClassroomSession();

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const visibleSessions = sessions.filter(
    (session) => session.status === "completed",
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 sm:py-14">
      <header className="mb-10">
        <Link
          href="/"
          className="inline-flex min-h-[44px] items-center font-display text-sm font-extrabold uppercase tracking-wide text-brand-600 transition hover:text-brand-700"
        >
          ← Home
        </Link>
        <h1 className="mt-3 font-display text-[clamp(1.75rem,6vw,3rem)] font-black uppercase tracking-wide text-ink">
          Classroom
        </h1>
        <p className="mt-1.5 text-ink-soft">
          Start a live Thai-to-English class or revisit a previous session.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <StartSessionForm
          onCreate={createSession}
          loading={createLoading}
          error={createError}
        />

        <section aria-label="Recent sessions" className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-extrabold uppercase tracking-wide text-ink">
              Recent sessions
            </h2>
            <button
              type="button"
              onClick={() => void refreshSessions()}
              disabled={listLoading}
              className="min-h-[44px] rounded-none px-4 py-1.5 font-display text-sm font-extrabold uppercase tracking-wide text-ink ring-1 ring-line transition hover:bg-canvas-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60"
            >
              {listLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {listError && (
            <p
              role="alert"
              className="rounded-none bg-en-wash px-3.5 py-2.5 text-sm text-[#b3251f] ring-1 ring-[#b3251f]"
            >
              {listError}
            </p>
          )}

          {listLoading && visibleSessions.length === 0 ? (
            <ul className="space-y-3" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <li
                  key={i}
                  className="h-20 animate-pulse rounded-none bg-surface ring-1 ring-line"
                />
              ))}
            </ul>
          ) : visibleSessions.length === 0 ? (
            <div className="rounded-none bg-surface p-8 text-center ring-1 ring-line">
              <p className="text-sm text-ink-faint">
                No completed sessions yet. Start a class on the left, then end
                it to review the results here.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {visibleSessions.map((session) => (
                <li key={session.sessionId}>
                  <Link
                    href={sessionHref(session)}
                    className={`block rounded-none border-l-4 bg-surface p-5 ring-1 ring-line transition hover:bg-canvas-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                      STATUS_BORDER[session.status] ?? "border-l-line"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-display text-base font-extrabold uppercase tracking-wide text-ink">
                          {session.classroomName || "Untitled classroom"}
                        </p>
                        <p className="truncate text-sm text-ink-soft">
                          {session.speakerName || "Unknown speaker"}
                        </p>
                      </div>
                      <span
                        className="shrink-0 rounded-none px-2.5 py-0.5 font-display text-xs font-extrabold uppercase tracking-wide text-ink ring-1 ring-ink"
                      >
                        {session.status}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-3 text-xs uppercase tracking-wide text-ink-faint">
                      <span>th-TH → en-US</span>
                      {formatDate(session.createdAt ?? session.startedAt) && (
                        <span className="tabular-nums">
                          {formatDate(session.createdAt ?? session.startedAt)}
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
