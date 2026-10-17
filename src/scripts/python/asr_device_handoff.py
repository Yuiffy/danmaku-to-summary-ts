"""Per-job Paraformer coordinator. No service, queue or publication ownership."""
import copy
from contextlib import nullcontext
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

from asr_handoff_checkpoint import Checkpoint, aligned_pcm, checkpoint_lock
from asr_handoff_policy import BoundaryPolicy, settings, supported
from asr_handoff_resources import ResourceMonitor
from live_asr_cache import aggregate_chunks, missing_ranges, probe_duration, validate_chunks
from sensevoice_runtime import log_progress


class ModelWorker:
    def __init__(self, payload, device, timeout):
        env = {**os.environ, 'PYTHONUTF8': '1', 'ASR_CPU_FALLBACK': '1' if device == 'cpu' else ''}
        if device == 'cpu':
            env.update(CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2')
        self.timeout = timeout
        self.process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('asr_handoff_worker.py'))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.__stderr__, text=True,
            encoding='utf-8', env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.responses = queue.Queue()
        def read():
            try:
                for line in self.process.stdout:
                    self.responses.put(json.loads(line))
            except Exception as exc:
                self.responses.put(exc)
            finally:
                self.responses.put(RuntimeError('ASR handoff worker disconnected; completed checkpoints retained'))
        threading.Thread(target=read, daemon=True).start()
        try:
            self.request({'op': 'init', 'payload': {**copy.deepcopy(payload), 'device': device}})
        except BaseException:
            self.close()
            raise

    def request(self, value):
        self.process.stdin.write(json.dumps(value, ensure_ascii=False) + '\n')
        self.process.stdin.flush()
        try:
            result = self.responses.get(timeout=self.timeout)
        except queue.Empty as exc:
            raise TimeoutError('ASR handoff worker timed out; completed checkpoints retained') from exc
        if isinstance(result, Exception):
            raise result
        return result

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.write('{"op":"close"}\n')
                self.process.stdin.flush()
                self.process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()


def transcribe_handoff(payload, *, worker_factory=ModelWorker, monitor_factory=ResourceMonitor,
                       probe=probe_duration, pcm_factory=aligned_pcm, clock=time.monotonic,
                       sleep=time.sleep, initial_device=None):
    if not supported(payload):
        raise ValueError('Device handoff supports only standard CUDA Paraformer; original route must handle this request')
    config = settings(payload)
    duration = probe(payload['audio_path'])
    source = (payload.get('live_asr') or {}).get('source_path') or payload['audio_path']
    sidecar = Path(source).with_suffix('.asr-handoff.json')
    with checkpoint_lock(sidecar):
        checkpoint = Checkpoint(payload, duration, probe)
        policy = BoundaryPolicy(config)
        current = initial_device or ('cpu' if os.environ.get('ASR_CPU_FALLBACK') == '1' else 'cuda')
        worker = None
        began = clock()
        timings = {'device_handoff': 1, 'handoff_switches': 0, 'handoff_cpu_audio_s': 0,
                   'handoff_gpu_audio_s': 0, 'handoff_reused_audio_s': checkpoint.reused_s}
        if current == 'cpu':
            timings['cpu_fallback'] = 1
        try:
            with monitor_factory(payload, config) as monitor:
                def ensure_device(remaining):
                    nonlocal current, worker
                    while True:
                        sample = monitor.snapshot(policy, current)
                        selected = policy.choose(current, sample, clock(), remaining,
                                                 cpu_running=worker is not None and current == 'cpu')
                        if selected != current or selected == 'wait':
                            if worker is not None:
                                worker.close()
                                worker = None
                                monitor.owned_gpu_mb = 0
                            if selected != 'wait':
                                log_progress(f'ASR 分段接力: {current} → {selected}，剩余 {remaining:.1f}s 音频')
                                timings['handoff_switches'] += 1
                                policy.idle_since = None
                                current = selected
                        monitor.device = current if selected != 'wait' else 'cpu'
                        if selected == 'wait':
                            sleep(config['poll_s'])
                            continue
                        if worker is None:
                            worker = worker_factory(payload, current, config['worker_timeout_s'])
                        return worker

                gaps = missing_ranges(checkpoint.chunks, duration)
                remaining = sum(end - start for start, end in gaps)
                context = pcm_factory(payload['audio_path'], duration) if gaps else nullcontext(None)
                with context as pcm:
                    for start, end in gaps:
                        while end - start > 0.05:
                            active = ensure_device(remaining)
                            size = min(config['window_s'], end - start)
                            while True:
                                response = active.request({'op': 'window', 'pcm': pcm, 'start': start,
                                                           'duration': size, 'final': size >= end - start - 0.05})
                                monitor.owned_gpu_mb = response.get('gpu_reserved_mb', 0)
                                key = 'handoff_cpu_window_s' if current == 'cpu' else 'handoff_gpu_window_s'
                                timings[key] = timings.get(key, 0) + response.get('window_s', 0)
                                timings['handoff_model_load_s'] = timings.get('handoff_model_load_s', 0) + response.get('model_load_s', 0)
                                if response['chunk'] is not None:
                                    break
                                if size >= min(120, end-start) - 0.001:
                                    raise ValueError('VAD could not commit a bounded ASR window')
                                size = min(size + 30, 120, end-start)
                            chunk = response['chunk']
                            validate_chunks([chunk], duration)
                            if abs(chunk['start'] - start) > 0.001 or not start < chunk['end'] <= start + size + 0.001:
                                raise ValueError('Worker returned wrong ASR window bounds')
                            aggregate_chunks([chunk])
                            checkpoint.commit(chunk)  # Persist before any device switch or next request.
                            progress = chunk['end'] - start
                            timings['handoff_cpu_audio_s' if current == 'cpu' else 'handoff_gpu_audio_s'] += progress
                            remaining -= progress
                            start = chunk['end']
                            log_progress(f'ASR 接力已保存: {start:.1f}/{duration:.1f}s，device={current}')
                if missing_ranges(checkpoint.chunks, duration):
                    raise RuntimeError('ASR handoff has uncovered audio; refusing final output')
                checkpoint.assert_source_unchanged(payload)
                active = ensure_device(0)
                timings['handoff_transcription_s'] = clock() - began
                result = active.request({'op': 'finish', 'chunks': checkpoint.chunks, 'timings': timings})
                checkpoint.assert_source_unchanged(payload)
                result['timings']['backend_total_s'] = clock() - began
                return result
        finally:
            if worker is not None:
                worker.close()
