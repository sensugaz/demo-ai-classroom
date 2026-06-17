#!/usr/bin/env python3
"""Benchmark Thai->English translation across candidate OpenRouter models.

Replicates the production call exactly (same prompt, temperature=0.2,
max_tokens=1024, OpenRouter attribution headers, single user message) so the
numbers reflect what the live pipeline would actually see.

For each model x test-sentence it records wall-clock latency and the cleaned
output, then prints a latency leaderboard and writes a full Markdown report
(`benchmark_results.md`) with side-by-side translations for quality eyeballing.

Run (host, isolated venv):
    cd ai-service
    python3 -m venv .venv-bench && .venv-bench/bin/pip install -q openai
    .venv-bench/bin/python scripts/benchmark_translation.py

Reads LLM_API_KEY / LLM_BASE_URL / LLM_HTTP_REFERER / LLM_APP_TITLE from the
repo-root .env (falls back to process env). Makes real API calls (small cost).
"""

from __future__ import annotations

import os
import statistics
import sys
import time
from pathlib import Path

# --- Candidate models (balance of quality + latency). Edit freely; unknown ids
#     are skipped gracefully so an unavailable model never aborts the run. -------
MODELS: list[str] = [
    "openai/gpt-4o-mini",            # current production baseline
    "openai/gpt-4.1-mini",
    "openai/gpt-4.1-nano",
    "google/gemini-2.5-flash",
    "google/gemini-2.0-flash-001",
    "anthropic/claude-3.5-haiku",
    "meta-llama/llama-3.3-70b-instruct",
    "qwen/qwen-2.5-72b-instruct",
]

# --- Thai test utterances: short STT-style fragments + longer classroom lines.
TEST_SENTENCES: list[str] = [
    "สวัสดี",
    "ดีครับ ทำอะไรอยู่ครับ",
    "วันนี้ฉันจะมา",
    "นิทานเรื่องกระต่ายกับเต่า",
    "ง่วงมะขามมะยม",
    "มะม่วง",
    "วันนี้เราจะมาเรียนเรื่องระบบสุริยะ ดวงอาทิตย์เป็นศูนย์กลางและมีดาวเคราะห์แปดดวงโคจรอยู่รอบ",
    "นักเรียนทุกคนเปิดหนังสือหน้าสามสิบสองแล้วอ่านตามครูพร้อมกันนะคะ",
]

# --- Exact production prompt (kept in sync with
#     app/prompts/thai_to_english_translation_prompt.py). ----------------------
TRANSLATION_PROMPT_TEMPLATE = """You are a classroom interpreter.

Translate Thai classroom speech into natural English.

Rules:
- Translate from Thai to English only.
- Keep the meaning accurate.
- Use clear English suitable for students.
- Do not add information that was not spoken.
- If the Thai sentence is incomplete, translate only the meaningful part.
- Preserve classroom tone.
- Do not explain.
- Do not return Thai.
- Output only the English translation.

Input Thai:
{{sourceText}}

Output English:
"""

TEMPERATURE = 0.2
MAX_TOKENS = 1024


def build_prompt(source_text: str) -> str:
    return TRANSLATION_PROMPT_TEMPLATE.replace("{{sourceText}}", source_text)


def clean_translation(raw: str) -> str:
    """Mirror app.services...._clean_translation."""
    text = raw.strip()
    lowered = text.lower()
    for label in ("output english:", "english:", "translation:"):
        if lowered.startswith(label):
            text = text[len(label):].strip()
            lowered = text.lower()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        text = text[1:-1].strip()
    return text


def load_env() -> None:
    """Load repo-root .env into os.environ (only keys not already set)."""
    root = Path(__file__).resolve().parents[2]  # ai-service/scripts -> repo root
    env_path = root / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def main() -> int:
    load_env()

    api_key = os.environ.get("LLM_API_KEY", "")
    if not api_key:
        print("ERROR: LLM_API_KEY not set (checked .env and process env).")
        return 1
    base_url = os.environ.get("LLM_BASE_URL", "https://openrouter.ai/api/v1")

    try:
        from openai import OpenAI
    except ImportError:
        print("ERROR: openai package missing. Install: pip install openai")
        return 1

    default_headers: dict[str, str] = {}
    if os.environ.get("LLM_HTTP_REFERER"):
        default_headers["HTTP-Referer"] = os.environ["LLM_HTTP_REFERER"]
    if os.environ.get("LLM_APP_TITLE"):
        default_headers["X-Title"] = os.environ["LLM_APP_TITLE"]

    client = OpenAI(
        api_key=api_key,
        base_url=base_url,
        default_headers=default_headers or None,
    )

    def call(model: str, prompt: str) -> tuple[float, str]:
        """Return (latency_seconds, cleaned_text). Raises on failure."""
        t0 = time.perf_counter()
        completion = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=TEMPERATURE,
            max_tokens=MAX_TOKENS,
        )
        dt = time.perf_counter() - t0
        content = (completion.choices[0].message.content or "") if completion.choices else ""
        return dt, clean_translation(content)

    print(f"Benchmark: {len(MODELS)} models x {len(TEST_SENTENCES)} sentences "
          f"via {base_url}\n")

    # results[model] = {"latencies": [...], "outputs": {sentence: text},
    #                   "errors": int, "error_msg": str|None}
    results: dict[str, dict] = {}

    for model in MODELS:
        print(f"--- {model}")
        rec = {"latencies": [], "outputs": {}, "errors": 0, "error_msg": None}
        # Warmup (not timed) to amortize connection/cold-start; tolerate failure.
        try:
            call(model, build_prompt("สวัสดี"))
        except Exception as exc:  # noqa: BLE001
            rec["error_msg"] = str(exc)[:160]
            print(f"    unavailable: {rec['error_msg']}")
            results[model] = rec
            continue

        for sent in TEST_SENTENCES:
            try:
                dt, out = call(model, build_prompt(sent))
                rec["latencies"].append(dt)
                rec["outputs"][sent] = out
                print(f"    {dt:5.2f}s  {sent[:22]:<22} -> {out[:48]}")
            except Exception as exc:  # noqa: BLE001
                rec["errors"] += 1
                rec["outputs"][sent] = f"[ERROR] {str(exc)[:80]}"
                print(f"    ERR    {sent[:22]:<22} -> {str(exc)[:60]}")
        results[model] = rec

    # --- Leaderboard (median latency over successful calls) -------------------
    ranked = []
    for model, rec in results.items():
        lats = rec["latencies"]
        if not lats:
            continue
        ranked.append((
            model,
            statistics.median(lats),
            statistics.mean(lats),
            min(lats),
            max(lats),
            len(lats),
            rec["errors"],
        ))
    ranked.sort(key=lambda r: r[1])

    print("\n=== LATENCY LEADERBOARD (median, sorted) ===")
    print(f"{'model':<38} {'median':>7} {'mean':>7} {'min':>6} {'max':>6} {'ok':>3} {'err':>3}")
    for model, med, mean, lo, hi, n, err in ranked:
        print(f"{model:<38} {med:6.2f}s {mean:6.2f}s {lo:5.2f}s {hi:5.2f}s {n:3d} {err:3d}")

    unavailable = [m for m, r in results.items() if r["error_msg"]]
    if unavailable:
        print("\nUnavailable / errored models:")
        for m in unavailable:
            print(f"  - {m}: {results[m]['error_msg']}")

    # --- Markdown report for quality eyeballing -------------------------------
    report = Path(__file__).resolve().parent / "benchmark_results.md"
    lines: list[str] = []
    lines.append("# Thai->English translation model benchmark\n")
    lines.append(f"- Endpoint: `{base_url}`")
    lines.append(f"- Params: temperature={TEMPERATURE}, max_tokens={MAX_TOKENS}, single user message (production-identical)")
    lines.append(f"- Models tested: {len(MODELS)} | Sentences: {len(TEST_SENTENCES)}\n")

    lines.append("## Latency leaderboard (median over successful calls)\n")
    lines.append("| Rank | Model | Median | Mean | Min | Max | OK | Err |")
    lines.append("|----|------|------|----|----|----|----|----|")
    for i, (model, med, mean, lo, hi, n, err) in enumerate(ranked, 1):
        lines.append(f"| {i} | `{model}` | {med:.2f}s | {mean:.2f}s | {lo:.2f}s | {hi:.2f}s | {n} | {err} |")
    if unavailable:
        lines.append("\n**Unavailable:** " + ", ".join(f"`{m}`" for m in unavailable))

    lines.append("\n## Translations side-by-side (judge quality here)\n")
    ok_models = [m for m, _, _, _, _, _, _ in ranked]
    for sent in TEST_SENTENCES:
        lines.append(f"### `{sent}`\n")
        lines.append("| Model | Output |")
        lines.append("|------|------|")
        for model in ok_models:
            out = results[model]["outputs"].get(sent, "—").replace("|", "\\|")
            lines.append(f"| `{model}` | {out} |")
        lines.append("")

    report.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nFull report (with translations) written to: {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
