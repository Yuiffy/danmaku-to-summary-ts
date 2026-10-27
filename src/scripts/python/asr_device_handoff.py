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
from asr_handoff_policy import BoundaryPolicy, batch_settings, settings, supported
from asr_handoff_resources import ResourceMonitor
from asr_speaker_load import speaker_policy_at_finish
from live_asr_cache import aggregate_chunks, missing_ranges, probe_duration, validate_chunks
from sensevoice_runtime import log_progress


class HandoffInterrupted(Exception):
    def __init__(self, target):
        super().__init__(f'ASR window interrupted for {target}; committed checkpoints retained')
        self.target = target


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
            self.ready = self.request({'op': 'init', 'payload': {**copy.deepcopy(payload), 'device': device}})
        except BaseException:
            self.close()
            raise

    def request(self, value, *, interrupt=None):
        self.process.stdin.write(json.dumps(value, ensure_ascii=False) + '\n')
        self.process.stdin.flush()
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                # Completed responses win over cancellation; never discard a
                # successfully finished window merely because polling is due.
                result = self.responses.get(timeout=min(0.25, max(0, deadline - time.monotonic())))
                break
            except queue.Empty as exc:
                if time.monotonic() >= deadline:
                    raise TimeoutError('ASR handoff worker timed out; completed checkpoints retained') from exc
                target = interrupt() if interrupt else None
                if target:
                    try:
                        result = self.responses.get_nowait()
                        break
                    except queue.Empty:
                        raise HandoffInterrupted(target)
        if isinstance(result, Exception):
            raise result
        return result

    def abort(self):
        # A busy worker cannot read a graceful close request until generate()
        # returns. Terminate this isolated process before starting another one.
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=5)
        self.close()

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.write('{"op":"close"}\n')
                self.process.stdin.flush()
                self.process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=5)
        for stream in (self.process.stdin, self.process.stdout):
            try:
                stream.close()
            except OSError:
                pass  # A broken pipe must not mask the original model failure.


def transcribe_handoff(payload, *, worker_factory=None, monitor_factory=ResourceMonitor,
                       probe=probe_duration, pcm_factory=aligned_pcm, clock=time.monotonic,
                       sleep=time.sleep, initial_device=None):
    if not supported(payload):
        raise ValueError('Device handoff supports only standard CUDA Paraformer; original route must handle this request')
    if worker_factory is None:
        from asr_handoff_pool_client import create_model_worker
        worker_factory = create_model_worker
    config = settings(payload)
    duration = probe(payload['audio_path'])
    source = (payload.get('live_asr') or {}).get('source_path') or payload['audio_path']
    sidecar = Path(source).with_suffix('.asr-handoff.json')
    with checkpoint_lock(sidecar):
        checkpoint = Checkpoint(payload, duration, probe)
        policy = BoundaryPolicy(config)
        current = initial_device or ('cpu' if os.environ.get('ASR_CPU_FALLBACK') == '1' else 'cuda')
        if current == 'cpu' and not config['cpu_fallback_enabled']:
            current = 'cuda'
        worker = None
        began = clock()
        timings = {'device_handoff': 1, 'handoff_switches': 0, 'handoff_cpu_audio_s': 0,
                   'handoff_gpu_audio_s': 0, 'handoff_reused_audio_s': checkpoint.reused_s}
        if current == 'cpu':
            timings['cpu_fallback'] = 1
        try:
            with monitor_factory(payload, config) as monitor:
                def report(state, remaining, low_impact=None):
                    low_impact = policy.low_impact if low_impact is None else low_impact
                    log_progress('[[ASR_HANDOFF_STATUS]] ' + json.dumps({
                        'policy_version': 8,
                        'cpu_fallback_enabled': config['cpu_fallback_enabled'],
                        'shared_gpu_enabled': config['allow_shared_gpu'],
                        'device_cooldown_s': config['device_cooldown_s'],
                        'device': current, 'state': state, 'audio_done_s': round(duration - remaining, 5),
                        'audio_total_s': duration, 'window_s': config['window_s'],
                        'batch_size_s': batch_settings(payload, current, low_impact)[0],
                        'performance_tier': ('cpu_background' if current == 'cpu' else
                            'gpu_low_impact' if low_impact else 'gpu_throughput'),
                    }, ensure_ascii=False))

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
                                monitor.owner_pid = None
                                if current == 'cuda':
                                    policy.suspend_gpu(clock())
                            if selected != 'wait':
                                log_progress(f'ASR 分段接力: {current} → {selected}，剩余 {remaining:.1f}s 音频')
                                timings['handoff_switches'] += 1
                                policy.idle_since = None
                                current = selected
                        monitor.device = current if selected != 'wait' else 'cpu'
                        if selected == 'wait':
                            report('waiting', remaining)
                            sleep(config['poll_s'])
                            continue
                        if worker is None:
                            report('loading', remaining)
                            worker = worker_factory(payload, current, config['worker_timeout_s'])
                            ready = getattr(worker, 'ready', {})
                            if ready.get('model_cache_hit'):
                                timings['handoff_cross_job_cache_hits'] = timings.get('handoff_cross_job_cache_hits', 0) + 1
                            log_progress('ASR 接力模型复用: ' + json.dumps({
                                'pid': getattr(getattr(worker, 'process', None), 'pid', None),
                                'cross_job_cache_hit': bool(ready.get('model_cache_hit'))}, ensure_ascii=False))
                            monitor.owner_pid = getattr(getattr(worker, 'process', None), 'pid', None) if current == 'cuda' else None
                            if current == 'cuda':
                                policy.gpu_suspended = False
                        return worker

                def interrupt_target():
                    sample = monitor.snapshot(policy, current, in_flight=True)
                    return policy.interrupt_target(current, sample, clock(), remaining)

                gaps = missing_ranges(checkpoint.chunks, duration)
                remaining = sum(end - start for start, end in gaps)
                context = pcm_factory(payload['audio_path'], duration) if gaps else nullcontext(None)
                with context as pcm:
                    for start, end in gaps:
                        while end - start > 0.05:
                            active = ensure_device(remaining)
                            size = min(config['window_s'], end - start)
                            while True:
                                try:
                                    window_low_impact = policy.low_impact
                                    batch, threshold = batch_settings(payload, current, window_low_impact)
                                    tier = 'cpu' if current == 'cpu' else 'gpu_low_impact' if window_low_impact else 'gpu_throughput'
                                    timings[f'handoff_{tier}_batch_s'] = batch
                                    response = active.request({'op': 'window', 'pcm': pcm, 'start': start,
                                                               'batch_size_s': batch, 'batch_size_threshold_s': threshold,
                                                               'duration': size, 'final': size >= end - start - 0.05},
                                                              interrupt=interrupt_target)
                                except HandoffInterrupted as interrupted:
                                    active.abort()
                                    if current == 'cuda':
                                        policy.suspend_gpu(clock())
                                    worker = None
                                    monitor.owner_pid = None
                                    monitor.owned_gpu_mb = 0
                                    # CPU promotion already earned the full idle period.
                                    # Retain that evidence through GPU readmission.
                                    log_progress(f'ASR 接力中断: device={current}, target={interrupted.target}, '
                                                 f'replay_from={start:.1f}s，已保存进度不变')
                                    timings['handoff_interruptions'] = timings.get('handoff_interruptions', 0) + 1
                                    if interrupted.target != 'wait':
                                        log_progress(f'ASR 分段接力: {current} → {interrupted.target}，剩余 {remaining:.1f}s 音频')
                                        current = interrupted.target
                                        timings['handoff_switches'] += 1
                                    active = ensure_device(remaining)
                                    continue
                                monitor.owned_gpu_mb = response.get('gpu_reserved_mb', 0)
                                key = 'handoff_cpu_window_s' if current == 'cpu' else 'handoff_gpu_window_s'
                                timings[key] = timings.get(key, 0) + response.get('window_s', 0)
                                if current == 'cuda':
                                    key = f'handoff_{tier}_window_s'
                                    timings[key] = timings.get(key, 0) + response.get('window_s', 0)
                                timings['handoff_model_load_s'] = timings.get('handoff_model_load_s', 0) + response.get('model_load_s', 0)
                                for name in ('vad_s', 'generation_s', 'vad_reused', 'empty_decoding', 'model_restore_s'):
                                    key = f'handoff_{name}'
                                    timings[key] = timings.get(key, 0) + response.get(name, 0)
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
                            if current == 'cuda':
                                key = f'handoff_{tier}_audio_s'
                                timings[key] = timings.get(key, 0) + progress
                            remaining -= progress
                            start = chunk['end']
                            log_progress(f'ASR 接力已保存: {start:.1f}/{duration:.1f}s，device={current}')
                            report('running', remaining, window_low_impact)
                            if current == 'cuda' and window_low_impact:
                                sleep(max(0, float(((payload.get('gpu_throttle') or {}).get('low_impact') or {}).get('yield_s', 0.2))))
                if missing_ranges(checkpoint.chunks, duration):
                    raise RuntimeError('ASR handoff has uncovered audio; refusing final output')
                checkpoint.assert_source_unchanged(payload)
                active = ensure_device(0)
                report('postprocessing', 0)
                timings['handoff_transcription_s'] = clock() - began
                speaker_policy = payload.get('speaker_processing_policy') or {}
                finish_sample = (monitor.snapshot(policy, current)
                    if speaker_policy.get('mode') == 'auto' and speaker_policy.get('enabled') is not False else None)
                finish_policy = speaker_policy_at_finish(speaker_policy, current, finish_sample)
                result = active.request({'op': 'finish', 'chunks': checkpoint.chunks, 'timings': timings,
                                         'speaker_processing_policy': finish_policy})
                checkpoint.assert_source_unchanged(payload)
                result['timings']['model_load_s'] = timings.get('handoff_model_load_s', 0)
                result['timings']['model_cache_hit'] = int(timings.get('handoff_cross_job_cache_hits', 0) > 0
                    and timings.get('handoff_model_load_s', 0) == 0)
                result['timings']['backend_total_s'] = clock() - began
                return result
        finally:
            if worker is not None:
                worker.close()
