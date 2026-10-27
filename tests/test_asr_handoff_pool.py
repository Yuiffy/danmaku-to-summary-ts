import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts/python'))
from asr_handoff_model import HandoffModelState
from asr_handoff_pool import HandoffPool, has_followup, idle_resources_ok
from asr_handoff_pool_client import PooledModelWorker
from asr_persistent_worker import receive_json, send_json


def payload(source='first.flv', **overrides):
    return {'backend': 'paraformer', 'device': 'cuda', 'device_handoff': {'enabled': True},
            'audio_path': source, 'live_asr': {'source_path': source}, **overrides}


class ModelStateTests(unittest.TestCase):
    def test_two_recordings_share_weights_but_incompatible_settings_reload(self):
        state = HandoffModelState()
        loads = []
        def load(options):
            loads.append(options)
            return object()
        self.assertFalse(state.begin(payload()))
        first, _, _ = state.get(payload(), load)
        self.assertTrue(state.begin(payload('second.flv', enable_speaker=True)))
        second, load_s, _ = state.get(payload('second.flv'), load)
        self.assertIs(first, second)
        self.assertEqual(load_s, 0)
        self.assertEqual(len(loads), 1)
        for change in ({'vad_kwargs': {'max_single_segment_time': 30000}}, {'language': 'en'},
                       {'punc_model': None}, {'vad_device': 'cuda'}, {'device': 'cpu'}):
            self.assertFalse(state.begin(payload(**change)))
            state.get(payload(**change), load)
        self.assertEqual(len(loads), 6)

    def test_finish_offloads_weights_for_speaker_and_restores_without_loading(self):
        state = HandoffModelState()
        state.begin(payload())
        model = SimpleNamespace()
        state.get(payload(), lambda _: model)
        with patch.object(state, 'move') as move, patch.dict(sys.modules, {
                'torch': SimpleNamespace(cuda=SimpleNamespace(empty_cache=lambda: None))}):
            state.before_finish(payload(enable_speaker=True), True)
            self.assertTrue(state.parked)
            self.assertIs(state.model, model)
            reused, load_s, _ = state.get(payload('second.flv'), lambda _: self.fail('weights loaded twice'))
            self.assertIs(reused, model)
            self.assertEqual(load_s, 0)
            self.assertEqual([call.args[1] for call in move.call_args_list], ['cpu', 'cuda'])
            state.before_finish(payload(), False)
            self.assertIsNone(state.model)


class PoolTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.pending = True
        outer = self
        class Worker:
            def __init__(self, options, device, timeout):
                self.process = SimpleNamespace(pid=123)
                self.ready = {'ready': True, 'model_cache_hit': False}
                self.timeout, self.loads, self.loaded = timeout, 0, False
                self.options = options
                outer.events.append(('spawn', options['audio_path']))
            def request(self, request, interrupt=None):
                operation = request['op']
                outer.events.append((operation, self.options['audio_path']))
                if operation == 'init':
                    self.options = request['payload']
                    return {'ready': True, 'model_cache_hit': self.loaded}
                if operation == 'window':
                    if request.get('block'):
                        from asr_device_handoff import HandoffInterrupted
                        until = time.monotonic() + 3
                        while time.monotonic() < until:
                            if interrupt and interrupt():
                                raise HandoffInterrupted('disconnect')
                            time.sleep(.01)
                        raise TimeoutError('test cancellation was not observed')
                    load_s = 0 if self.loaded else 1
                    self.loaded = True
                    return {'source': self.options['audio_path'], 'model_load_s': load_s}
                if operation == 'finish':
                    return {'segments': [], 'retained': request['retain_model']}
                return {}
            def close(self): outer.events.append(('close', self.options['audio_path']))
            def abort(self): outer.events.append(('abort', self.options['audio_path']))
        self.pool = HandoffPool(Worker, followup=lambda _: self.pending)
        self.addCleanup(self.pool.close)
        self.server = socket.socket()
        self.server.bind(('127.0.0.1', 0))
        self.server.listen()
        self.server.settimeout(3)
        self.addCleanup(self.server.close)
        self.environment = patch.dict(os.environ, {'ASR_PERSISTENT_WORKER_PORT': str(self.server.getsockname()[1]),
                                                   'ASR_PERSISTENT_WORKER_TOKEN': 'test'})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.errors = []

    def serve(self, count=1):
        def run():
            try:
                for _ in range(count):
                    connection, _ = self.server.accept()
                    with connection:
                        request = receive_json(connection)
                        self.pool.serve(connection, request, receive_json, send_json)
            except Exception as exc:
                self.errors.append(exc)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread

    def test_two_jobs_reuse_worker_and_empty_queue_releases(self):
        thread = self.serve(2)
        first = PooledModelWorker(payload(), 'cuda', 3)
        self.assertEqual(first.request({'op': 'window'})['model_load_s'], 1)
        self.assertTrue(first.request({'op': 'finish'})['retained'])
        first.close()
        second = PooledModelWorker(payload('second.flv'), 'cuda', 3)
        self.assertTrue(second.ready['model_cache_hit'])
        self.assertEqual(second.request({'op': 'window'}), {'source': 'second.flv', 'model_load_s': 0})
        self.pending = False
        self.assertFalse(second.request({'op': 'finish'})['retained'])
        second.close()
        thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.errors, [])
        self.assertEqual(sum(e[0] == 'spawn' for e in self.events), 1)
        self.assertIsNone(self.pool.worker)

    def test_client_disconnect_interrupts_busy_inference_and_releases(self):
        thread = self.serve()
        client = PooledModelWorker(payload(), 'cuda', 3)
        client.connection.sendall(b'{"op":"window","block":true}\n')
        time.sleep(.05)
        client.abort()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertIsNone(self.pool.worker)
        self.assertTrue(any(e[0] == 'abort' for e in self.events))
        self.assertIsInstance(self.errors[0], ConnectionError)

    def test_unfinished_lease_never_retains_model(self):
        thread = self.serve()
        client = PooledModelWorker(payload(), 'cuda', 3)
        client.request({'op': 'window'})
        client.close()
        thread.join(2)
        self.assertIsNone(self.pool.worker)
        self.assertEqual(self.errors, [])

    def test_idle_retention_requires_pending_work_ram_and_bounded_time(self):
        for reason in ('empty', 'memory', 'expired'):
            with self.subTest(reason=reason):
                thread = self.serve()
                self.pending = True
                client = PooledModelWorker(payload(), 'cuda', 3)
                client.request({'op': 'window'})
                client.request({'op': 'finish'})
                client.close()
                thread.join(2)
                self.pending = reason != 'empty'
                if reason == 'expired': self.pool.idle_since -= 121
                with patch('asr_handoff_pool.idle_resources_ok', return_value=reason != 'memory'):
                    self.pool.reap_idle()
                self.assertIsNone(self.pool.worker)

    def test_idle_gpu_pressure_releases_even_parked_weights(self):
        with patch('asr_handoff_resources.available_memory_gb', return_value=24), \
             patch('asr_handoff_pool.subprocess.run') as run, \
             patch.dict(os.environ, {'CUDA_VISIBLE_DEVICES': '0'}):
            run.return_value.stdout = '2000, 16000'
            self.assertTrue(idle_resources_ok(payload()))
            run.return_value.stdout = '15000, 16000'
            self.assertFalse(idle_resources_ok(payload()))

    def test_queue_hint_ignores_current_and_failed_tasks_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'queue.json'
            def check(rows):
                file.write_text(json.dumps({'tasks': rows}), encoding='utf-8')
                return has_followup(payload(), file)
            self.assertFalse(check([{'status': 'pending', 'mediaPath': 'first.flv'},
                                    {'status': 'failed', 'mediaPath': 'second.flv'}]))
            self.assertTrue(check([{'status': 'pending', 'mediaPath': 'second.flv'}]))
            # The central owner claims the next job before extraction/acquire.
            self.assertTrue(check([{'status': 'processing', 'mediaPath': 'second.flv'}]))
            self.assertFalse(check([{'status': 'processing', 'mediaPath': 'first.flv'}]))
            file.write_text('{', encoding='utf-8')
            self.assertFalse(has_followup(payload(), file))


if __name__ == '__main__':
    unittest.main()
