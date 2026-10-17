import * as fs from 'fs/promises';
import * as path from 'path';

/** Recorder filename wall clock anchors the requested interval, never the last ASR cue. */
export async function activeRecording(files: string[], roomId: string, now: number): Promise<
  { base: string; startedAt: number; end: number } | undefined> {
  const observedAt = Date.now();
  const candidates = new Map<string, number>();
  for (const file of files) {
    const base = file.replace(/(?:\.live)?\.(?:srt|xml)$/iu, '');
    const match = new RegExp(`^录制-${roomId}-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})-`).exec(path.basename(base));
    if (!match || /_merged\b/iu.test(base)) continue;
    const startedAt = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`);
    if (Number.isFinite(startedAt) && startedAt <= now) candidates.set(base, startedAt);
  }
  for (const [base, startedAt] of [...candidates].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    for (const extension of ['.flv', '.ts', '.mkv', '.mp4']) {
      try {
        const stat = await fs.lstat(base + extension);
        if (stat.isFile() && !stat.isSymbolicLink() && observedAt - stat.mtimeMs < 90000 && stat.mtimeMs <= observedAt + 5000) {
          return { base, startedAt, end: (now - startedAt) / 1000 };
        }
      } catch { /* No active original media for this candidate. */ }
    }
  }
  return undefined;
}

export function recentMinutes(args: unknown): 5 | 10 {
  const value = args as { minutes?: unknown };
  if (!value || Object.keys(value).length !== 1 || ![5, 10].includes(value.minutes as number)) throw new Error('Invalid recent window');
  return value.minutes as 5 | 10;
}
