import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/scripts/python"))
from diagnose_speaker_match import summarize_rows, validate_corpus


class SpeakerDiagnosticTests(unittest.TestCase):
    def record(self, **updates):
        return {"id": "heldout-1", "path": "heldout.wav", "start_s": 0, "duration_s": 8,
                "split": "holdout", "source_id": "second-recording", "expected": "Guest",
                "identity_basis": "official-account and continuous source context", **updates}

    def test_refuses_same_source_holdout_even_for_disjoint_windows(self):
        with self.assertRaisesRegex(ValueError, "reuses a candidate source"):
            validate_corpus([self.record(start_s=80)], ["second-recording"])

    def test_requires_source_and_identity_basis_for_holdout(self):
        for field in ("source_id", "identity_basis", "expected"):
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_corpus([self.record(**{field: ""})], ["first-recording"])
        with self.assertRaisesRegex(ValueError, "candidate source_ids"):
            validate_corpus([self.record()])

    def test_accepts_independent_holdout_and_unlabelled_control(self):
        validate_corpus([self.record(), self.record(id="control", split="control", expected=None,
                        source_id=None, identity_basis=None)], ["first-recording"])

    def test_rejects_duplicate_ids_and_invalid_intervals(self):
        for rows in ([self.record(), self.record()], [self.record(start_s=-1)],
                     [self.record(duration_s=float("nan"))], [self.record(duration_s=.1)]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                validate_corpus(rows, ["first-recording"])

    def test_refuses_misspelled_splits_and_nonlist_source_ids(self):
        with self.assertRaisesRegex(ValueError, "invalid corpus split"):
            validate_corpus([self.record(split="hold-out")], ["first-recording"])
        with self.assertRaisesRegex(ValueError, "must be a list"):
            validate_corpus([self.record()], "first-recording")

    def test_summary_distinguishes_regression_agreement_from_declared_truth(self):
        rows = [{"split": "control", "baseline": {"label": "Host"}, "candidate": {"label": "Guest"}},
                {"split": "holdout", "expected": "Guest", "baseline": {"label": "UNKNOWN"},
                 "candidate": {"label": "Guest"}},
                {"split": "holdout", "expected": "Guest", "baseline": {"label": "UNKNOWN"},
                 "candidate": {"label": "UNKNOWN"}}]
        summary = summarize_rows(rows)
        self.assertEqual(summary["control"]["changed"], 1)
        self.assertEqual(summary["control"]["knownIdentityChanged"], 1)
        self.assertEqual(summary["control"]["declaredExpectedCount"], 0)
        self.assertEqual(summary["holdout"]["candidateExpectedMatches"], 1)
        self.assertEqual(summary["holdout"]["candidateUnknown"], 1)
        self.assertEqual(summary["holdout"]["unknownToKnown"], 1)


if __name__ == "__main__":
    unittest.main()
