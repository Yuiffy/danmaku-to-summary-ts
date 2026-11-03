import os
import sys
import unittest
from unittest.mock import Mock


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PYTHON_SCRIPT_DIR = os.path.join(PROJECT_ROOT, "src", "scripts", "python")
if PYTHON_SCRIPT_DIR not in sys.path:
    sys.path.insert(0, PYTHON_SCRIPT_DIR)

from sensevoice_paraformer import (
    extract_vad_speaker_intervals,
    normalize_model_results_with_meta,
    paraformer_full_text_to_segments,
    paraformer_timestamp_to_sentences,
    select_paraformer_speaker_intervals,
)
from paraformer_segments import SUBTITLE_PAD_TAIL, SUBTITLE_TAIL_HOLD
from sensevoice_text import extract_sensevoice_metadata, normalize_segments

# A cue stays on screen after its last syllable, so every expected end carries
# the tail hold on top of the speech padding.
HOLD = SUBTITLE_TAIL_HOLD
PAD = SUBTITLE_PAD_TAIL


class SenseVoiceMetadataTests(unittest.TestCase):
    def test_extracts_emotion_and_audio_events_without_control_tags(self):
        metadata = extract_sensevoice_metadata(
            "<|zh|><|HAPPY|><|Speech|><|Laughter|><|woitn|>你好"
        )

        self.assertEqual(metadata, {
            "emotion": "HAPPY",
            "events": ["Speech", "Laughter"],
        })

    def test_normalizes_new_emotion_aliases_and_ignores_unknown_emotion(self):
        self.assertEqual(
            extract_sensevoice_metadata("<|SURPRISED|><|Speech|>哇"),
            {"emotion": "SURPRISE", "events": ["Speech"]},
        )
        self.assertEqual(
            extract_sensevoice_metadata("<|EMO_UNKNOWN|><|BGM|>嗯"),
            {"events": ["BGM"]},
        )
        self.assertEqual(
            extract_sensevoice_metadata("<|EMO_UNKNOWN|><|Event_UNK|>嗯"),
            {},
        )

    def test_normalized_timed_segment_keeps_sensevoice_metadata(self):
        segments = normalize_segments([{
            "start": 1200,
            "end": 3400,
            "text": "<|zh|><|SAD|><|Speech|>有点难过",
        }])

        self.assertEqual(segments, [{
            "start": 1.2,
            "end": 3.4,
            "text": "有点难过",
            "emotion": "SAD",
            "events": ["Speech"],
        }])

    def test_chunk_timing_fallback_keeps_emotion_metadata(self):
        segments = normalize_model_results_with_meta(
            [{"text": "<|zh|><|ANGRY|><|Speech|>不要这样"}],
            {"start": 10.0, "end": 14.0},
            None,
        )

        self.assertEqual(segments[0]["start"], 10.0)
        self.assertEqual(segments[0]["end"], 14.0)
        self.assertEqual(segments[0]["text"], "不要这样")
        self.assertEqual(segments[0]["emotion"], "ANGRY")
        self.assertEqual(segments[0]["events"], ["Speech"])

    def test_second_normalization_keeps_existing_emotion_metadata(self):
        segments = normalize_segments([{
            "start": 10.0,
            "end": 14.0,
            "time_unit": "seconds",
            "text": "不要这样",
            "emotion": "ANGRY",
            "events": ["BGM"],
        }])

        self.assertEqual(segments[0]["emotion"], "ANGRY")
        self.assertEqual(segments[0]["events"], ["BGM"])


class ParaformerTimestampTests(unittest.TestCase):
    def test_preserves_english_spacing_without_consuming_word_timestamps(self):
        cases = [
            ("I want to make a call", "I want to make a call", 6),
            ("  I\t want\u00a0to  make a call  ", "I want to make a call", 6),
            ("你 好，I want to make a call。", "你好，I want to make a call。", 8),
            ("你 好 世 界", "你好世界", 4),
            ("I'm using Wi-Fi 6 today", "I'm using Wi-Fi 6 today", 5),
        ]
        for raw, expected, count in cases:
            with self.subTest(raw=raw):
                rows = paraformer_full_text_to_segments({
                    "text": raw,
                    "timestamp": [[i * 500, i * 500 + 400] for i in range(count)],
                }, max_subtitle_chars=80)
                expected_end = round((count - 1) * .5 + .4 + PAD + HOLD, 3)
                self.assertEqual(rows, [{"start": 0.0, "end": expected_end,
                                         "text": expected, "time_unit": "seconds"}])

    def test_wrapping_keeps_whole_english_words_and_their_time_ranges(self):
        rows = paraformer_full_text_to_segments({
            "text": "I want to make a call",
            "timestamp": [[i * 500, i * 500 + 400] for i in range(6)],
        }, max_subtitle_chars=8)
        self.assertEqual([row["text"] for row in rows], ["I want to", "make a call"])
        # The first cue still ends where the next one starts; only the closing
        # cue gets to use its hold.
        self.assertEqual(
            [(row["start"], row["end"]) for row in rows],
            [(0, 1.39), (1.47, round(2.9 + PAD + HOLD, 3))],
        )

    def test_chunk_alignment_preserves_spaces_offsets_and_speaker(self):
        punc = Mock()
        punc.generate.return_value = [{"text": "你好，I want to make a call。"}]
        rows = paraformer_timestamp_to_sentences([{
            "text": "你 好 I want to make a call",
            "timestamp": [[i * 500, i * 500 + 400] for i in range(8)],
        }], {"start": 10, "end": 15, "speaker": "Host", "speaker_score": .9}, punc, 80)
        punc.generate.assert_called_once_with(input="你好 I want to make a call")
        self.assertEqual(rows, [{"start": 10, "end": round(13.9 + PAD + HOLD, 3),
                                 "text": "你好，I want to make a call。",
                                 "time_unit": "seconds", "speaker": "Host", "speaker_score": .9}])

    def test_chunk_fallback_keeps_words_when_timestamps_are_missing_or_misaligned(self):
        for timestamps in (None, [], [[0, 100]]):
            with self.subTest(timestamps=timestamps):
                rows = paraformer_timestamp_to_sentences([{
                    "text": "你 好 I want to make a call", "timestamp": timestamps,
                }], {"start": 10, "end": 15}, None)
                self.assertEqual(rows[0]["text"], "你好 I want to make a call")
                self.assertEqual((rows[0]["start"], rows[0]["end"]), (10, 15))

    def test_rebuilds_timestamps_from_punctuated_text_and_ascii_word_tokens(self):
        segments = paraformer_full_text_to_segments({
            "text": "你好，staff！再见。",
            "timestamp": [
                [1000, 1200],
                [1200, 1500],
                [1600, 2100],
                [2300, 2500],
                [2500, 2800],
            ],
        })

        self.assertEqual(segments, [
            {
                "start": 0.97,
                "end": 2.19,
                "text": "你好，staff！",
                "time_unit": "seconds",
            },
            {
                "start": 2.27,
                "end": round(3.05 + PAD + HOLD, 3),
                "text": "再见。",
                "time_unit": "seconds",
            },
        ])

    def test_punctuation_formatting_changes_keep_character_timestamps(self):
        diagnostics = {}
        punc = Mock()
        punc.generate.return_value = [{"text": "你好，don't stop。"}]
        rows = paraformer_timestamp_to_sentences([{
            "text": "你 好 dont stop",
            "timestamp": [[1000, 1200], [1200, 1500], [1500, 1800], [1800, 2100]],
        }], {"start": 5, "end": 8, "timing_diagnostics": diagnostics}, punc, 80)

        self.assertEqual(rows, [{
            "start": 5.97,
            "end": round(7.1 + PAD + HOLD, 3),
            "text": "你好，don't stop。",
            "time_unit": "seconds",
            "speaker": None,
            "speaker_score": None,
        }])
        self.assertEqual(diagnostics, {"sources": {"char_timestamp": 1}})

    def test_true_word_replacement_uses_chunk_fallback_and_records_reason(self):
        diagnostics = {}
        punc = Mock()
        punc.generate.return_value = [{"text": "你号。"}]
        rows = paraformer_timestamp_to_sentences([{
            "text": "你好",
            "timestamp": [[1000, 1200], [1200, 1500]],
        }], {"start": 5, "end": 8, "timing_diagnostics": diagnostics}, punc)

        self.assertEqual(rows[0]["text"], "你号。")
        self.assertEqual((rows[0]["start"], rows[0]["end"]), (5, 8))
        self.assertEqual(diagnostics, {
            "sources": {"chunk_fallback": 1},
            "fallback_reasons": {"token_mismatch": 1},
        })

    def test_rejects_full_text_when_token_count_does_not_match_timestamps(self):
        self.assertEqual(paraformer_full_text_to_segments({
            "text": "无法可靠对齐",
            "timestamp": [[0, 100]],
        }), [])

    def test_speaker_intervals_use_vad_with_paraformer_sentence_boundaries(self):
        result = {
            "text": "你好。我是露露。",
            "timestamp": [
                [0, 200],
                [200, 400],
                [500, 700],
                [700, 900],
                [900, 1100],
                [1100, 1300],
            ],
        }
        sentence_info = [
            {"start": 0, "end": 5000, "text": "你好。我是露露。"},
        ]

        intervals, boundaries, source = select_paraformer_speaker_intervals(
            result,
            sentence_info,
            vad_intervals=[
                {"start": 0.1, "end": 1.4},
                {"start": 2.0, "end": 4.8},
            ],
            max_subtitle_chars=4,
        )

        self.assertEqual(
            source,
            "funasr_vad+paraformer_subtitle_timestamps",
        )
        self.assertEqual(intervals, [
            {"start": 0.1, "end": 1.4},
            {"start": 2.0, "end": 4.8},
        ])
        self.assertEqual(boundaries, [
            {"start": 0.0, "end": 0.39},
            {"start": 0.47, "end": 0.79},
            {"start": 0.87, "end": 1.77},
        ])

    def test_extracts_fun_asr_vad_output_in_seconds(self):
        intervals = extract_vad_speaker_intervals([
            {
                "key": "recording",
                "value": [[100, 1400], [2000, 4800]],
            }
        ])

        self.assertEqual(intervals, [
            {"start": 0.1, "end": 1.4},
            {"start": 2.0, "end": 4.8},
        ])

if __name__ == "__main__":
    unittest.main()
