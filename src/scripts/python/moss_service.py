"""Start one local, pinned vLLM container for a job and release its GPU on exit."""
from __future__ import annotations

import math
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid


def build_server_command(payload, name):
    image = str(payload.get('docker_image', ''))
    if not re.fullmatch(r'(?:[\w./:-]+@)?sha256:[0-9a-f]{64}', image):
        raise ValueError('Managed MOSS requires a Docker image pinned by sha256 digest')
    model = Path(payload['model']).resolve(strict=True)
    if not model.is_dir() or not (model / 'config.json').is_file():
        raise ValueError('Managed MOSS needs a complete local model directory')
    memory = float(payload.get('gpu_memory_utilization', 0.4))
    max_context = int(payload.get('max_model_len', 16384))
    cache_mb = payload.get('kv_cache_memory_mb')
    if cache_mb is not None and not 512 <= int(cache_mb) <= 8192:
        raise ValueError('Managed MOSS KV cache must be between 512 and 8192 MiB')
    chunk_seconds = float(payload.get('chunk_seconds', 300))
    lifetime = int(payload.get('process_timeout_s', 10800))
    if not math.isfinite(memory) or not 0.1 <= memory <= 0.9:
        raise ValueError('Managed MOSS GPU fraction must be between 0.1 and 0.9')
    if max_context < 4096 or lifetime <= 0 or not math.isfinite(chunk_seconds) or not 0 < chunk_seconds <= 300:
        raise ValueError('Managed MOSS context and lifetime must be positive and usable')
    command = ['docker', 'run', '--detach', '--name', name, '--gpus', 'all',
               '--shm-size', '2g', '--publish', '127.0.0.1::8000',
               '--mount', f'type=bind,source={model},target=/model,readonly',
               '--env', 'HF_HUB_OFFLINE=1', '--env', 'TRANSFORMERS_OFFLINE=1',
               '--env', 'VLLM_USE_V2_MODEL_RUNNER=' + ('1' if payload.get('v2_model_runner') else '0'),
               '--env', 'VLLM_WSL2_ENABLE_PIN_MEMORY=' + ('1' if payload.get('wsl2_pin_memory') else '0'),
               '--entrypoint', 'timeout']
    cache = payload.get('cache_dir')
    if cache:
        cache_path = Path(cache).resolve()
        cache_path.mkdir(parents=True, exist_ok=True)
        command += ['--mount', f'type=bind,source={cache_path},target=/root/.cache/vllm']
    # A hard lifetime also bounds an orphan after the host process is killed.
    command += [image, '--signal=TERM', '--kill-after=20', str(lifetime),
                'vllm', 'serve', '/model', '--served-model-name',
                str(payload.get('served_model_name', 'moss-transcribe-diarize')),
                '--trust-remote-code', '--dtype', 'bfloat16', '--host', '0.0.0.0',
                '--safetensors-load-strategy', 'eager',
                '--port', '8000', '--gpu-memory-utilization', str(memory),
                '--max-model-len', str(max_context), '--max-num-seqs', '1',
                '--max-num-batched-tokens', '2048', '--limit-mm-per-prompt',
                json.dumps({'audio': {'count': 1, 'length': math.ceil(chunk_seconds * 16000)}})]
    if cache_mb is not None:
        command += ['--kv-cache-memory-bytes', str(int(cache_mb) * 1024 * 1024)]
    return command


class ManagedMossServer:
    def __init__(self, payload):
        self.payload = payload
        self.name = 'danmaku-moss-' + uuid.uuid4().hex[:12]
        self.container = None
        self.base_url = None

    @staticmethod
    def _run(args, timeout=30):
        return subprocess.run(args, check=True, capture_output=True, text=True,
                              encoding='utf-8', errors='replace', timeout=timeout).stdout.strip()

    def __enter__(self):
        import requests

        command = build_server_command(self.payload, self.name)
        self._run(['docker', 'image', 'inspect', self.payload['docker_image']], timeout=20)
        # Never pull or upgrade a runtime implicitly during a production job.
        try:
            self.container = self.name
            self.container = self._run(command, timeout=90)
            if not re.fullmatch('[0-9a-f]{64}', self.container):
                raise RuntimeError('Docker did not return an unambiguous MOSS container ID')
            address = self._run(['docker', 'port', self.container, '8000/tcp'])
            if not re.fullmatch(r'127\.0\.0\.1:\d+', address):
                raise RuntimeError('Managed MOSS must bind to a single loopback port')
            self.base_url = 'http://' + address + '/v1'
            deadline = time.monotonic() + float(self.payload.get('startup_timeout_s', 600))
            while time.monotonic() < deadline:
                running = self._run(['docker', 'inspect', '--format', '{{.State.Running}}', self.container])
                if running != 'true':
                    raise RuntimeError('Managed MOSS container exited during startup')
                try:
                    result = requests.get(self.base_url + '/models', timeout=3)
                    if result.ok and any(row.get('id') == self.payload.get('served_model_name', 'moss-transcribe-diarize')
                                         for row in result.json().get('data', [])):
                        return self
                except (requests.RequestException, ValueError):
                    pass
                time.sleep(1)
            raise TimeoutError('Managed MOSS startup timed out')
        except BaseException:
            if self.container:
                try:
                    logs = subprocess.run(['docker', 'logs', '--tail', '200', self.container],
                        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=20)
                    print(logs.stdout + logs.stderr, file=sys.stderr)
                    if self.payload.get('cache_dir'):
                        diagnostics = Path(self.payload['cache_dir']) / 'diagnostics'
                        diagnostics.mkdir(parents=True, exist_ok=True)
                        (diagnostics / (self.name + '.log')).write_text(logs.stdout + logs.stderr, encoding='utf-8')
                except Exception:
                    pass
            self.close()
            raise

    def close(self):
        if self.container:
            try:
                self._run(['docker', 'rm', '--force', self.container])
            except Exception as exc:
                print(f'MOSS managed container cleanup failed: {exc}', file=sys.stderr)
            finally:
                self.container = None

    def __exit__(self, *args):
        self.close()
