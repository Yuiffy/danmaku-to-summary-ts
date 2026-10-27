"""Queue-owned, single-lease handoff worker reuse on the existing loopback server."""
import json
import math
import os
from pathlib import Path
import select
import socket
import subprocess
import time


def peer_closed(connection):
    readable, _, _ = select.select([connection], [], [], 0)
    return bool(readable and not connection.recv(1, socket.MSG_PEEK))


def has_followup(payload, queue_file=None):
    # Read-only retention hint. Admission, mutations and execution remain in the
    # central queue worker. Missing or malformed snapshots never retain weights.
    try:
        file = queue_file or Path(__file__).parents[1] / '.whisper_queue.json'
        tasks = json.loads(Path(file).read_text(encoding='utf-8'))['tasks']
        source = (payload.get('live_asr') or {}).get('source_path') or payload.get('audio_path')
        return any(row.get('status') in ('pending', 'processing') and row.get('mediaPath') != source for row in tasks)
    except (OSError, ValueError, KeyError, TypeError):
        return False


def idle_resources_ok(payload):
    from asr_handoff_resources import available_memory_gb
    from asr_handoff_policy import settings
    config = settings(payload)
    if available_memory_gb() < config['min_available_memory_gb']:
        return False
    visible = os.environ.get('CUDA_VISIBLE_DEVICES', '0').split(',')[0].strip()
    if not visible:
        return False
    command = (payload.get('gpu_throttle') or {}).get('nvidia_smi') or 'nvidia-smi'
    result = subprocess.run([str(command), '-i', visible, '--query-gpu=memory.used,memory.total',
        '--format=csv,noheader,nounits'], capture_output=True, text=True, check=True, timeout=3,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    used, total = map(float, result.stdout.strip().split(','))
    return (math.isfinite(used) and math.isfinite(total) and 0 <= used < total and total-used >= config['gpu_free_mb']
            and used/total*100 < config['gpu_memory_pct'])


class HandoffPool:
    def __init__(self, worker_factory=None, followup=has_followup, clock=time.monotonic):
        self.worker_factory = worker_factory
        self.followup, self.clock = followup, clock
        self.worker = None
        self.payload = {}
        self.idle_since = None

    def close(self):
        worker, self.worker = self.worker, None
        self.idle_since = None
        if worker is not None:
            worker.close()

    def reap_idle(self):
        if self.worker is None or self.idle_since is None:
            return
        try:
            keep = (self.followup(self.payload) and self.clock() - self.idle_since < 120
                    and idle_resources_ok(self.payload))
        except (OSError, ValueError, subprocess.SubprocessError):
            keep = False
        if not keep:
            self.close()

    def serve(self, connection, request, receive, send):
        from asr_device_handoff import ModelWorker, HandoffInterrupted
        from asr_handoff_policy import settings, supported
        payload, device = request.get('payload') or {}, request.get('device')
        if not supported(payload) or device != 'cuda':
            raise ValueError('Handoff pool supports admitted standard CUDA requests only')
        timeout = settings(payload)['worker_timeout_s']
        self.payload = payload
        self.idle_since = None
        finished = retained = False
        try:
            if self.worker is None:
                self.worker = (self.worker_factory or ModelWorker)(payload, device, timeout)
                ready = getattr(self.worker, 'ready', {})
            else:
                self.worker.timeout = timeout
                ready = self.worker.request({'op': 'init', 'payload': {**payload, 'device': device}})
            send(connection, {'ok': True, 'pid': self.worker.process.pid, **ready})
            connection.settimeout(30)
            while True:
                value = receive(connection)
                operation = value.get('op')
                if operation == 'release':
                    if finished and self.followup(payload):
                        self.worker.request({'op': 'release'})
                        self.idle_since = self.clock()
                        retained = True
                    else:
                        self.close()
                    send(connection, {'ok': True, 'retained': retained})
                    return
                if operation not in ('window', 'finish') or finished:
                    raise ValueError('Invalid handoff pool operation')
                if operation == 'finish':
                    value = {**value, 'retain_model': self.followup(payload)}
                result = self.worker.request(value, interrupt=lambda: 'disconnect' if peer_closed(connection) else None)
                finished = operation == 'finish'
                send(connection, {'ok': True, 'result': result})
        except HandoffInterrupted as exc:
            raise ConnectionError('Handoff client cancelled; model released') from exc
        finally:
            if not retained:
                # Abort also handles a disconnected client during native inference.
                worker, self.worker = self.worker, None
                if worker is not None:
                    worker.abort()
