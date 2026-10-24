"""Continuous telemetry, attributing Windows GPU load to external processes."""
from collections import deque
import math
import os
import subprocess
import threading
import time
from asr_handoff_gpu import WindowsGpuCounters


def available_memory_gb():
    if os.name == 'nt':
        import ctypes
        class Memory(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [
                (name, ctypes.c_ulonglong) for name in
                ('total', 'available', 'page_total', 'page_available', 'virtual_total', 'virtual_available', 'extended')]
        memory = Memory()
        memory.length = ctypes.sizeof(memory)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)):
            raise OSError('Cannot inspect available RAM')
        return memory.available / 1024 ** 3
    with open('/proc/meminfo', encoding='ascii') as stream:
        for line in stream:
            if line.startswith('MemAvailable:'):
                return int(line.split()[1]) / 1024 ** 2
    raise OSError('Cannot inspect available RAM')


class ResourceMonitor:
    def __init__(self, payload, config):
        from sensevoice_runtime import AsrResourceGuard
        self.guard = AsrResourceGuard(payload)
        self.config = config
        self.nvidia_smi = (payload.get('gpu_throttle') or {}).get('nvidia_smi') or 'nvidia-smi'
        visible = os.environ.get('CUDA_VISIBLE_DEVICES', '0').split(',')[0].strip()
        self.gpu_id = visible or None  # An explicitly hidden GPU must stay hidden.
        self.samples = deque(maxlen=256)
        self.lock = threading.Lock()
        self.sampling_lock = threading.Lock()
        self.stop = threading.Event()
        self.device = 'cpu'
        self.owned_gpu_mb = 0
        self.owner_pid = None
        self.counters = WindowsGpuCounters()
        self.latest = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def sample(self, *, quiet=False):
        with self.sampling_lock:
            return self._sample(quiet=quiet)

    def _sample(self, *, quiet=False):
        value = {'gpu_idle': None, 'game_running': None, 'available_gb': 0}
        try:
            value['available_gb'] = available_memory_gb()
            if self.guard.active or (self.config['allow_shared_gpu'] and self.guard.enabled and self.guard.game_process_names):
                # Unlike the legacy guard, failed observation does not prove idle.
                from sensevoice_runtime import _normalize_process_name
                names = self.guard._process_names_fn()
                value['game_running'] = (names if isinstance(names, bool) else bool(
                    self.guard.game_process_names.intersection(_normalize_process_name(n) for n in names)))
            else:
                value['game_running'] = False
            if self.gpu_id is None:
                return value
            result = subprocess.run([str(self.nvidia_smi), '-i', self.gpu_id,
                '--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
                check=True, capture_output=True, text=True, timeout=3,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            util, used, total = map(float, result.stdout.strip().split(','))
            if not all(math.isfinite(v) for v in (util, used, total)) or not (0 <= util <= 100 and 0 <= used <= total and total > 0):
                raise ValueError('Invalid GPU telemetry')
            attributed = self.counters.sample(self.owner_pid)
            owned = max(self.owned_gpu_mb, (attributed or {}).get('owned_gpu_mb') or 0)
            external_used = max(0, used - owned)
            value['memory_pressure'] = (external_used / total * 100 >= self.config['gpu_memory_pct']
                or total - external_used < self.config['gpu_free_mb'])
            if attributed is not None:
                util = attributed['external_util_pct']
                value['external_util_pct'] = util
            elif self.owner_pid is not None and not quiet:
                # Whole-device utilization cannot identify external pressure
                # while our own inference is active. Use quiet boundary fallback.
                util = None
            value['gpu_idle'] = (False if value['memory_pressure'] else
                                 None if util is None else util < self.config['gpu_util_pct'])
        except (OSError, ValueError, TypeError, subprocess.SubprocessError):
            pass
        return value

    def _run(self):
        while not self.stop.is_set():
            sample = self.sample()
            with self.lock:
                self.samples.append((time.monotonic(), sample))
            self.stop.wait(self.config['poll_s'])

    def __enter__(self):
        self.thread.start()
        return self

    def snapshot(self, policy, current, *, in_flight=False):
        with self.lock:
            observations = list(self.samples)
            self.samples.clear()
        if not observations and not in_flight and (self.latest is None or
                time.monotonic() - self.latest[0] > self.config['poll_s'] * 3):
            observations.append((time.monotonic(), self.sample()))
        for now, value in sorted(observations, key=lambda item: item[0]):
            policy.observe(value, now)
            self.latest = (now, value)
        sample = dict(self.latest[1]) if self.latest else {}
        if not in_flight and current == 'cuda' and sample.get('gpu_idle') is None:
            # Unsupported attribution retains conservative boundary admission.
            # Windows PDH observations avoid this wait entirely.
            time.sleep(1.2)
            sample = self.sample(quiet=True)
            policy.observe(sample, time.monotonic())
        return sample

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join(timeout=5)
        if not self.thread.is_alive():
            self.counters.close()
