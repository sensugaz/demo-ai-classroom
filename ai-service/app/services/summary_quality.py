"""Generic quality helpers for generated classroom summaries."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Protocol

from app.services.translation_quality import find_missing_glossary_terms


@dataclass(frozen=True)
class SummaryQualityIssue:
    """One faithfulness issue found in a generated summary."""

    code: str
    message: str


@dataclass(frozen=True)
class SummaryAuditResult:
    """LLM audit result for one generated summary."""

    is_faithful: bool
    corrected_summary: dict[str, Any] | None
    issues: tuple[str, ...] = ()


class SummaryLike(Protocol):
    summaryTh: str
    summaryEn: str
    keyPointsTh: list[str]
    keyPointsEn: list[str]


def find_summary_quality_issues(
    full_thai_transcript: str,
    summary: SummaryLike,
    glossary: Iterable[tuple[str, str]],
) -> list[SummaryQualityIssue]:
    """Return deterministic term-coverage issues from dynamic protected terms."""

    issues: list[SummaryQualityIssue] = []
    glossary_list = list(glossary)
    missing_en = find_missing_glossary_terms(
        full_thai_transcript,
        summary.summaryEn,
        glossary_list,
    )
    for term in missing_en:
        issues.append(
            SummaryQualityIssue(
                code="missing_english_protected_term",
                message=f"English summary omitted {term.th} => {term.en}.",
            )
        )

    for th, _en in glossary_list:
        th = (th or "").strip()
        if th and th in full_thai_transcript and th not in summary.summaryTh:
            issues.append(
                SummaryQualityIssue(
                    code="missing_thai_protected_term",
                    message=f"Thai summary omitted {th}.",
                )
            )

    return issues


def build_summary_retry_prompt(
    original_prompt: str,
    previous_summary_json: str,
    issues: Iterable[SummaryQualityIssue],
) -> str:
    """Build a stricter prompt for deterministic term-coverage retry."""

    issue_lines = "\n".join(f"- {issue.code}: {issue.message}" for issue in issues)
    return (
        f"{original_prompt.rstrip()}\n\n"
        "Quality check failed. Rewrite the JSON summary so it is safe for children "
        "to study from and strictly faithful to the Thai transcript.\n"
        "Previous JSON summary:\n"
        f"{previous_summary_json.strip()}\n\n"
        "Issues to fix:\n"
        f"{issue_lines}\n\n"
        "Rules for the correction:\n"
        "- Trust the Thai transcript over the English translation when they conflict.\n"
        "- Include every protected term that appears in the Thai transcript.\n"
        "- Put protected terms in the main summary text, not only in key points or "
        "vocabulary lists.\n"
        "- Do not add story actions, causes, morals, symbolism, homework, examples, "
        "or facts unless they are explicitly supported by the Thai transcript.\n"
        "- If the transcript is short or fragmentary, keep the summary short and literal.\n"
        "- Return VALID JSON ONLY with the exact required shape."
    )


SUMMARY_AUDIT_PROMPT_TEMPLATE = """You are a strict Thai/English classroom summary auditor for children.

Audit whether the JSON summary is faithful to the Thai transcript.

Rules:
- Use the Thai transcript as the source of truth.
- The English translation may contain mistakes.
- Flag omitted protected terms, invented story actions, invented causes, invented
  morals/themes/symbolism, invented homework, invented examples, and any detail
  not supported by the Thai transcript.
- If the summary is faithful, return it unchanged.
- If not faithful, correct the JSON summary while keeping it useful, short when
  the transcript is short, and safe for children to study from.
- Return valid JSON only.

Protected terms:
{{glossaryBlock}}

Thai Transcript:
{{fullThaiTranscript}}

English Translation (may be imperfect):
{{fullEnglishTranslation}}

JSON summary to audit:
{{summaryJson}}

Return JSON only:
{
  "isFaithful": true,
  "issues": [],
  "summary": { "summaryTh": "", "summaryEn": "", "keyPointsTh": [], "keyPointsEn": [] }
}
"""


def _render_glossary_block(glossary: Iterable[tuple[str, str]]) -> str:
    pairs = [
        f"- {(th or '').strip()} => {(en or '').strip()}"
        for th, en in glossary
        if (th or "").strip() and (en or "").strip()
    ]
    return "\n".join(pairs) if pairs else "- none"


def build_summary_audit_prompt(
    full_thai_transcript: str,
    full_english_translation: str,
    summary_json: str,
    glossary: Iterable[tuple[str, str]],
) -> str:
    """Render the generic LLM faithfulness-audit prompt for summaries."""

    return (
        SUMMARY_AUDIT_PROMPT_TEMPLATE
        .replace("{{glossaryBlock}}", _render_glossary_block(glossary))
        .replace("{{fullThaiTranscript}}", full_thai_transcript)
        .replace("{{fullEnglishTranslation}}", full_english_translation)
        .replace("{{summaryJson}}", summary_json)
    )


def parse_summary_audit(raw: Any) -> SummaryAuditResult:
    """Coerce parsed audit JSON into a summary audit result."""

    data = raw if isinstance(raw, dict) else {}
    is_faithful = bool(data.get("isFaithful", False))
    issues_raw = data.get("issues", [])
    if isinstance(issues_raw, list):
        issues = tuple(str(issue).strip() for issue in issues_raw if str(issue).strip())
    else:
        issues = ()
    summary = data.get("summary")
    corrected = summary if isinstance(summary, dict) else None
    return SummaryAuditResult(
        is_faithful=is_faithful,
        corrected_summary=corrected,
        issues=issues,
    )


def build_conservative_summary_fields(
    full_thai_transcript: str,
    glossary: Iterable[tuple[str, str]],
) -> dict[str, object]:
    """Build literal fallback notes when LLM summary stays unfaithful."""

    pairs = [
        ((th or "").strip(), (en or "").strip())
        for th, en in glossary
        if (th or "").strip() and (en or "").strip()
    ]
    thai_terms = [th for th, _en in pairs if th in full_thai_transcript]
    english_terms = [en for th, en in pairs if th in full_thai_transcript]

    if thai_terms:
        thai_text = ", ".join(thai_terms)
        english_text = ", ".join(english_terms)
        return {
            "summaryTh": (
                "จากข้อความที่บันทึกได้ เนื้อหาที่รองรับอย่างชัดเจนคือคำสำคัญ: "
                f"{thai_text}"
            ),
            "summaryEn": (
                "Based on the recorded Thai transcript, the clearly supported "
                f"learning terms are: {english_text}."
            ),
            "keyPointsTh": [f"คำสำคัญที่พบใน transcript: {thai_text}"],
            "keyPointsEn": [f"Protected terms found in the transcript: {english_text}."],
        }

    return {
        "summaryTh": (
            "ข้อความที่บันทึกได้ยังสั้นหรือไม่ชัดเจนพอสำหรับสรุปรายละเอียด "
            "ควรให้คุณครูตรวจ transcript ก่อนแชร์ให้นักเรียน"
        ),
        "summaryEn": (
            "The recorded transcript is short or unclear, so the teacher should "
            "review it before sharing study notes with students."
        ),
        "keyPointsTh": ["ควรตรวจ transcript ก่อนแชร์"],
        "keyPointsEn": ["Teacher review is required before sharing."],
    }
