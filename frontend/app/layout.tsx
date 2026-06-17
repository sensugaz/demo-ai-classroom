import type { Metadata } from "next";
import { Archivo, Noto_Sans_Thai } from "next/font/google";

import "./globals.css";

// One heavy grotesque carries everything — mastheads/timer at 800/900,
// UI/body at 500/600. Poster character, not generic sans.
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800", "900"],
  variable: "--font-archivo",
  display: "swap",
});

// Thai script — legibility is a hard constraint; never below 400.
const notoThai = Noto_Sans_Thai({
  subsets: ["thai"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-thai",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AI Classroom — Thai to English Translator",
  description:
    "Real-time Thai speech to English translation classroom with live transcript, audio, summaries, vocabulary, and flash cards.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${archivo.variable} ${notoThai.variable}`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
