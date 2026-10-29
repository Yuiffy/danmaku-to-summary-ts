import copy
import importlib.util
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts/python'))
from asr_device_handoff import ModelWorker, transcribe_handoff
from asr_handoff_checkpoint import Checkpoint, checkpoint_lock
from asr_handoff_policy import BoundaryPolicy, settings, supported
from asr_handoff_resources import ResourceMonitor
from live_asr_cache import atomic_json, cache_path, model_spec, source_identity


def chunk(start, end, text='测试'):
    return {'start': start, 'end': end, 'result': {'text': text,
        'sentence_info': [{'text': text, 'start': 0, 'end': min(1000, (end-start)*1000)}]}}


IDLE = {'gpu_idle': True, 'game_running': False, 'available_gb': 24}
BUSY = {**IDLE, 'gpu_idle': False}


class HandoffTests(unittest.TestCase):
    def test_only_explicit_standard_paraformer_can_handoff(self):
        base = {'backend': 'paraformer', 'device_handoff': {'enabled': True}}
        self.assertTrue(supported(base))
        for override in ({'backend': 'sensevoice'}, {'backend': 'moss'}, {'device': 'cpu'},
                         {'model': 'custom'}, {'finetuned_model': 'model.pt'},
                         {'model_profile': 'finetuned'}, {'device_handoff': {'enabled': False}}):
            self.assertFalse(supported({**base, **override}))

    def test_sustained_idle_remaining_threshold_and_missing_samples(self):
        policy = BoundaryPolicy(settings({}))
        policy.observe(IDLE, 0)
        for now in (10, 20, 30, 40, 45):
            policy.observe(IDLE, now)
        self.assertEqual(policy.choose('cpu', IDLE, 45, 1000), 'cuda')
        self.assertEqual(policy.choose('cpu', IDLE, 45, 100), 'cpu')
        policy.observe({'gpu_idle': None, 'game_running': None}, 46)
        self.assertEqual(policy.choose('cpu', IDLE, 47, 1000), 'cpu')
        policy.observe(IDLE, 100)  # A long gap must restart the stability window.
        self.assertEqual(policy.choose('cpu', IDLE, 100, 1000), 'cpu')
        self.assertEqual(policy.choose('cuda', BUSY, 100, 1000), 'cpu')
        self.assertEqual(policy.choose('cuda', {**BUSY, 'available_gb': 3}, 100, 1000), 'wait')
        self.assertEqual(policy.choose('cpu', {**IDLE, 'game_running': True}, 100, 1000), 'cpu')

    def test_cpu_model_own_memory_does_not_cause_reload_each_window(self):
        policy = BoundaryPolicy(settings({}))
        sample = {**BUSY, 'available_gb': 8}
        policy.observe(sample, 0)
        self.assertEqual(policy.choose('cpu', sample, 0, 1000), 'wait')
        self.assertEqual(policy.choose('cpu', sample, 0, 1000, cpu_running=True), 'cpu')
        self.assertEqual(policy.choose('cpu', {**sample, 'available_gb': 3}, 0, 1000, cpu_running=True), 'wait')
        self.assertEqual(policy.choose('cuda', sample, 0, 1000), 'wait')

    def test_invalid_settings_rejected(self):
        for value in (0, -1, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                settings({'device_handoff': {'idle_s': value}})

    def run_fake(self, source, samples, *, fail_at=None, live=None, duration=1000, grow_window=False):
        events, timer, calls = [], [0], [0]
        payload = {'backend': 'paraformer', 'audio_path': str(source), 'room_id': '25788785',
            'device_handoff': {'enabled': True, 'idle_s': 30, 'poll_s': 30, 'window_s': 30 if grow_window else 120},
            **({'live_asr': live} if live else {})}
        class Monitor:
            def __init__(self, *_): self.index = 0
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def snapshot(self, policy, current):
                timer[0] = self.index * 30
                value = samples[min(self.index, len(samples)-1)]
                self.index += 1
                policy.observe(value, timer[0])
                return value
        class Worker:
            def __init__(self, original, device, timeout):
                self.device = device
                events.append(('open', device))
            def close(self): events.append(('close', self.device))
            def request(self, value):
                if value['op'] == 'finish':
                    events.append(('finish', self.device))
                    return {'chunks': value['chunks'], 'timings': value['timings']}
                calls[0] += 1
                events.append(('window', self.device, value['start']))
                if calls[0] == fail_at:
                    raise RuntimeError('simulated worker crash')
                if calls[0] == 1 and grow_window:
                    return {'chunk': None}
                return {'chunk': chunk(value['start'], value['start'] + value['duration'])}
        @contextmanager
        def pcm(*_): yield 'fake-pcm'
        try:
            result = transcribe_handoff(payload, worker_factory=Worker, monitor_factory=Monitor,
                probe=lambda _: duration, pcm_factory=pcm, clock=lambda: timer[0], initial_device='cpu', sleep=lambda _: None)
            return result, events
        except Exception as exc:
            exc.events = events
            raise

    def test_cpu_to_gpu_and_back_only_at_committed_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'recording.flv'
            source.write_bytes(b'x' * 150000)
            result, events = self.run_fake(source, [IDLE, IDLE, BUSY, BUSY, BUSY])
            self.assertEqual(events[:7], [('open', 'cpu'), ('window', 'cpu', 0),
                ('close', 'cpu'), ('open', 'cuda'), ('window', 'cuda', 120),
                ('close', 'cuda'), ('open', 'cpu')])
            self.assertEqual(result['timings']['handoff_switches'], 2)
            self.assertEqual(result['timings']['handoff_cpu_audio_s'], 880)
            self.assertEqual(result['timings']['handoff_gpu_audio_s'], 120)
            self.assertEqual(sum(c['end']-c['start'] for c in result['chunks']), 1000)
            self.assertEqual(sum(e[0] == 'finish' for e in events), 1)

    def test_worker_crash_resumes_without_retranscribing_completed_windows(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'recording.flv'
            source.write_bytes(b'x' * 150000)
            with self.assertRaisesRegex(RuntimeError, 'simulated') as caught:
                self.run_fake(source, [BUSY], fail_at=3)
            saved = json.loads(source.with_suffix('.asr-handoff.json').read_text(encoding='utf-8'))
            self.assertEqual([c['end'] for c in saved['chunks']], [120, 240])
            self.assertEqual(caught.exception.events[-1], ('close', 'cpu'))
            result, events = self.run_fake(source, [IDLE])
            self.assertEqual(next(e for e in events if e[0] == 'window')[2], 240)
            self.assertEqual(result['timings']['handoff_reused_audio_s'], 240)
            _, replay = self.run_fake(source, [IDLE])
            self.assertFalse(any(e[0] == 'window' for e in replay))

    def test_live_cache_holes_seed_private_checkpoint_without_writing_live_sidecar(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'recording.flv'
            source.write_bytes(b'x' * 150000)
            value = {'version': 1, 'room_id': '25788785', 'source': source_identity(source),
                'spec': model_spec({}), 'chunks': [chunk(60, 180, '原有字句')]}
            atomic_json(cache_path(source), value)
            old = cache_path(source).read_bytes()
            result, events = self.run_fake(source, [BUSY], duration=300,
                live={'enabled': True, 'room_ids': ['25788785'], 'source_path': str(source)})
            self.assertEqual([e[2] for e in events if e[0] == 'window'], [0, 180])
            self.assertEqual(result['chunks'][1], value['chunks'][0])
            self.assertEqual(cache_path(source).read_bytes(), old)

    def test_checkpoint_rejects_changed_source_model_and_overlap(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'recording.flv'
            source.write_bytes(b'x' * 150000)
            payload = {'audio_path': str(source)}
            cp = Checkpoint(payload, 300, lambda _: 300)
            cp.commit(chunk(0, 120))
            with self.assertRaises(ValueError): cp.commit(chunk(100, 200))
            with self.assertRaisesRegex(ValueError, 'mismatch'):
                Checkpoint({**payload, 'punc_model': 'other'}, 300, lambda _: 300)
            source.write_bytes(b'y' * 150000)
            with self.assertRaisesRegex(ValueError, 'changed'): cp.assert_source_unchanged(payload)
            with self.assertRaisesRegex(ValueError, 'mismatch'): Checkpoint(payload, 300, lambda _: 300)

    def test_unfinished_vad_window_grows_without_committing_or_skipping_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'recording.flv'
            source.write_bytes(b'x' * 150000)
            result, events = self.run_fake(source, [BUSY], duration=90, grow_window=True)
            self.assertEqual([e[2] for e in events if e[0] == 'window'], [0, 0, 60])
            self.assertEqual([(c['start'], c['end']) for c in result['chunks']], [(0, 60), (60, 90)])

    def test_low_ram_waits_without_loading_a_model_and_then_admits_gpu(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'recording.flv'
            source.write_bytes(b'x' * 150000)
            _, events = self.run_fake(source, [{**BUSY, 'available_gb': 3},
                {**IDLE, 'available_gb': 3}, {**IDLE, 'available_gb': 3}])
            self.assertEqual(events[0], ('open', 'cuda'))
            self.assertFalse(any(e == ('open', 'cpu') for e in events))

    def test_checkpoint_lock_is_exclusive_and_released(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'cache.json'
            with checkpoint_lock(target):
                with self.assertRaises(OSError):
                    with checkpoint_lock(target): pass
            with checkpoint_lock(target): pass

    def test_short_final_media_can_checkpoint_without_live_flv_header_reserve(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'short.wav'
            source.write_bytes(b'x' * 32000)
            payload = {'audio_path': str(source)}
            checkpoint = Checkpoint(payload, 1, lambda _: 1)
            checkpoint.commit(chunk(0, 1))
            replay = Checkpoint(payload, 1, lambda _: 1)
            self.assertEqual(replay.reused_s, 1)
            replay.assert_source_unchanged(payload)

    def test_resource_failure_does_not_admit_gpu_and_queries_selected_device(self):
        config = settings({})
        with patch.dict(os.environ, {'CUDA_VISIBLE_DEVICES': '1'}):
            monitor = ResourceMonitor({}, config)
        with patch('asr_handoff_resources.available_memory_gb', return_value=24), \
             patch('asr_handoff_resources.subprocess.run', return_value=type('Result', (), {'stdout': '10, 2000, 16000'})()) as run:
            self.assertTrue(monitor.sample()['gpu_idle'])
            self.assertEqual(run.call_args[0][0][1:3], ['-i', '1'])
            run.side_effect = subprocess.TimeoutExpired('nvidia-smi', 3)
            self.assertIsNone(monitor.sample()['gpu_idle'])

    def test_gpu_model_own_allocator_does_not_trigger_cpu_fallback(self):
        monitor = ResourceMonitor({}, settings({}))
        with patch('asr_handoff_resources.available_memory_gb', return_value=24), \
             patch('asr_handoff_resources.subprocess.run', return_value=type('Result', (), {'stdout': '5, 14000, 16000'})()):
            self.assertFalse(monitor.sample()['gpu_idle'])
            monitor.owned_gpu_mb = 3000
            self.assertTrue(monitor.sample()['gpu_idle'])

    def test_model_processes_receive_isolated_device_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'worker.py'
            script.write_text('import sys,json,os\nfor line in sys.stdin:\n'
                ' r=json.loads(line)\n if r["op"]=="close": break\n'
                ' print(json.dumps({"cuda":os.environ.get("CUDA_VISIBLE_DEVICES"),'
                '"cpu":os.environ.get("ASR_CPU_FALLBACK")}),flush=True)\n', encoding='utf-8')
            original = subprocess.Popen
            def spawn(args, **kwargs):
                kwargs['stderr'] = None  # unittest -b replaces sys.stderr with an in-memory stream.
                return original([args[0], str(script)], **kwargs)
            with patch('asr_device_handoff.subprocess.Popen', side_effect=spawn), \
                 patch.dict(os.environ, {'ASR_CPU_FALLBACK': '1', 'CUDA_VISIBLE_DEVICES': '0'}):
                for device, expected in [('cpu', {'cuda': '', 'cpu': '1'}), ('cuda', {'cuda': '0', 'cpu': ''})]:
                    worker = ModelWorker({}, device, 5)
                    try: self.assertEqual(worker.request({'op': 'probe'}), expected)
                    finally: worker.close()

    def test_real_worker_exits_on_parent_pipe_close(self):
        worker = Path(__file__).resolve().parents[1] / 'src/scripts/python/asr_handoff_worker.py'
        process = subprocess.Popen([sys.executable, str(worker)], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            process.stdin.close()
            self.assertEqual(process.wait(timeout=5), 1)
        finally:
            if process.poll() is None: process.kill()
            process.stdout.close()
            process.stderr.close()

    @unittest.skipUnless(importlib.util.find_spec('torch'), 'PyTorch required for native stdin/import regression')
    def test_real_cpu_worker_imports_native_torch_while_control_pipe_is_open(self):
        # Windows CRT stdin locks used to deadlock NumPy inside torch import here.
        # Initialization imports torch but does not load/download an ASR model.
        worker = ModelWorker({'backend': 'paraformer'}, 'cpu', 30)
        try:
            self.assertIsNone(worker.process.poll())
        finally:
            worker.close()
        self.assertEqual(worker.process.returncode, 0)


if __name__ == '__main__':
    unittest.main()
