import os
import sys
import unittest
from unittest import mock


sys.path.insert(0, os.path.dirname(__file__))

from sensevoice_paraformer import install_paraformer_timing_probe
from sensevoice_runtime import AsrResourceGuard, CpuThrottle, GpuThrottle, ResourcePeakMonitor


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


class AsrResourceGuardTests(unittest.TestCase):
    def test_waits_while_configured_game_process_is_running(self):
        observations = iter([
            {"DeltaForceClient-Win64-Shipping.exe"},
            set(),
        ])
        sleeps = []
        guard = AsrResourceGuard(
            {
                "resource_guard": {
                    "enabled": True,
                    "game_process_names": ["DeltaForceClient-Win64-Shipping"],
                    "wait_s": 2,
                    "max_wait_s": 10,
                }
            },
            process_names_fn=lambda: next(observations),
            sleep_fn=sleeps.append,
            monotonic_fn=lambda: 100,
        )

        waited = guard.wait_if_game_active("模型加载")

        self.assertEqual(waited, 2)
        self.assertEqual(sleeps, [2.0])

    def test_disabled_guard_does_not_query_processes(self):
        guard = AsrResourceGuard(
            {"resource_guard": {"enabled": False}},
            process_names_fn=lambda: self.fail("disabled guard should not inspect tasklist"),
        )

        self.assertEqual(guard.wait_if_game_active("模型加载"), 0)


class GpuThrottleTests(unittest.TestCase):
    def test_soft_pressure_shrinks_only_speaker_and_emotion_batches(self):
        payload = {
            "gpu_throttle": {
                "enabled": True,
                "soft_gpu": {"enabled": True},
                "low_impact": {
                    "batch_size_s": 30,
                    "speaker_batch_size": 8,
                    "emotion_batch_size_s": 24,
                },
            }
        }
        throttle = GpuThrottle(payload, "cuda", sleep_fn=lambda _seconds: None)

        self.assertEqual(throttle.batch_size_for("speaker", 64), 64)
        self.assertEqual(throttle.batch_size_for("emotion", 300), 300)

        throttle.soft_pressure = True
        self.assertEqual(throttle.batch_size_for("speaker", 64), 8)
        self.assertEqual(throttle.batch_size_for("emotion", 300), 24)
        self.assertEqual(throttle.batch_size_for("paraformer", 180), 30)

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

    def test_soft_gpu_pressure_shrinks_batch_and_yields_without_waiting(self):
        payload = {
            "gpu_throttle": {
                "enabled": True,
                "hard_wait": False,
                "soft_gpu": {
                    "enabled": True,
                    "sm_threshold": 40,
                },
                "low_impact": {
                    "batch_size_s": 30,
                    "yield_s": 0.25,
                },
            },
            "interactive_batch_size_s": 180,
        }
        sleeps = []
        throttle = GpuThrottle(payload, "cuda", sleep_fn=sleeps.append)
        throttle.last_check_at = -100
        throttle._sample_gpu_processes = mock.Mock(return_value=[{
            "pid": 9999,
            "type": "C+G",
            "sm": None,
            "mem": None,
            "fb_mb": 0,
            "name": "game.exe",
        }])
        throttle._sample_gpu_summary = mock.Mock(return_value={
            "gpu_util": 85,
            "memory_used_mb": 12000,
            "memory_total_mb": 16384,
        })

        waited = throttle.wait_if_busy("ASR batch")

        self.assertEqual(waited, 0)
        self.assertTrue(throttle.soft_pressure)
        self.assertEqual(payload["interactive_batch_size_s"], 30)
        self.assertEqual(sleeps, [0.25])

    def test_soft_gpu_pressure_ignores_total_utilization_when_only_asr_is_visible(self):
        payload = {
            "gpu_throttle": {
                "enabled": True,
                "soft_gpu": {"enabled": True, "sm_threshold": 40},
            }
        }
        throttle = GpuThrottle(payload, "cuda", sleep_fn=lambda _seconds: None)
        throttle.last_check_at = -100
        throttle.self_pids = {1234}
        throttle._sample_gpu_processes = mock.Mock(return_value=[{
            "pid": 1234,
            "type": "C",
            "sm": 90,
            "mem": 90,
            "fb_mb": 6000,
            "name": "python.exe",
        }])
        throttle._sample_gpu_summary = mock.Mock(return_value={
            "gpu_util": 95,
            "memory_used_mb": 14000,
            "memory_total_mb": 16384,
        })

        throttle.wait_if_busy("ASR batch")

        self.assertFalse(throttle.soft_pressure)
        self.assertNotIn("interactive_batch_size_s", payload)
        throttle._sample_gpu_summary.assert_not_called()

    def test_soft_gpu_pressure_detects_high_total_memory_even_when_utilization_is_low(self):
        payload = {
            "gpu_throttle": {
                "enabled": True,
                "soft_gpu": {
                    "enabled": True,
                    "sm_threshold": 40,
                    "total_memory_threshold_pct": 75,
                },
                "low_impact": {"batch_size_s": 30, "yield_s": 0},
            }
        }
        throttle = GpuThrottle(payload, "cuda", sleep_fn=lambda _seconds: None)
        throttle.last_check_at = -100
        throttle._sample_gpu_processes = mock.Mock(return_value=[{
            "pid": 9999,
            "type": "C+G",
            "sm": None,
            "mem": None,
            "fb_mb": 0,
            "name": "game.exe",
        }])
        throttle._sample_gpu_summary = mock.Mock(return_value={
            "gpu_util": 10,
            "memory_used_mb": 13000,
            "memory_total_mb": 16384,
        })

        throttle.wait_if_busy("模型加载")

        self.assertTrue(throttle.soft_pressure)
        self.assertEqual(payload["interactive_batch_size_s"], 30)

    def test_model_load_gap_wait_is_bounded_and_keeps_low_impact_mode(self):
        payload = {
            "gpu_throttle": {
                "enabled": True,
                "soft_gpu": {"enabled": True},
                "low_impact": {
                    "batch_size_s": 30,
                    "yield_s": 0,
                    "model_load_max_wait_s": 2,
                    "model_load_poll_s": 1,
                },
            }
        }
        sleeps = []
        throttle = GpuThrottle(payload, "cuda", sleep_fn=sleeps.append)
        throttle.last_check_at = -100
        throttle._sample_pressure = mock.Mock(side_effect=[
            (False, True, "", "game"),
            (False, True, "", "game"),
            (False, True, "", "game"),
        ])

        throttle.wait_if_busy("模型加载")
        waited = throttle.wait_for_model_load_gap("模型加载")

        self.assertEqual(waited, 2)
        self.assertEqual(sleeps, [1, 1])
        self.assertTrue(throttle.soft_pressure)


class ResourcePeakMonitorTests(unittest.TestCase):
    def test_short_stage_takes_a_final_gpu_sample(self):
        payload = {
            "resource_peak_monitor": {
                "enabled": True,
                "sample_interval_s": 10,
            }
        }

        class FakeGpuThrottle:
            def __init__(self):
                self.calls = 0

            def sample_gpu_telemetry(self):
                self.calls += 1
                return {
                    "gpu_util_pct": 91,
                    "memory_used_mb": 4096,
                    "temperature_c": 52,
                    "power_w": 44,
                }

        throttle = FakeGpuThrottle()
        with ResourcePeakMonitor(payload, "短阶段", gpu_throttle=throttle):
            pass

        self.assertEqual(throttle.calls, 1)
        self.assertEqual(payload["_resource_peaks"]["短阶段"]["gpu_util_peak_pct"], 91)


if __name__ == "__main__":
    unittest.main()
