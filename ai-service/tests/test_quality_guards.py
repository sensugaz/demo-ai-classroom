import unittest
from dataclasses import dataclass, field

from app.prompts.summary_prompt import build_summary_prompt
from app.prompts.thai_to_english_translation_prompt import build_translation_prompt
from app.prompts.vocabulary_prompt import build_vocabulary_prompt
from app.services.classroom_term_glossary import (
    classroom_glossary_for,
    merge_classroom_glossary,
)
from app.services.summary_quality import (
    build_conservative_summary_fields,
    build_summary_audit_prompt,
    build_summary_retry_prompt,
    find_summary_quality_issues,
    parse_summary_audit,
)
from app.services.translation_quality import (
    build_glossary_retry_prompt,
    build_translation_audit_prompt,
    find_missing_glossary_terms,
    parse_translation_audit,
)
from app.services.vocabulary_quality import sanitize_vocabulary


@dataclass
class FakeSummary:
    summaryTh: str = ""
    summaryEn: str = ""
    keyPointsTh: list[str] = field(default_factory=list)
    keyPointsEn: list[str] = field(default_factory=list)


@dataclass
class FakeVocabulary:
    word: str = ""
    pronunciation: str = ""
    partOfSpeech: str = ""
    meaningTh: str = ""
    meaningEn: str = ""
    exampleSentenceEn: str = ""
    exampleSentenceTh: str = ""
    difficultyLevel: str = "beginner"
    dictionarySource: str = ""


class QualityGuardTest(unittest.TestCase):
    def test_no_builtin_glossary_terms_are_hardcoded(self):
        self.assertEqual([], classroom_glossary_for("มีสวนทุเรียนลองกอง"))

    def test_explicit_dynamic_terms_are_merged_without_builtin_fallback(self):
        glossary = merge_classroom_glossary(
            "วันนี้เรียนเรื่องดาวอังคาร",
            "",
            [("ดาวอังคาร", "Mars"), ("ระบบสุริยะ", "solar system")],
        )

        self.assertEqual(
            [("ดาวอังคาร", "Mars"), ("ระบบสุริยะ", "solar system")],
            glossary,
        )

    def test_translation_prompt_accepts_arbitrary_dynamic_terms(self):
        glossary = [("ดาวอังคาร", "Mars"), ("ระบบสุริยะ", "solar system")]
        prompt = build_translation_prompt(
            "วันนี้เรียนเรื่องดาวอังคารในระบบสุริยะ",
            glossary=glossary,
        )

        self.assertIn("- ดาวอังคาร => Mars", prompt)
        self.assertIn("- ระบบสุริยะ => solar system", prompt)
        self.assertIn("Do not omit any known noun or glossary term", prompt)

    def test_missing_dynamic_term_is_detected_after_translation(self):
        missing = find_missing_glossary_terms(
            "วันนี้เรียนเรื่องดาวอังคารในระบบสุริยะ",
            "Today we learned about the solar system.",
            [("ดาวอังคาร", "Mars"), ("ระบบสุริยะ", "solar system")],
        )

        self.assertEqual(["ดาวอังคาร"], [term.th for term in missing])

    def test_translation_retry_prompt_is_generic(self):
        retry_prompt = build_glossary_retry_prompt(
            "Input Thai:\nวันนี้เรียนเรื่องดาวอังคาร\n\nOutput English:",
            "Today we learned about a planet.",
            find_missing_glossary_terms(
                "วันนี้เรียนเรื่องดาวอังคาร",
                "Today we learned about a planet.",
                [("ดาวอังคาร", "Mars")],
            ),
        )

        self.assertIn("Accuracy check failed", retry_prompt)
        self.assertIn("- ดาวอังคาร => Mars", retry_prompt)
        self.assertNotIn("ลองกอง", retry_prompt)

    def test_translation_audit_prompt_and_parser_are_generic(self):
        prompt = build_translation_audit_prompt(
            "วันนี้เรียนเรื่องการลบเลข",
            "Today we learned about fighting.",
            context_note="คณิตศาสตร์",
        )
        audit = parse_translation_audit(
            {
                "isAccurate": False,
                "correctedTranslation": "Today we learned about subtraction.",
                "issues": ["mistranslated การลบ as fighting"],
            }
        )

        self.assertIn("Thai input", prompt)
        self.assertIn("การลบเลข", prompt)
        self.assertFalse(audit.is_accurate)
        self.assertEqual("Today we learned about subtraction.", audit.corrected_translation)

    def test_summary_prompt_uses_dynamic_terms(self):
        prompt = build_summary_prompt(
            "วันนี้เรียนเรื่องการสังเคราะห์แสงของใบไม้",
            "Today we learned about photosynthesis in leaves.",
            glossary=[("การสังเคราะห์แสง", "photosynthesis"), ("ใบไม้", "leaves")],
        )

        self.assertIn("Use the Thai transcript as the source of truth", prompt)
        self.assertIn("- การสังเคราะห์แสง => photosynthesis", prompt)
        self.assertIn("- ใบไม้ => leaves", prompt)

    def test_summary_quality_checks_dynamic_term_coverage_only(self):
        issues = find_summary_quality_issues(
            "วันนี้เรียนเรื่องการสังเคราะห์แสงของใบไม้",
            FakeSummary(
                summaryTh="วันนี้เรียนเรื่องใบไม้",
                summaryEn="Today we learned about leaves.",
            ),
            [("การสังเคราะห์แสง", "photosynthesis"), ("ใบไม้", "leaves")],
        )

        self.assertIn(
            "missing_english_protected_term",
            [issue.code for issue in issues],
        )
        self.assertIn(
            "missing_thai_protected_term",
            [issue.code for issue in issues],
        )

    def test_summary_retry_and_audit_prompts_are_generic(self):
        issues = find_summary_quality_issues(
            "วันนี้เรียนเรื่องการสังเคราะห์แสง",
            FakeSummary(summaryTh="วันนี้เรียน", summaryEn="Today we learned."),
            [("การสังเคราะห์แสง", "photosynthesis")],
        )
        retry_prompt = build_summary_retry_prompt(
            "Thai Transcript:\nวันนี้เรียนเรื่องการสังเคราะห์แสง",
            '{"summaryEn":"Today we learned."}',
            issues,
        )
        audit_prompt = build_summary_audit_prompt(
            "วันนี้เรียนเรื่องการสังเคราะห์แสง",
            "Today we learned about photosynthesis.",
            '{"summaryEn":"Today we learned about photosynthesis."}',
            [("การสังเคราะห์แสง", "photosynthesis")],
        )

        self.assertIn("missing_english_protected_term", retry_prompt)
        self.assertIn("Audit whether the JSON summary is faithful", audit_prompt)
        self.assertIn("photosynthesis", audit_prompt)

    def test_summary_audit_parser_accepts_corrected_summary(self):
        audit = parse_summary_audit(
            {
                "isFaithful": False,
                "issues": ["invented homework"],
                "summary": {
                    "summaryTh": "วันนี้เรียนเรื่องรูปสามเหลี่ยม",
                    "summaryEn": "Today we learned about triangles.",
                    "keyPointsTh": ["รูปสามเหลี่ยม"],
                    "keyPointsEn": ["triangles"],
                },
            }
        )

        self.assertFalse(audit.is_faithful)
        self.assertEqual(("invented homework",), audit.issues)
        self.assertEqual("Today we learned about triangles.", audit.corrected_summary["summaryEn"])

    def test_conservative_summary_uses_arbitrary_dynamic_terms(self):
        fields = build_conservative_summary_fields(
            "วันนี้เรียนเรื่องรูปสามเหลี่ยมและมุมฉาก",
            [("รูปสามเหลี่ยม", "triangle"), ("มุมฉาก", "right angle")],
        )

        self.assertIn("รูปสามเหลี่ยม", fields["summaryTh"])
        self.assertIn("right angle", fields["summaryEn"])
        self.assertNotIn("longkong", fields["summaryEn"].lower())

    def test_vocabulary_prompt_uses_thai_transcript_and_dynamic_terms(self):
        prompt = build_vocabulary_prompt(
            "Today we learned about triangles.",
            full_thai_transcript="วันนี้เรียนเรื่องรูปสามเหลี่ยมและมุมฉาก",
            glossary=[("รูปสามเหลี่ยม", "triangle"), ("มุมฉาก", "right angle")],
        )

        self.assertIn("Use the Thai transcript as the source of truth", prompt)
        self.assertIn("- รูปสามเหลี่ยม => triangle", prompt)
        self.assertIn("- มุมฉาก => right angle", prompt)

    def test_vocabulary_sanitizer_adds_arbitrary_dynamic_terms(self):
        vocab = sanitize_vocabulary(
            [FakeVocabulary(word="triangle", meaningTh="รูปสามเหลี่ยม")],
            "วันนี้เรียนเรื่องรูปสามเหลี่ยมและมุมฉาก",
            [("รูปสามเหลี่ยม", "triangle"), ("มุมฉาก", "right angle")],
            vocab_factory=FakeVocabulary,
        )

        words = [item.word.lower() for item in vocab]
        self.assertIn("triangle", words)
        self.assertIn("right angle", words)


if __name__ == "__main__":
    unittest.main()
