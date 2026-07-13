"use client";

import type {
  PhraseJourneySelection,
  PhraseJourneyStatus,
} from "@/lib/phraseJourney";

interface PhraseJourneyProps {
  journey: PhraseJourneySelection;
}

const STEPS = [
  { th: "ฟัง", en: "HEAR" },
  { th: "ตรวจ", en: "CHECK" },
  { th: "บันทึก", en: "SAVE" },
  { th: "สร้างเสียง", en: "VOICE" },
  { th: "เล่น", en: "PLAY" },
] as const;

const MESSAGES: Record<PhraseJourneyStatus, { th: string; en: string }> = {
  ready: { th: "พร้อมพูด", en: "Ready to speak" },
  listening: { th: "กำลังฟัง", en: "Listening" },
  finalizing: { th: "กำลังเก็บคำพูดให้ครบ", en: "Finishing the phrase" },
  queued: { th: "กำลังส่งประโยค", en: "Sending the phrase" },
  reviewing: { th: "กำลังตรวจคำแปล", en: "Checking translation" },
  persisting: { th: "กำลังบันทึกคำแปล", en: "Saving translation" },
  synthesizing: { th: "กำลังสร้างเสียงอังกฤษ", en: "Creating English audio" },
  "audio-ready": { th: "เสียงอังกฤษพร้อม", en: "English audio ready" },
  playing: { th: "กำลังเล่นเสียงอังกฤษ", en: "Playing English audio" },
  blocked: { th: "แตะเพื่อเปิดเสียง", en: "Tap to enable audio" },
  muted: { th: "มีเสียงรออยู่ ปิดเสียงไว้", en: "Audio waiting while muted" },
  "playback-error": { th: "เปิดเสียงไม่ได้", en: "Could not play audio" },
  "tts-failure": {
    th: "คำแปลพร้อม แต่ไม่มีเสียง",
    en: "Translation ready, but audio failed",
  },
  "review-rejection": {
    th: "กรุณาพูดประโยคนี้อีกครั้ง",
    en: "Please say this phrase again",
  },
  "commit-failure": {
    th: "บันทึกประโยคไม่ได้ กรุณาพูดอีกครั้ง",
    en: "Could not save the phrase; please say it again",
  },
};

export function PhraseJourney({ journey }: PhraseJourneyProps) {
  const message = MESSAGES[journey.status];

  return (
    <section aria-label="Phrase journey" className="w-full bg-surface">
      <ol
        className="grid h-11 grid-cols-5 border border-ink lg:h-10"
        aria-label="Phrase steps"
      >
        {STEPS.map((step, index) => {
          const isCurrent = index === journey.step;
          const isComplete = index < journey.step;
          const stateClass = isCurrent
            ? journey.isFailure
              ? "bg-[#9a2b1c] text-canvas"
              : "bg-ink text-canvas"
            : isComplete
              ? "bg-brand-50 text-brand-800"
              : "bg-canvas-soft text-ink-faint";

          return (
            <li
              key={step.en}
              aria-current={isCurrent ? "step" : undefined}
              className={`relative flex min-w-0 items-center gap-0.5 border-r border-ink px-1 last:border-r-0 lg:gap-1 lg:px-1.5 ${stateClass}`}
            >
              <span
                aria-hidden="true"
                className="w-3.5 shrink-0 font-display text-[0.48rem] font-black leading-none lg:w-5 lg:text-[0.56rem]"
              >
                {isComplete ? "✓" : isCurrent ? "▶" : `0${index + 1}`}
              </span>
              <span className="min-w-0 leading-none">
                <span
                  lang="th"
                  className="block whitespace-nowrap font-thai text-[0.5rem] font-bold lg:text-[0.62rem]"
                >
                  {step.th}
                </span>
                <span className="mt-0.5 block font-display text-[0.46rem] font-extrabold leading-none lg:text-[0.5rem]">
                  {step.en}
                </span>
              </span>
              {isCurrent ? <span className="sr-only">Current step</span> : null}
              {isComplete ? <span className="sr-only">Completed</span> : null}
            </li>
          );
        })}
      </ol>

      <div
        role={journey.isFailure ? "alert" : "status"}
        aria-live="polite"
        aria-atomic="true"
        className={`flex min-h-7 flex-wrap items-baseline gap-x-2 border-x border-b px-2 py-1 leading-none ${
          journey.isFailure
            ? "border-[#9a2b1c] bg-[#fff3ef] text-[#8a2418]"
            : "border-ink bg-surface text-ink"
        }`}
      >
        <span lang="th" className="font-thai text-xs font-bold">
          {message.th}
        </span>
        <span className="font-display text-[0.62rem] font-semibold text-ink-soft">
          {message.en}
          {journey.commitNo === null ? "" : ` · #${journey.commitNo}`}
        </span>
      </div>
    </section>
  );
}

export default PhraseJourney;
