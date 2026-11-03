import os
import sys
import unicodedata
import unittest


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PYTHON_SCRIPT_DIR = os.path.join(PROJECT_ROOT, "src", "scripts", "python")
if PYTHON_SCRIPT_DIR not in sys.path:
    sys.path.insert(0, PYTHON_SCRIPT_DIR)

from paraformer_segments import (
    SUBTITLE_MAX_DURATION,
    SUBTITLE_MIN_GAP,
    SUBTITLE_PAD_TAIL,
    SUBTITLE_TAIL_HOLD,
    make_speech_probe,
    paraformer_full_text_alignment,
)


def build(characters, step=0.3, gaps=None):
    """Character text plus per-character millisecond timestamps.

    Punctuation never receives a recognizer timestamp, so it is skipped here in
    the same way FunASR emits it.
    """
    gaps = gaps or {}
    timestamps = []
    clock = 0.0
    spoken = 0
    for char in characters:
        if char.isspace() or unicodedata.category(char).startswith("P"):
            continue
        clock += gaps.get(spoken, 0.0)
        start = clock
        clock += step
        timestamps.append([int(round(start * 1000)), int(round(clock * 1000))])
        spoken += 1
    return "".join(characters), timestamps


def align(text, timestamps, max_chars=16, speech_probe=None, tail_hold=SUBTITLE_TAIL_HOLD):
    return paraformer_full_text_alignment(
        {"raw_text": text, "display_text": text, "timestamp": timestamps},
        max_chars,
        speech_probe,
        tail_hold,
    )


class SubtitleGapSplitTests(unittest.TestCase):
    def test_splits_where_audio_actually_stops(self):
        text, stamps = build("今天天气不错我们出去走走吧", gaps={8: 2.4})
        segments, reason = align(text, stamps)
        self.assertIsNone(reason)
        self.assertGreaterEqual(len(segments), 2)
        break_before = segments[1]["start"]
        gap_start = stamps[8][0] / 1000.0
        self.assertLess(break_before, gap_start + 0.2)
        self.assertGreater(break_before, stamps[7][1] / 1000.0)

    def test_unverified_gap_is_not_treated_as_silence(self):
        text, stamps = build("今天天气不错我们出去走走吧", gaps={8: 2.4})
        segments, _ = align(text, stamps, speech_probe=lambda start, end: 1.0)
        self.assertEqual(len(segments), 1)

    def test_probe_marks_silence_as_splittable(self):
        text, stamps = build("今天天气不错我们出去走走吧", gaps={8: 2.4})
        segments, _ = align(text, stamps, speech_probe=lambda start, end: 0.0)
        self.assertGreaterEqual(len(segments), 2)


class SubtitleBoundaryTests(unittest.TestCase):
    def test_boundaries_follow_character_timestamps(self):
        text, stamps = build("好的没问题")
        segments, _ = align(text, stamps)
        self.assertEqual(len(segments), 1)
        expected_start = max(0.0, stamps[0][0] / 1000.0 - 0.03)
        self.assertAlmostEqual(segments[0]["start"], expected_start, places=2)
        self.assertAlmostEqual(
            segments[0]["end"],
            stamps[-1][1] / 1000.0 + SUBTITLE_PAD_TAIL + SUBTITLE_TAIL_HOLD,
            places=2,
        )

    def test_never_exceeds_the_character_budget(self):
        text, stamps = build("字" * 60, step=0.2)
        segments, _ = align(text, stamps, max_chars=16)
        self.assertGreater(len(segments), 1)
        for segment in segments:
            self.assertLessEqual(len(segment["text"]), 16)

    def test_cues_never_overlap_and_keep_a_gap(self):
        text, stamps = build("一二三四五六七八九十甲乙丙丁戊己庚辛壬癸", step=0.25)
        segments, _ = align(text, stamps)
        for current, following in zip(segments, segments[1:]):
            self.assertLessEqual(current["end"], following["start"] - SUBTITLE_MIN_GAP + 1e-6)

    def test_no_cue_outlives_the_duration_cap(self):
        text, stamps = build("慢慢说的一句话", step=0.9)
        segments, _ = align(text, stamps)
        for segment in segments:
            self.assertLessEqual(segment["end"] - segment["start"], SUBTITLE_MAX_DURATION + 1e-6)

    def test_punctuation_rides_with_the_preceding_character(self):
        text, stamps = build("你好，世界。")
        segments, _ = align(text, stamps)
        joined = "".join(segment["text"] for segment in segments)
        self.assertIn("，", joined)
        self.assertTrue(joined.endswith("。"))
        for segment in segments:
            self.assertFalse(segment["text"].startswith(("，", "。")))


class SubtitleTailHoldTests(unittest.TestCase):
    def test_cue_lingers_after_the_last_syllable(self):
        text, stamps = build("今天天气不错")
        segments, _ = align(text, stamps)
        self.assertEqual(len(segments), 1)
        spoken_end = stamps[-1][1] / 1000.0
        self.assertGreaterEqual(segments[0]["end"] - spoken_end, SUBTITLE_TAIL_HOLD - 0.02)

    def test_hold_stops_at_the_next_cue(self):
        text, stamps = build("今天天气不错我们出去走走吧", gaps={8: 1.2})
        segments, _ = align(text, stamps, speech_probe=lambda start, end: 0.0)
        self.assertGreaterEqual(len(segments), 2)
        self.assertAlmostEqual(
            segments[0]["end"], segments[1]["start"] - SUBTITLE_MIN_GAP, places=3
        )

    def test_hold_does_not_sprawl_over_a_long_silence(self):
        text, stamps = build("今天天气不错我们出去走走吧", gaps={8: 6.0})
        segments, _ = align(text, stamps)
        spoken_end = stamps[7][1] / 1000.0
        self.assertLessEqual(
            segments[0]["end"] - spoken_end, SUBTITLE_TAIL_HOLD + SUBTITLE_PAD_TAIL + 1e-6
        )

    def test_raw_speech_spans_skip_the_hold(self):
        text, stamps = build("今天天气不错")
        segments, _ = align(text, stamps, tail_hold=0.0)
        self.assertAlmostEqual(
            segments[0]["end"], stamps[-1][1] / 1000.0 + SUBTITLE_PAD_TAIL, places=2
        )


class SubtitleFallbackTests(unittest.TestCase):
    def test_missing_timestamps_reports_a_reason(self):
        segments, reason = paraformer_full_text_alignment(
            {"raw_text": "你好", "display_text": "你好", "timestamp": []}, 16
        )
        self.assertEqual(segments, [])
        self.assertEqual(reason, "missing_text_or_timestamps")

    def test_invalid_result_is_rejected(self):
        self.assertEqual(paraformer_full_text_alignment(None, 16), ([], "invalid_result"))


class SpeechProbeTests(unittest.TestCase):
    def test_separates_tone_from_silence(self):
        try:
            import numpy as np
        except Exception:
            self.skipTest("numpy unavailable")

        rate = 16000
        clock = np.arange(rate * 3, dtype="float32") / rate
        tone = 0.3 * np.sin(2 * np.pi * 220 * clock)
        audio = np.concatenate([tone[:rate * 3 // 2], np.zeros(rate * 3 - rate * 3 // 2, dtype="float32")])
        probe = make_speech_probe(audio, rate)
        self.assertGreater(probe(0.1, 1.2), 0.5)
        self.assertLess(probe(1.7, 2.9), 0.2)


if __name__ == "__main__":
    unittest.main()
