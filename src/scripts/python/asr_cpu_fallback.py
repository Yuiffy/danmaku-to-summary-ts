"""Per-job CPU admission overrides; never alter model identity or speaker policy."""
import os


def apply_cpu_fallback(payload, environ=None):
    env = os.environ if environ is None else environ
    if env.get('ASR_CPU_FALLBACK') != '1':
        return False
    if payload.get('backend') not in ('paraformer', 'sensevoice'):
        raise ValueError('Selected ASR backend does not support CPU fallback')
    env.update(CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2')
    payload.update(device='cpu', vad_device='cpu', speaker_device='cpu', ncpu=2,
                   batch_size_s=30, batch_size_threshold_s=30, inference_batch_size=1)
    payload['gpu_throttle'] = {'enabled': False}
    payload['resource_guard'] = {**(payload.get('resource_guard') or {}), 'enabled': True,
        'pause_when_game_running': False, 'claim_enabled': False, 'priority': 'belowNormal',
        'eco_qos': True, 'prefer_e_cores': True, 'torch_num_threads': 2, 'torch_num_interop_threads': 1}
    payload['cpu_throttle'] = {**(payload.get('cpu_throttle') or {}), 'enabled': True,
        'torch_num_threads': 2, 'torch_num_interop_threads': 1}
    emotion = payload.get('emotion_analysis')
    if isinstance(emotion, dict):
        payload['emotion_analysis'] = {**emotion, 'device': 'cpu', 'precision': 'fp32', 'inference_batch_size': 1}
    payload['_cpu_fallback'] = True
    return True
