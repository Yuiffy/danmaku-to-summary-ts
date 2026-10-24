import os
import queue
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts/python'))
from asr_device_handoff import HandoffInterrupted, ModelWorker
from asr_handoff_gpu import external_engines
from asr_handoff_policy import BoundaryPolicy, batch_settings, settings
from asr_handoff_resources import ResourceMonitor

IDLE = {'gpu_idle': True, 'game_running': False, 'available_gb': 24}


class InterruptTests(unittest.TestCase):
    def test_gpu_uses_configured_batch_cpu_keeps_small_background_batch(self):
        payload = {'batch_size_s': 600, 'batch_size_threshold_s': 60}
        self.assertEqual(batch_settings(payload, 'cuda'), (600, 60))
        self.assertEqual(batch_settings(payload, 'cpu'), (30, 30))

    def test_gpu_own_load_excluded_and_external_processes_grouped_per_engine(self):
        rows = [('pid_123_luid_a_phys_0_eng_0_engtype_3D', 99, 0),
                ('pid_456_luid_a_phys_0_eng_0_engtype_3D', 30, 0),
                ('pid_789_luid_a_phys_0_eng_0_engtype_3D', 20, 1),
                ('pid_456_luid_a_phys_0_eng_1_engtype_Copy', 40, 0),
                ('pid_789_luid_a_phys_0_eng_0_engtype_3D', 100, 5)]
        self.assertEqual(external_engines(rows, 123), 50)

    def test_cpu_promotes_only_after_idle_stability_gpu_retreat_debounced_except_memory(self):
        policy = BoundaryPolicy(settings({}))
        for at in range(0, 46, 5): policy.observe(IDLE, at)
        self.assertEqual(policy.interrupt_target('cpu', IDLE, 45, 1000), 'cuda')
        self.assertIsNone(policy.interrupt_target('cpu', IDLE, 45, 100))
        busy = {**IDLE, 'gpu_idle': False}
        policy.observe(busy, 50)
        self.assertIsNone(policy.interrupt_target('cuda', busy, 50, 1000))
        self.assertEqual(policy.choose('cuda', busy, 50, 1000), 'cuda')
        policy.observe(busy, 55)
        self.assertEqual(policy.interrupt_target('cuda', busy, 55, 1000), 'cpu')
        self.assertIsNone(policy.interrupt_target('cuda', busy, 100, 1000))
        policy.observe(IDLE, 105)
        self.assertIsNone(policy.interrupt_target('cpu', IDLE, 105, 1000))
        urgent = {**busy, 'memory_pressure': True, 'available_gb': 3}
        policy.observe(urgent, 110)
        self.assertEqual(policy.interrupt_target('cuda', urgent, 110, 1000), 'wait')

    def test_gpu_released_without_ram_requires_full_idle_before_reloading(self):
        policy = BoundaryPolicy(settings({}))
        policy.gpu_suspended = True
        sample = {**IDLE, 'available_gb': 3}
        for at in range(0, 45, 5):
            policy.observe(sample, at)
            self.assertEqual(policy.choose('cuda', sample, at, 1000), 'wait')
        policy.observe(sample, 45)
        self.assertEqual(policy.choose('cuda', sample, 45, 1000), 'cuda')

    def test_resource_sampling_ignores_self_utilization_and_memory_without_boundary_sleep(self):
        monitor = ResourceMonitor({}, settings({}))
        monitor.owner_pid = 123
        with patch('asr_handoff_resources.available_memory_gb', return_value=24), \
             patch.object(monitor.counters, 'sample', return_value={'external_util_pct': 5, 'owned_gpu_mb': 6000}), \
             patch('asr_handoff_resources.subprocess.run', return_value=type('Result', (), {'stdout': '99, 14000, 16000'})()), \
             patch('asr_handoff_resources.time.sleep') as sleep:
            sample = monitor.sample()
            self.assertTrue(sample['gpu_idle'])
            monitor.samples.append((time.monotonic(), sample))
            self.assertTrue(monitor.snapshot(BoundaryPolicy(settings({})), 'cuda')['gpu_idle'])
            sleep.assert_not_called()
        monitor.counters.close()

    def test_no_attribution_does_not_treat_own_gpu_utilization_as_external_in_flight(self):
        monitor = ResourceMonitor({}, settings({}))
        monitor.owner_pid, monitor.owned_gpu_mb = 123, 6000
        with patch('asr_handoff_resources.available_memory_gb', return_value=24), \
             patch.object(monitor.counters, 'sample', return_value=None), \
             patch('asr_handoff_resources.subprocess.run', return_value=type('Result', (), {'stdout': '99, 14000, 16000'})()):
            self.assertIsNone(monitor.sample()['gpu_idle'])
            self.assertFalse(monitor.sample(quiet=True)['gpu_idle'])
        monitor.counters.close()

    def test_model_request_can_be_interrupted_and_busy_process_is_reaped(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'worker.py'
            script.write_text('import sys,json,time\nfor line in sys.stdin:\n'
                ' r=json.loads(line)\n if r["op"]=="close": break\n'
                ' if r["op"]=="window": time.sleep(30)\n'
                ' print(json.dumps({"ready":True}),flush=True)\n', encoding='utf-8')
            original = subprocess.Popen
            def spawn(args, **kwargs):
                kwargs['stderr'] = None
                return original([args[0], str(script)], **kwargs)
            with patch('asr_device_handoff.subprocess.Popen', side_effect=spawn):
                worker = ModelWorker({}, 'cpu', 5)
                started = time.monotonic()
                try:
                    with self.assertRaises(HandoffInterrupted):
                        worker.request({'op': 'window'}, interrupt=lambda: 'cuda')
                finally:
                    worker.abort()
                self.assertLess(time.monotonic() - started, 3)
                self.assertIsNotNone(worker.process.poll())
                worker.close()  # Cleanup is idempotent, including broken pipes.

    def test_response_arriving_during_pressure_check_wins_over_cancellation(self):
        from io import StringIO
        from types import SimpleNamespace
        worker = ModelWorker.__new__(ModelWorker)
        worker.process = SimpleNamespace(stdin=StringIO())
        worker.responses, worker.timeout = queue.Queue(), 5
        def pressure():
            worker.responses.put({'chunk': {'end': 120}})
            return 'cpu'
        self.assertEqual(worker.request({'op': 'window'}, interrupt=pressure), {'chunk': {'end': 120}})


if __name__ == '__main__': unittest.main()
