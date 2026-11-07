"""Per-job CPU admission overrides; never alter model identity or speaker policy."""
import os


def _positive_int(value, default, maximum=64):
    try:
        result = int(float(value))
    except (TypeError, ValueError):
        result = default
    return max(1, min(maximum, result))


def cpu_fallback_settings(payload):
    """Return bounded CPU settings shared by one-shot and handoff workers."""
    raw = payload.get('cpu_fallback') if isinstance(payload, dict) else None
    raw = raw if isinstance(raw, dict) else {}
    threads = _positive_int(raw.get('torch_num_threads', 4), 4)
    interop = _positive_int(raw.get('torch_num_interop_threads', 1), 1, maximum=16)
    batch = _positive_int(raw.get('batch_size_s', 60), 60, maximum=300)
    threshold = _positive_int(raw.get('batch_size_threshold_s', batch), batch, maximum=300)
    inference_batch = _positive_int(raw.get('inference_batch_size', 1), 1, maximum=8)
    return {
        'torch_num_threads': threads,
        'torch_num_interop_threads': interop,
        'ncpu': threads,
        'batch_size_s': batch,
        'batch_size_threshold_s': threshold,
        'inference_batch_size': inference_batch,
    }


def apply_cpu_fallback(payload, environ=None):
    env = os.environ if environ is None else environ
    if env.get('ASR_CPU_FALLBACK') != '1' and payload.get('_cpu_fallback') is not True:
        return False
    if payload.get('backend') not in ('paraformer', 'sensevoice'):
        raise ValueError('Selected ASR backend does not support CPU fallback')
    cpu = cpu_fallback_settings(payload)
    threads = str(cpu['torch_num_threads'])
    env.update(CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS=threads, MKL_NUM_THREADS=threads,
               OPENBLAS_NUM_THREADS=threads)
    payload.update(device='cpu', vad_device='cpu', speaker_device='cpu', **cpu)
    payload['gpu_throttle'] = {'enabled': False}
    payload['resource_guard'] = {**(payload.get('resource_guard') or {}), 'enabled': True,
        'pause_when_game_running': False, 'claim_enabled': False, 'priority': 'belowNormal',
        'eco_qos': True, 'prefer_e_cores': True,
        'torch_num_threads': cpu['torch_num_threads'],
        'torch_num_interop_threads': cpu['torch_num_interop_threads']}
    payload['cpu_throttle'] = {**(payload.get('cpu_throttle') or {}), 'enabled': True,
        'torch_num_threads': cpu['torch_num_threads'],
        'torch_num_interop_threads': cpu['torch_num_interop_threads']}
    emotion = payload.get('emotion_analysis')
    if isinstance(emotion, dict):
        payload['emotion_analysis'] = {**emotion, 'device': 'cpu', 'precision': 'fp32', 'inference_batch_size': 1}
    payload['_cpu_fallback'] = True
    return True
