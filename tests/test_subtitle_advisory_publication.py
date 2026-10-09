import copy
import unittest
from src.scripts.clip_auto_publication import _validate_unresolved_signals


class SubtitleAdvisoryPublicationTests(unittest.TestCase):
    def fixture(self):
        proof = {"advisory": True, "reviewGroups": [{"type": "possible_foreign_audio",
            "occurrences": [{"start": 10, "end": 12, "text": "background line"}]}]}
        return ({"window": {"start": 0, "end": 30}, "subtitleProofreading": proof},
                {"subtitleAdvisoryEvidence": copy.deepcopy(proof), "resolvedSubtitleAdvisories": [
                    {"groupIndex": 0, "verdict": "non_material_playback", "reason": "Not used by the central commentary or public copy"}]})

    def test_bound_materiality_resolution_keeps_original_warning(self):
        metadata, review = self.fixture()
        original = copy.deepcopy(metadata)
        _validate_unresolved_signals(metadata, review)
        self.assertEqual(metadata, original)

    def test_missing_stale_duplicate_or_ambiguous_resolution_blocks(self):
        for case in ["missing", "stale", "duplicate", "ambiguous", "outside", "not_advisory", "wrong_index"]:
            with self.subTest(case=case):
                metadata, review = self.fixture()
                if case == "missing": review.pop("resolvedSubtitleAdvisories")
                if case == "stale": metadata["subtitleProofreading"]["reviewGroups"][0]["occurrences"][0]["text"] = "changed"
                if case == "duplicate": review["resolvedSubtitleAdvisories"] *= 2
                if case == "ambiguous": metadata["subtitleProofreading"]["reviewGroups"][0]["type"] = "ambiguous_term"
                if case == "outside": metadata["subtitleProofreading"]["reviewGroups"][0]["occurrences"][0]["end"] = 31
                if case == "not_advisory": metadata["subtitleProofreading"]["advisory"] = False
                if case == "wrong_index": review["resolvedSubtitleAdvisories"][0]["groupIndex"] = True
                if case in ("ambiguous", "outside", "not_advisory"):
                    review["subtitleAdvisoryEvidence"] = copy.deepcopy(metadata["subtitleProofreading"])
                with self.assertRaises(ValueError): _validate_unresolved_signals(metadata, review)
