import * as os from 'os';
import * as path from 'path';

/** Resolve the same model route as the child; changing device must never change models. */
export function canUseAsrCpuFallback(config: any, task: { roomId?: unknown; mediaPath: string },
  availableBytes = os.freemem()): boolean {
  const policy = config.asr?.cpu_fallback;
  if (policy?.enabled !== true || availableBytes < Math.max(4, Number(policy.min_available_memory_gb) || 10) * 1024 ** 3) return false;
  const { resolveAsrBackend } = require(path.join(process.cwd(), 'src/scripts/asr/asr_backends.js'));
  // Participant collection runs later. Reserve GPU-only rollout buckets even if a
  // pending task has not discovered its multi-speaker evidence yet.
  const selected = resolveAsrBackend(config, { room_id: String(task.roomId || ''),
    filename: path.basename(task.mediaPath), input: task.mediaPath,
    speakerRequest: { participantDiscovery: { mode: 'multi', modeStatus: 'confirmed' } } });
  return ['paraformer', 'sensevoice'].includes(selected.backend);
}
