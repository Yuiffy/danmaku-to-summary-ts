"""Pure boundary decisions for opt-in Paraformer device handoff."""
import math


def supported(payload):
    return (payload.get('backend') == 'paraformer'
            and (payload.get('device_handoff') or {}).get('enabled') is True
            and str(payload.get('device', 'cuda')) in ('cuda', 'cuda:0')
            and payload.get('model', 'paraformer-zh') == 'paraformer-zh'
            and not payload.get('finetuned_model')
            and payload.get('model_profile') != 'finetuned')


def settings(payload):
    raw = payload.get('device_handoff') or {}
    defaults = {'idle_s': 45, 'min_remaining_s': 600, 'poll_s': 5,
                'gpu_util_pct': 40, 'gpu_memory_pct': 70, 'gpu_free_mb': 4096,
                'min_available_memory_gb': 10, 'window_s': 120, 'worker_timeout_s': 600}
    value = {}
    for key, default in defaults.items():
        number = float(raw.get(key, default))
        if not math.isfinite(number) or number <= 0:
            raise ValueError(f'Invalid ASR handoff setting: {key}')
        value[key] = number
    value['window_s'] = min(120, max(30, value['window_s']))
    value['poll_s'] = max(1, value['poll_s'])
    value['min_available_memory_gb'] = max(4, value['min_available_memory_gb'])
    return value


class BoundaryPolicy:
    def __init__(self, config):
        self.config = config
        self.idle_since = None
        self.last_sample = None

    def observe(self, sample, now):
        # Missing/error samples and monitoring gaps cannot prove sustained idle.
        stale = self.last_sample is None or now - self.last_sample > self.config['poll_s'] * 3
        self.last_sample = now
        idle = sample.get('gpu_idle') is True and sample.get('game_running') is False
        if not idle:
            self.idle_since = None
        elif self.idle_since is None or stale:
            self.idle_since = now

    def choose(self, current, sample, now, remaining, cpu_running=False):
        # The admission headroom includes the model we are about to load.
        # Do not reload a healthy CPU worker each window because its own memory
        # reduced free RAM below that admission threshold; retain a 4GiB floor.
        minimum = 4 if current == 'cpu' and cpu_running else self.config['min_available_memory_gb']
        cpu_ok = sample.get('available_gb', 0) >= minimum
        gpu_ok = (sample.get('gpu_idle') is True and sample.get('game_running') is False
                  and self.last_sample is not None
                  and now - self.last_sample <= self.config['poll_s'] * 3)
        if current == 'cuda':
            return 'cuda' if gpu_ok else ('cpu' if cpu_ok else 'wait')
        sustained = gpu_ok and self.idle_since is not None and now - self.idle_since >= self.config['idle_s']
        if sustained and (remaining >= self.config['min_remaining_s'] or not cpu_ok):
            return 'cuda'
        return 'cpu' if cpu_ok else 'wait'
