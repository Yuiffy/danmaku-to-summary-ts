import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


PYTHON_DIR = Path(__file__).resolve().parents[1] / "src" / "scripts" / "python"
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from sensevoice_emotion import (  # noqa: E402
    _cuda_tf32_context,
    _generate_emotion_batch,
    analyze_paraformer_emotions,
    build_duration_batches,
    merge_segments_to_emotion_chunks,
    project_emotion_timeline_to_segments,
)


class FakeSenseVoiceModel:
    loads = 0
    generate_calls = 0
    generate_kwargs = []

    def __init__(self, **_kwargs):
        type(self).loads += 1

    def generate(self, input, **_kwargs):
        type(self).generate_calls += 1
        type(self).generate_kwargs.append(dict(_kwargs))
        tags = [
            "<|zh|><|HAPPY|><|Laughter|><|withitn|>第一段",
            "<|zh|><|SURPRISED|><|Speech|><|withitn|>第二段",
        ]
        return [{"text": tags[index % len(tags)]} for index in range(len(input))]


class BrokenSenseVoiceModel:
    def __init__(self, **_kwargs):
        raise RuntimeError("model unavailable")


class SenseVoiceEmotionTests(unittest.TestCase):
    def setUp(self):
        FakeSenseVoiceModel.loads = 0
        FakeSenseVoiceModel.generate_calls = 0
        FakeSenseVoiceModel.generate_kwargs = []

    def test_merges_nearby_segments_without_crossing_chunk_limit(self):
        chunks = merge_segments_to_emotion_chunks([
            {"start": 0, "end": 3, "text": "一"},
            {"start": 3.5, "end": 7, "text": "二"},
            {"start": 8, "end": 13, "text": "三"},
            {"start": 20, "end": 23, "text": "四"},
        ], chunk_s=12, max_gap_s=1.5)

        self.assertEqual([(item["start"], item["end"]) for item in chunks], [
            (0.0, 7.0),
            (8.0, 13.0),
            (20.0, 23.0),
        ])
        self.assertEqual(chunks[0]["segment_indices"], [0, 1])

    def test_duration_batches_preserve_order_and_limits(self):
        chunks = [
            {"start": 0, "end": 4},
            {"start": 5, "end": 10},
            {"start": 11, "end": 16},
        ]
        batches = build_duration_batches(chunks, max_batch_duration_s=9, max_batch_chunks=2)
        self.assertEqual([[item["start"] for item in batch] for batch in batches], [[0, 5], [11]])

    def test_projects_dominant_emotion_and_union_of_events(self):
        segments = [{"start": 1, "end": 6, "text": "测试"}]
        project_emotion_timeline_to_segments(segments, [
            {"start": 0, "end": 2, "emotion": "HAPPY", "events": ["Laughter"]},
            {"start": 2, "end": 8, "emotion": "SAD", "events": ["Cry"]},
        ])
        self.assertEqual(segments[0]["emotion"], "SAD")
        self.assertEqual(segments[0]["events"], ["Laughter", "Cry"])

    def test_analysis_batches_tags_and_reuses_runtime_model_cache(self):
        payload = {
            "emotion_analysis": {
                "enabled": True,
                "model": "iic/SenseVoiceSmall",
                "chunk_s": 4,
                "max_gap_s": 0,
                "batch_size_s": 20,
                "max_batch_chunks": 8,
                "inference_batch_size": 8,
                "precision": "fp32",
                "tf32": False,
            }
        }
        segments = [
            {"start": 0, "end": 3, "text": "一"},
            {"start": 5, "end": 8, "text": "二"},
        ]
        cache = {}
        loader = lambda _path: ([0.0] * (10 * 16000), 16000)

        first = analyze_paraformer_emotions(
            payload,
            "fake.wav",
            segments,
            "cpu",
            runtime_cache=cache,
            auto_model_cls=FakeSenseVoiceModel,
            audio_loader=loader,
        )
        second_payload = {"emotion_analysis": dict(payload["emotion_analysis"])}
        second = analyze_paraformer_emotions(
            second_payload,
            "fake.wav",
            [{"start": 0, "end": 3, "text": "一"}],
            "cpu",
            runtime_cache=cache,
            auto_model_cls=FakeSenseVoiceModel,
            audio_loader=loader,
        )

        self.assertEqual(first["status"], "completed")
        self.assertEqual(first["emotionCounts"], {"HAPPY": 1, "SURPRISE": 1})
        self.assertEqual(segments[0]["events"], ["Laughter"])
        self.assertEqual(FakeSenseVoiceModel.loads, 1)
        self.assertFalse(first["modelCacheHit"])
        self.assertTrue(second["modelCacheHit"])
        self.assertEqual(first["inferenceBatchSize"], 8)
        self.assertEqual(
            [kwargs["batch_size"] for kwargs in FakeSenseVoiceModel.generate_kwargs],
            [8, 8],
        )

    def test_bf16_failure_retries_only_current_batch_in_fp32(self):
        class FakeAutocast:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        class FakeTorch:
            bfloat16 = object()

            @staticmethod
            def autocast(**_kwargs):
                return FakeAutocast()

        class FailingBf16Model:
            def __init__(self):
                self.calls = []

            def generate(self, **kwargs):
                self.calls.append(kwargs)
                if len(self.calls) == 1:
                    raise RuntimeError("BF16 kernel unavailable")
                return [{"text": "<|HAPPY|><|Speech|>回退成功"}]

        model = FailingBf16Model()
        results, fallback = _generate_emotion_batch(
            model,
            [[0.0, 0.0]],
            {"inference_batch_size": 8},
            20,
            "bf16",
            torch_module=FakeTorch,
        )

        self.assertTrue(fallback)
        self.assertEqual(results[0]["text"], "<|HAPPY|><|Speech|>回退成功")
        self.assertEqual(len(model.calls), 2)
        self.assertEqual(model.calls[0]["batch_size"], 8)
        self.assertEqual(model.calls[1]["batch_size"], 8)

    def test_tf32_context_restores_previous_torch_settings(self):
        fake_torch = SimpleNamespace(
            backends=SimpleNamespace(
                cuda=SimpleNamespace(matmul=SimpleNamespace(allow_tf32=False)),
                cudnn=SimpleNamespace(allow_tf32=False),
            ),
            get_float32_matmul_precision=lambda: "highest",
            set_float32_matmul_precision=lambda value: setattr(fake_torch, "precision", value),
            precision="highest",
        )

        with _cuda_tf32_context("cuda", True, fake_torch) as enabled:
            self.assertTrue(enabled)
            self.assertTrue(fake_torch.backends.cuda.matmul.allow_tf32)
            self.assertTrue(fake_torch.backends.cudnn.allow_tf32)
            self.assertEqual(fake_torch.precision, "high")

        self.assertFalse(fake_torch.backends.cuda.matmul.allow_tf32)
        self.assertFalse(fake_torch.backends.cudnn.allow_tf32)
        self.assertEqual(fake_torch.precision, "highest")

    def test_failure_is_recorded_without_discarding_paraformer_segments(self):
        payload = {
            "emotion_analysis": {
                "enabled": True,
                "fail_open": True,
            }
        }
        segments = [{"start": 0, "end": 2, "text": "原字幕"}]
        result = analyze_paraformer_emotions(
            payload,
            "fake.wav",
            segments,
            "cpu",
            auto_model_cls=BrokenSenseVoiceModel,
            audio_loader=lambda _path: ([0.0] * 32000, 16000),
        )
        self.assertEqual(result["status"], "failed")
        self.assertIn("model unavailable", result["error"])
        self.assertEqual(segments, [{"start": 0, "end": 2, "text": "原字幕"}])

    def test_room_allowlist_blocks_other_rooms_before_loading_audio_or_model(self):
        payload = {
            "room_id": "26966466",
            "emotion_analysis": {
                "enabled": True,
                "room_ids": ["25788785"],
            },
        }
        result = analyze_paraformer_emotions(
            payload,
            "fake.wav",
            [{"start": 0, "end": 2, "text": "不应分析"}],
            "cpu",
            auto_model_cls=BrokenSenseVoiceModel,
            audio_loader=lambda _path: self.fail("audio should not be loaded"),
        )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
