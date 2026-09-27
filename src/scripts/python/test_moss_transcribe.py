import unittest

from moss_transcribe import combine_windows, match_previous_speakers, windows


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


if __name__ == "__main__":
    unittest.main()
