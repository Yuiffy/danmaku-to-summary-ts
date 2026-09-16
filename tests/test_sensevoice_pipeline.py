import sys
import unittest
from pathlib import Path
from unittest.mock import patch

PYTHON_DIR = Path(__file__).resolve().parents[1] / "src/scripts/python"
sys.path.insert(0, str(PYTHON_DIR))

from sensevoice_pipeline import transcribe_sensevoice_batches


class RecordingModel:
    def __init__(self, bad_batch=None, fail_single=False):
        self.calls = []
        self.bad_batch = bad_batch
        self.fail_single = fail_single

    def generate(self, input, **kwargs):
        self.calls.append((input, kwargs))
        if isinstance(input, list):
            if self.bad_batch == "exception":
                raise RuntimeError("CUDA out of memory")
            if self.bad_batch == "short":
                return [{"text": "wrongly aligned"}]
            if self.bad_batch == "malformed":
                return [{"text": "first"}, None]
            return [self.result(value) for value in input]
        if self.fail_single:
            raise RuntimeError("single failed")
        return [self.result(input)]

    @staticmethod
    def result(value):
        return {"text": f"<|zh|><|HAPPY|><|Speech|><|withitn|>speech {value}"}


class SenseVoicePipelineBatchTests(unittest.TestCase):
    def setUp(self):
        self.payload = {"resource_peak_monitor": {"enabled": False}, "inference_batch_size": 8}

    def run_batch(self, model, chunks, metas, throttle=None):
        return transcribe_sensevoice_batches(model, self.payload, chunks, metas, None, "cpu", throttle)

    def test_preserves_text_emotion_and_each_chunks_time_window(self):
        model = RecordingModel()
        metas = [{"start": 12, "end": 14}, {"start": 50, "end": 55}]
        rows = self.run_batch(model, ["first", "second"], metas)
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(model.calls[0][1]["batch_size"], 2)
        self.assertEqual([r["text"] for r in rows], ["speech first", "speech second"])
        self.assertEqual([(r["start"], r["end"]) for r in rows], [(12, 14), (50, 55)])
        self.assertTrue(all(r["emotion"] == "HAPPY" and r["events"] == ["Speech"] for r in rows))

    def test_limits_chunk_count_and_supports_single_chunk_rollback(self):
        self.payload["inference_batch_size"] = 2
        metas = [{"start": i * 10, "end": i * 10 + 3} for i in range(5)]
        model = RecordingModel()
        self.run_batch(model, list("abcde"), metas)
        self.assertEqual([kwargs["batch_size"] for _, kwargs in model.calls], [2, 2, 1])
        self.payload["inference_batch_size"] = 1
        model = RecordingModel()
        self.run_batch(model, list("abcde"), metas)
        self.assertEqual([value for value, _ in model.calls], list("abcde"))

    def test_gpu_pressure_limits_padded_duration_before_every_batch(self):
        class Throttle:
            waits = 0

            def wait_if_busy(self, _stage):
                self.waits += 1

            def batch_size_for(self, kind, requested):
                self.kind = kind
                return 12 if self.waits == 1 else 3

        throttle = Throttle()
        model = RecordingModel()
        metas = [{"start": 0, "end": 1}, {"start": 10, "end": 18}, {"start": 20, "end": 22}]
        self.run_batch(model, list("abc"), metas, throttle)
        self.assertEqual([value for value, _ in model.calls], list("abc"))
        self.assertEqual(throttle.waits, 3)
        self.assertEqual(throttle.kind, "sensevoice")

    def test_failed_or_misaligned_batch_is_retried_without_duplicate_subtitles(self):
        for problem in ("exception", "short", "malformed"):
            with self.subTest(problem=problem):
                self.payload.pop("_sensevoice_batch_disabled", None)
                self.payload["_timings"] = {}
                model = RecordingModel(bad_batch=problem)
                rows = self.run_batch(model, ["a", "b"], [{"start": 0, "end": 2}, {"start": 7, "end": 9}])
                self.assertEqual([r["text"] for r in rows], ["speech a", "speech b"])
                self.assertEqual([value for value, _ in model.calls], [["a", "b"], "a", "b"])
                self.assertEqual(self.payload["_timings"]["sensevoice_batch_fallbacks"], 1)
                self.run_batch(model, ["c", "d"], [{"start": 10, "end": 12}, {"start": 17, "end": 19}])
                self.assertEqual([value for value, _ in model.calls[-2:]], ["c", "d"])

    def test_empty_text_does_not_shift_the_next_result_to_another_chunk(self):
        model = RecordingModel()
        with patch.object(model, "generate", return_value=[{"text": ""}, {"text": "second"}]):
            rows = self.run_batch(model, ["a", "b"], [{"start": 0, "end": 2}, {"start": 7, "end": 9}])
        self.assertEqual([(r["text"], r["start"]) for r in rows], [("second", 7)])

    def test_single_failure_propagates_and_input_mismatch_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "single failed"):
            self.run_batch(RecordingModel(fail_single=True), ["a"], [{"start": 0, "end": 2}])
        with self.assertRaisesRegex(ValueError, "count mismatch"):
            self.run_batch(RecordingModel(), ["a"], [])


if __name__ == "__main__":
    unittest.main()
