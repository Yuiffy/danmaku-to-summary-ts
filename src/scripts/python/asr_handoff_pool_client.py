"""Interruptible private lease; the original coordinator still owns progress."""
import json
import os
import select
import socket
import time
from types import SimpleNamespace


class PooledModelWorker:
    def __init__(self, payload, device, timeout):
        self.timeout = timeout
        self.connection = socket.create_connection(('127.0.0.1', int(os.environ['ASR_PERSISTENT_WORKER_PORT'])), timeout=5)
        self.buffer = b''
        try:
            self.ready = self.request({'type': 'handoff', 'token': os.environ['ASR_PERSISTENT_WORKER_TOKEN'],
                                       'payload': payload, 'device': device})
            self.process = SimpleNamespace(pid=self.ready['pid'])
        except BaseException:
            self.abort()
            raise

    def request(self, value, *, interrupt=None):
        self.connection.sendall(json.dumps(value, ensure_ascii=False).encode('utf-8') + b'\n')
        deadline = time.monotonic() + self.timeout
        while b'\n' not in self.buffer:
            if time.monotonic() >= deadline:
                raise TimeoutError('Pooled handoff request timed out; checkpoints retained')
            readable, _, _ = select.select([self.connection], [], [], min(.25, max(0, deadline-time.monotonic())))
            if readable:
                data = self.connection.recv(65536)
                if not data:
                    raise ConnectionError('Pooled handoff worker disconnected; checkpoints retained')
                self.buffer += data
                continue
            target = interrupt() if interrupt else None
            if target:
                # A response completed while telemetry was sampled still wins.
                if select.select([self.connection], [], [], 0)[0]:
                    continue
                from asr_device_handoff import HandoffInterrupted
                raise HandoffInterrupted(target)
        line, self.buffer = self.buffer.split(b'\n', 1)
        response = json.loads(line)
        if not response.get('ok'):
            raise RuntimeError(response.get('error') or 'Pooled handoff worker failed')
        return response.get('result', response)

    def abort(self):
        connection, self.connection = self.connection, None
        if connection is not None:
            connection.close()

    def close(self):
        if self.connection is not None:
            try:
                self.request({'op': 'release'})
            except (OSError, RuntimeError, ValueError):
                pass  # Cleanup must not replace the original inference failure.
            finally:
                self.abort()


def create_model_worker(payload, device, timeout):
    from asr_device_handoff import ModelWorker
    if device == 'cuda' and os.environ.get('ASR_PERSISTENT_WORKER_PORT') and os.environ.get('ASR_PERSISTENT_WORKER_TOKEN'):
        # Only connection establishment can fall back. Once admitted, inference
        # errors propagate and committed checkpoints remain authoritative.
        try:
            return PooledModelWorker(payload, device, timeout)
        except (ConnectionError, OSError, RuntimeError, ValueError) as exc:
            from sensevoice_runtime import log_progress
            log_progress(f'ASR 接力复用连接不可用，使用独立 worker: {exc}')
    return ModelWorker(payload, device, timeout)
