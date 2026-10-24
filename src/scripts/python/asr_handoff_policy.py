"""Pure boundary decisions for opt-in Paraformer device handoff."""
import math


def batch_settings(payload, device, low_impact=False):
    if device == 'cpu':
        return 30, 30
    if low_impact:
        raw = ((payload.get('gpu_throttle') or {}).get('low_impact') or {}).get('batch_size_s', 30)
        batch = min(int(float(payload.get('batch_size_s', 300) or 300)), int(float(raw)))
        if batch < 1:
            raise ValueError('Invalid low-impact GPU batch')
        return batch, min(batch, 60)
    return (int(float(payload.get('batch_size_s', 300) or 300)),
            int(float(payload.get('batch_size_threshold_s', 60) or 60)))


def supported(payload):
    profile = str(payload.get('model_profile') or '').strip().lower()
    return (payload.get('backend') == 'paraformer'
            and (payload.get('device_handoff') or {}).get('enabled') is True
            and str(payload.get('device', 'cuda')) in ('cuda', 'cuda:0')
            and payload.get('model', 'paraformer-zh') == 'paraformer-zh'
            and (not payload.get('finetuned_model') or profile == 'default')
            and profile != 'finetuned')


def settings(payload):
    raw = payload.get('device_handoff') or {}
    defaults = {'idle_s': 45, 'min_remaining_s': 600, 'poll_s': 5,
                'gpu_util_pct': 40, 'gpu_memory_pct': 70, 'gpu_free_mb': 4096,
                'min_available_memory_gb': 10, 'window_s': 120, 'worker_timeout_s': 600,
                'shared_gpu_util_pct': 90, 'gpu_busy_s': 15, 'device_cooldown_s': 120}
    value = {}
    for key, default in defaults.items():
        number = float(raw.get(key, default))
        if not math.isfinite(number) or number <= 0:
            raise ValueError(f'Invalid ASR handoff setting: {key}')
        value[key] = number
    value['window_s'] = min(120, max(30, value['window_s']))
    value['poll_s'] = max(1, value['poll_s'])
    value['min_available_memory_gb'] = max(4, value['min_available_memory_gb'])
    value['allow_shared_gpu'] = raw.get('allow_shared_gpu') is True
    value['cpu_fallback_enabled'] = raw.get('cpu_fallback_enabled') is not False
    if value['allow_shared_gpu'] and not value['gpu_util_pct'] < value['shared_gpu_util_pct'] <= 100:
        raise ValueError('Shared GPU threshold must exceed throughput threshold and be at most 100')
    return value


class BoundaryPolicy:
    def __init__(self, config):
        self.config = config
        self.idle_since = None
        self.last_sample = None
        self.busy_since = None
        self.gpu_suspended = False
        self.usable_since = None
        self.overload_since = None
        self.low_impact = False
        self.gpu_retry_after = 0

    def suspend_gpu(self, now):
        self.gpu_suspended = True
        self.idle_since = None
        self.usable_since = None
        self.gpu_retry_after = now + self.config['device_cooldown_s']

    def shared_available(self, sample):
        if sample.get('memory_pressure') is True:
            return False
        util = sample.get('external_util_pct')
        return (sample.get('gpu_idle') is True or
                isinstance(util, (int, float)) and math.isfinite(util)
                and 0 <= util < self.config['shared_gpu_util_pct'])

    def observe(self, sample, now):
        # Missing/error samples and monitoring gaps cannot prove sustained idle.
        stale = self.last_sample is None or now - self.last_sample > self.config['poll_s'] * 3
        self.last_sample = now
        busy = sample.get('gpu_idle') is False or sample.get('game_running') is True
        self.busy_since = (now if self.busy_since is None or stale else self.busy_since) if busy else None
        idle = sample.get('gpu_idle') is True and sample.get('game_running') is False
        if not idle:
            self.idle_since = None
        elif self.idle_since is None or stale:
            self.idle_since = now
        if self.config['allow_shared_gpu']:
            usable = self.shared_available(sample)
            if not usable:
                self.usable_since = None
            elif self.usable_since is None or stale:
                self.usable_since = now
            overload = not usable and sample.get('gpu_idle') is False
            self.overload_since = (now if self.overload_since is None or stale else self.overload_since) if overload else None
            if not idle:
                self.low_impact = True
            elif self.idle_since is not None and now - self.idle_since >= self.config['idle_s']:
                self.low_impact = False

    def choose(self, current, sample, now, remaining, cpu_running=False):
        # The admission headroom includes the model we are about to load.
        # Do not reload a healthy CPU worker each window because its own memory
        # reduced free RAM below that admission threshold; retain a 4GiB floor.
        minimum = 4 if current == 'cpu' and cpu_running else self.config['min_available_memory_gb']
        cpu_ok = self.config['cpu_fallback_enabled'] and sample.get('available_gb', 0) >= minimum
        gpu_ok = (sample.get('gpu_idle') is True and sample.get('game_running') is False
                  and self.last_sample is not None
                  and now - self.last_sample <= self.config['poll_s'] * 3)
        if self.config['allow_shared_gpu']:
            fresh = self.last_sample is not None and now - self.last_sample <= self.config['poll_s'] * 3
            usable = fresh and self.shared_available(sample)
            recovered = (usable and now >= self.gpu_retry_after and self.usable_since is not None
                         and now - self.usable_since >= self.config['idle_s'])
            if current == 'cuda':
                grace = (fresh and sample.get('memory_pressure') is not True
                         and self.overload_since is not None
                         and now - self.overload_since < self.config['gpu_busy_s'])
                admitted = recovered if self.gpu_suspended else usable or grace
                return 'cuda' if admitted else ('cpu' if cpu_ok else 'wait')
            return 'cuda' if recovered and (remaining >= self.config['min_remaining_s'] or not cpu_ok) else ('cpu' if cpu_ok else 'wait')
        if current == 'cuda':
            if (sample.get('gpu_idle') is False and sample.get('memory_pressure') is not True
                    and sample.get('game_running') is False and self.busy_since is not None
                    and now - self.busy_since < self.config['poll_s'] and not self.gpu_suspended):
                return 'cuda'  # One utilization spike should not reload the model.
            if self.gpu_suspended:
                gpu_ok = (gpu_ok and self.idle_since is not None
                          and now - self.idle_since >= self.config['idle_s'])
            return 'cuda' if gpu_ok else ('cpu' if cpu_ok else 'wait')
        sustained = gpu_ok and self.idle_since is not None and now - self.idle_since >= self.config['idle_s']
        if sustained and (remaining >= self.config['min_remaining_s'] or not cpu_ok):
            return 'cuda'
        return 'cpu' if cpu_ok else 'wait'

    def interrupt_target(self, current, sample, now, remaining):
        if self.last_sample is None or now - self.last_sample > self.config['poll_s'] * 3:
            return None
        if current == 'cuda':
            shared = self.config['allow_shared_gpu']
            urgent = sample.get('memory_pressure') is True or sample.get('game_running') is True and not shared
            since = self.overload_since if shared else self.busy_since
            sustained = since is not None and now - since >= self.config['gpu_busy_s' if shared else 'poll_s']
            if not urgent and not sustained:
                return None
        selected = self.choose(current, sample, now, remaining, cpu_running=current == 'cpu')
        return selected if selected != current else None
