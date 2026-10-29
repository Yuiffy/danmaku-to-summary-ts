import { canUseAsrCpuFallback } from './AsrCpuFallback';

const task = { roomId: '25788785', mediaPath: 'recording.flv' };
const config = (backend = 'paraformer') => ({ asr: { default_backend: backend,
  cpu_fallback: { enabled: true, min_available_memory_gb: 10 } } });

it('admits the actual CPU-capable model route only with sufficient RAM and explicit opt-in', () => {
  expect(canUseAsrCpuFallback(config(), task, 12 * 1024 ** 3)).toBe(true);
  expect(canUseAsrCpuFallback(config('sensevoice'), task, 12 * 1024 ** 3)).toBe(true);
  expect(canUseAsrCpuFallback(config('whisper'), task, 12 * 1024 ** 3)).toBe(false);
  expect(canUseAsrCpuFallback(config('fun_asr_nano_vllm'), task, 12 * 1024 ** 3)).toBe(false);
  expect(canUseAsrCpuFallback(config(), task, 5 * 1024 ** 3)).toBe(false);
  expect(canUseAsrCpuFallback({ asr: { default_backend: 'paraformer' } }, task, 30 * 1024 ** 3)).toBe(false);
  const rollout = config();
  Object.assign(rollout.asr, { moss_rollout: { enabled: true, room_ids: [], ratio: 1, eligibility: 'confirmed_multi' } });
  expect(canUseAsrCpuFallback(rollout, task, 30 * 1024 ** 3)).toBe(false);
});
