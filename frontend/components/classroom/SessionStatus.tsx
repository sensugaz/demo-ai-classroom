"use client";

import type { PipelineStatus } from "@/lib/types";

interface StatusWord {
  word: string;
  color: string;
  dot: string;
}

// Collapsed single-word pipeline state — readable across a room in one glance.
// Connection state lives in the top bar; recording reads from the mic ring.
export const PIPELINE_WORD: Record<PipelineStatus, StatusWord> = {
  idle: { word: "READY", color: "text-ink-faint", dot: "bg-ink-faint" },
  listening: { word: "LISTENING", color: "text-brand-600", dot: "bg-brand-600" },
  transcribing: { word: "HEARING", color: "text-brand-500", dot: "bg-brand-400" },
  translating: { word: "TRANSLATING", color: "text-brand-600", dot: "bg-brand-600" },
  speaking: { word: "SPEAKING", color: "text-clay-600", dot: "bg-clay-600" },
  processing: { word: "WRAPPING UP", color: "text-[#c98a18]", dot: "bg-[#c98a18]" },
  completed: { word: "DONE", color: "text-brand-700", dot: "bg-brand-700" },
  error: { word: "CHECK MIC", color: "text-[#b3251f]", dot: "bg-[#b3251f]" },
};

interface SessionStatusProps {
  pipelineStatus: PipelineStatus;
}

export function SessionStatus({ pipelineStatus }: SessionStatusProps) {
  const s = PIPELINE_WORD[pipelineStatus] ?? PIPELINE_WORD.idle;
  return (
    <div role="status" aria-live="polite" className="inline-flex items-center gap-2">
      <span
        className={`h-2.5 w-2.5 shrink-0 rounded-none ${s.dot}`}
        aria-hidden="true"
      />
      <span
        className={`font-display text-[clamp(1rem,2.2vw,1.6rem)] font-black uppercase leading-none tracking-tight tabular-nums ${s.color}`}
      >
        {s.word}
      </span>
    </div>
  );
}

export default SessionStatus;
