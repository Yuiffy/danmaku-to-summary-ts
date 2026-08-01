import os
import sys
import unittest
from unittest import mock


sys.path.insert(0, os.path.dirname(__file__))

from sensevoice_paraformer import install_paraformer_timing_probe
from sensevoice_runtime import CpuThrottle, GpuThrottle


class RecordingThrottle:
    def __init__(self, waited=0):
        self.waited = waited
        self.stages = []

    def wait_if_busy(self, stage):
        self.stages.append(stage)
        return self.waited


class FakeModel:
    def __init__(self):
        self.model = object()
        self.vad_model = object()
        self.punc_model = object()
        self.spk_model = object()
        self.calls = []

    def inference(self, *args, **kwargs):
        self.calls.append(kwargs.get("model"))
        return []


class ParaformerResourceProbeTests(unittest.TestCase):
    def test_checks_the_matching_resource_before_each_inference_stage(self):
        model = FakeModel()
        gpu = RecordingThrottle(waited=1.5)
        cpu = RecordingThrottle(waited=2.0)
        model._danmaku_timing_collector = {}
        install_paraformer_timing_probe(model, gpu_throttle=gpu, cpu_throttle=cpu)

        model.inference("audio", model=model.vad_model)
        model.inference("audio", model=model.model)
        model.inference("audio", model=model.model)
        model.inference("text", model=model.punc_model)
        model.inference("audio", model=model.spk_model)

        self.assertEqual(len(cpu.stages), 1)
        self.assertIn("VAD (CPU)", cpu.stages[0])
        self.assertEqual(len(gpu.stages), 4)
        self.assertIn("ASR batch (CUDA) #1", gpu.stages[0])
        self.assertIn("ASR batch (CUDA) #2", gpu.stages[1])
        self.assertIn("标点恢复 (CUDA)", gpu.stages[2])
        self.assertIn("说话人嵌入 (CUDA)", gpu.stages[3])
        self.assertEqual(model._danmaku_timing_collector["vad_cpu_wait_s"], 2.0)
        self.assertEqual(model._danmaku_timing_collector["asr_gpu_wait_s"], 3.0)

    def test_cached_probe_uses_the_latest_throttle_instances(self):
        model = FakeModel()
        old_gpu = RecordingThrottle()
        new_gpu = RecordingThrottle()
        install_paraformer_timing_probe(model, gpu_throttle=old_gpu)
        install_paraformer_timing_probe(model, gpu_throttle=new_gpu)

        model.inference("audio", model=model.model)

        self.assertEqual(old_gpu.stages, [])
        self.assertEqual(len(new_gpu.stages), 1)


class CpuThrottleTests(unittest.TestCase):
    def test_waits_for_consecutive_busy_and_idle_samples(self):
        samples = iter([85, 90, 70, 55, 50])
        sleeps = []
        throttle = CpuThrottle(
            {
                "cpu_throttle": {
                    "enabled": True,
                    "busy_percent_threshold": 80,
                    "resume_percent_threshold": 60,
                    "check_interval_s": 0,
                    "wait_s": 5,
                    "consecutive_busy_samples": 2,
                    "consecutive_idle_samples": 2,
                }
            },
            sample_fn=lambda: next(samples),
            sleep_fn=sleeps.append,
            monotonic_fn=lambda: 100,
        )
        throttle.last_check_at = -100

        waited = throttle.wait_if_busy("VAD")

        self.assertEqual(waited, 10)
        self.assertEqual(sleeps, [5, 5])
        self.assertFalse(throttle.last_busy)

    def test_idle_sample_continues_without_waiting(self):
        throttle = CpuThrottle(
            {"cpu_throttle": {"enabled": True}},
            sample_fn=lambda: 25,
            sleep_fn=lambda _seconds: self.fail("idle CPU should not sleep"),
            monotonic_fn=lambda: 100,
        )
        throttle.last_check_at = -100

        self.assertEqual(throttle.wait_if_busy("VAD"), 0)


class GpuThrottleTests(unittest.TestCase):
    def test_returns_the_observed_wait_duration(self):
        throttle = GpuThrottle(
            {
                "gpu_throttle": {
                    "enabled": True,
                    "wait_s": 1,
                    "check_interval_s": 1,
                }
            },
            "cuda",
        )
        throttle.last_check_at = -100
        throttle._is_gpu_busy = mock.Mock(side_effect=[(True, "game"), (False, "")])

        with mock.patch("sensevoice_runtime.time.sleep") as sleep:
            waited = throttle.wait_if_busy("ASR batch")

        self.assertEqual(waited, 1)
        sleep.assert_called_once_with(1.0)


if __name__ == "__main__":
    unittest.main()
