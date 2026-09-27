import unittest

from moss_transcribe import (apply_reference_matches, clean_reference_rows,
                             combine_windows, match_previous_speakers, windows)


class MossWindowTests(unittest.TestCase):
    def test_windows_cover_long_recording_with_overlap(self):
        self.assertEqual(list(windows(625, 300, 20)), [(0.0, 300.0), (280.0, 580.0), (560.0, 625)])

    def test_repeated_turn_links_speaker_and_keeps_simultaneous_rows(self):
        first = [
            {"start": 280, "end": 287, "speaker": "S01", "text": "我们接着玩这个游戏"},
            {"start": 284, "end": 288, "speaker": "S02", "text": "好啊我也来"},
        ]
        second = [
            {"start": 0, "end": 7, "speaker": "S02", "text": "我们接着玩这个游戏"},
            {"start": 4, "end": 8, "speaker": "S01", "text": "好啊我也来"},
            {"start": 20, "end": 23, "speaker": "S03", "text": "我刚刚加入"},
        ]
        combined = combine_windows([(0, 300, first), (280, 580, second)], 580)
        self.assertEqual([(row["speaker"], row["start"], row["end"]) for row in combined], [
            ("S01", 280, 287), ("S02", 284, 288), ("S03", 300, 303),
        ])
        self.assertGreater(combined[0]["end"], combined[1]["start"])

    def test_different_overlap_words_do_not_force_identity(self):
        old = [{"start": 280, "end": 285, "speaker": "S01", "text": "我们开始吧"}]
        new = [{"start": 281, "end": 286, "speaker": "S01", "text": "完全不同的话题"}]
        self.assertEqual(match_previous_speakers(old, new, 280, 300), {})

    def test_reference_matching_requires_isolated_repeated_rows_per_identity(self):
        rows = [
            {"start": 0, "end": 3, "speaker": "S01", "text": "one"},
            {"start": 4, "end": 7, "speaker": "S01", "text": "two"},
            {"start": 8, "end": 11, "speaker": "S01", "text": "three"},
            {"start": 12, "end": 15, "speaker": "S01", "text": "four"},
            {"start": 16, "end": 19, "speaker": "S02", "text": "overlap"},
            {"start": 17, "end": 20, "speaker": "S03", "text": "overlap"},
            {"start": 21, "end": 22, "speaker": "S02", "text": "short"},
        ]
        self.assertEqual(clean_reference_rows(rows), [0, 1, 2, 3])
        def accepted(label):
            return {"accepted": True, "label": label, "best_label": label,
                    "score": 0.7, "margin": 0.15, "threshold": 0.55}
        result = apply_reference_matches(rows, {0: accepted("A"), 1: accepted("A"),
                                                2: accepted("B"), 3: accepted("B")})
        self.assertEqual(result["namedRows"], 4)
        self.assertEqual([row["speaker"] for row in rows], ["A", "A", "B", "B", "S02", "S03", "S02"])
        self.assertEqual(rows[4]["speaker_evidence"]["anonymousLabel"], "S02")
        self.assertEqual(rows[4]["speaker_evidence"]["status"], "unknown")

    def test_single_match_or_rejected_margin_stays_anonymous(self):
        rows = [{"start": n * 3, "end": n * 3 + 2.5, "speaker": "S01", "text": "x"}
                for n in range(3)]
        apply_reference_matches(rows, {
            0: {"accepted": True, "label": "A", "score": 0.6},
            1: {"accepted": False, "label": "UNKNOWN", "best_label": "A", "score": 0.65},
        })
        self.assertEqual([row["speaker"] for row in rows], ["S01"] * 3)
        self.assertFalse(rows[0]["speaker_evidence"]["observations"][0]["row"]["accepted"])


if __name__ == "__main__":
    unittest.main()
