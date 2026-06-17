"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ClassroomSession, CreateSessionRequest } from "@/lib/types";

interface StartSessionFormProps {
  onCreate: (payload: CreateSessionRequest) => Promise<ClassroomSession | null>;
  loading: boolean;
  error: string | null;
}

export function StartSessionForm({
  onCreate,
  loading,
  error,
}: StartSessionFormProps) {
  const router = useRouter();
  const [classroomName, setClassroomName] = useState("");
  const [speakerName, setSpeakerName] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError(null);

    const trimmedClassroom = classroomName.trim();
    const trimmedSpeaker = speakerName.trim();

    if (!trimmedClassroom || !trimmedSpeaker) {
      setValidationError("Please enter both a classroom name and a speaker name.");
      return;
    }

    const session = await onCreate({
      classroomName: trimmedClassroom,
      speakerName: trimmedSpeaker,
    });

    if (session?.sessionId) {
      router.push(`/classroom/${encodeURIComponent(session.sessionId)}/live`);
    }
  };

  const disabled = loading;
  const shownError = validationError ?? error;

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-5 rounded-none bg-surface p-6 ring-1 ring-line"
      noValidate
    >
      <div>
        <h2 className="font-display text-lg font-extrabold uppercase tracking-wide text-ink">
          Start a new class
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Thai is transcribed and translated to English in real time.
        </p>
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="classroomName"
          className="block font-display text-sm font-extrabold uppercase tracking-wide text-ink-soft"
        >
          Classroom name
        </label>
        <input
          id="classroomName"
          name="classroomName"
          type="text"
          value={classroomName}
          onChange={(e) => setClassroomName(e.target.value)}
          placeholder="e.g. English for Beginners — Room 204"
          autoComplete="off"
          disabled={disabled}
          required
          className="min-h-[48px] w-full rounded-none border border-line bg-surface px-3.5 py-2.5 text-sm text-ink transition placeholder:text-ink-faint focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-canvas-soft"
        />
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="speakerName"
          className="block font-display text-sm font-extrabold uppercase tracking-wide text-ink-soft"
        >
          Speaker name
        </label>
        <input
          id="speakerName"
          name="speakerName"
          type="text"
          value={speakerName}
          onChange={(e) => setSpeakerName(e.target.value)}
          placeholder="e.g. Khun Somchai"
          autoComplete="off"
          disabled={disabled}
          required
          className="min-h-[48px] w-full rounded-none border border-line bg-surface px-3.5 py-2.5 text-sm text-ink transition placeholder:text-ink-faint focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-canvas-soft"
        />
      </div>

      <div className="space-y-1.5">
        <p className="font-display text-[0.7rem] font-extrabold uppercase tracking-wide text-ink-faint">
          Translation
        </p>
        <div className="flex items-stretch overflow-hidden rounded-none ring-1 ring-line">
          {/* Source — Thai (teal rail) */}
          <div className="flex-1 border-l-4 border-brand-600 bg-th-wash px-4 py-3">
            <p className="font-display text-[0.65rem] font-extrabold uppercase tracking-wide text-brand-600">
              Source
            </p>
            <p className="font-display text-base font-black uppercase leading-tight text-ink">
              Thai
            </p>
            <p lang="th" className="font-thai text-sm text-ink-soft">
              ภาษาไทย · th-TH
            </p>
          </div>
          {/* Flow connector */}
          <div
            className="grid w-11 shrink-0 place-items-center bg-ink text-canvas"
            aria-hidden="true"
          >
            <span className="text-xl font-black">→</span>
          </div>
          {/* Target — English (clay rail) */}
          <div className="flex-1 border-r-4 border-clay-600 bg-en-wash px-4 py-3 text-right">
            <p className="font-display text-[0.65rem] font-extrabold uppercase tracking-wide text-clay-600">
              Target
            </p>
            <p className="font-display text-base font-black uppercase leading-tight text-ink">
              English
            </p>
            <p className="text-sm text-ink-soft">en-US</p>
          </div>
        </div>
      </div>

      {shownError && (
        <p
          role="alert"
          className="rounded-none bg-clay-50 px-3.5 py-2.5 text-sm text-clay-600 ring-1 ring-clay-600"
        >
          {shownError}
        </p>
      )}

      <button
        type="submit"
        disabled={disabled}
        className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-none bg-ink px-5 py-3 font-display text-sm font-extrabold uppercase tracking-wide text-canvas transition hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? (
          <>
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-canvas/40 border-t-canvas"
              aria-hidden="true"
            />
            Creating…
          </>
        ) : (
          "Start class"
        )}
      </button>
    </form>
  );
}

export default StartSessionForm;
