import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-8 bg-canvas px-6 py-16 text-center">
      <div className="space-y-6">
        <span className="inline-flex items-center gap-2 rounded-none ring-1 ring-brand-600 px-4 py-1 text-sm font-display font-extrabold uppercase tracking-wide text-brand-600">
          Thai to English
        </span>
        <h1 className="font-display font-black uppercase tracking-tight text-[clamp(2.5rem,9vw,5rem)] leading-[0.95] text-ink">
          AI Classroom
        </h1>
        <p className="mx-auto max-w-xl text-lg text-ink-soft">
          Speak Thai and get live English translation with audio, then review an
          auto-generated summary, vocabulary, and flash cards after class.
        </p>
      </div>

      <Link
        href="/classroom"
        className="inline-flex min-h-[52px] items-center justify-center rounded-none bg-ink px-8 py-3 text-base font-extrabold uppercase tracking-wide text-canvas transition hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        Go to Classroom
      </Link>
    </main>
  );
}
