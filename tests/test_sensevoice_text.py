import os
import sys
import unittest


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PYTHON_SCRIPT_DIR = os.path.join(PROJECT_ROOT, "src", "scripts", "python")
if PYTHON_SCRIPT_DIR not in sys.path:
    sys.path.insert(0, PYTHON_SCRIPT_DIR)

from sensevoice_paraformer import (
    extract_vad_speaker_intervals,
    normalize_model_results_with_meta,
    paraformer_full_text_to_segments,
    select_paraformer_speaker_intervals,
)
from sensevoice_text import extract_sensevoice_metadata, normalize_segments


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
                "start": 1.0,
                "end": 2.1,
                "text": "你好，staff！",
                "time_unit": "seconds",
            },
            {
                "start": 2.3,
                "end": 2.8,
                "text": "再见。",
                "time_unit": "seconds",
            },
        ])

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
            {"start": 0.0, "end": 0.4},
            {"start": 0.5, "end": 1.3},
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
