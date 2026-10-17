import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

export interface LiveAsrChunk { start: number; end: number; result: Record<string, unknown> }
export interface LiveAsrCache {
  version: number; room_id: string; spec: Record<string, unknown>;
  source: { sample_hash: string; size: number; birth_ms: number };
  chunks: LiveAsrChunk[]; updated_at?: number;
}
export const liveCachePath = (source: string): string => source.slice(0, -path.extname(source).length) + '.live-asr.json';

export async function mediaIdentity(source: string): Promise<LiveAsrCache['source']> {
  const handle = await fs.open(source, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size < 131072) throw new Error('Recording too small for live ASR identity');
    const sample = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 65536);
    if (bytesRead !== sample.length) throw new Error('Incomplete media fingerprint');
    return { sample_hash: createHash('sha256').update(sample).digest('hex'), size: stat.size, birth_ms: Math.round(stat.birthtimeMs) };
  } finally { await handle.close(); }
}

export async function atomicLiveJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), 'utf8');
  await fs.rename(temporary, file);
}

/** Called before source segments move into bak. Keep holes explicit for final CPU completion. */
export async function writeMergedLiveAsrCache(
  sources: string[], output: string, duration: (source: string) => Promise<number>,
  gapAfter: (index: number) => number
): Promise<boolean> {
  const snapshots = await Promise.all(sources.map(async source => {
    try { return JSON.parse(await fs.readFile(liveCachePath(source), 'utf8')) as LiveAsrCache; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }));
  const first = snapshots.find(Boolean);
  if (!first) return false;
  let offset = 0;
  const chunks: LiveAsrChunk[] = [];
  for (let i = 0; i < sources.length; i++) {
    const length = await duration(sources[i]);
    if (!Number.isFinite(length) || length <= 0) throw new Error('Invalid segment duration');
    const snapshot = snapshots[i];
    if (snapshot) {
      const identity = await mediaIdentity(sources[i]);
      if (snapshot.version !== 1 || snapshot.room_id !== first.room_id ||
          JSON.stringify(snapshot.spec) !== JSON.stringify(first.spec) ||
          snapshot.source.sample_hash !== identity.sample_hash || snapshot.source.birth_ms !== identity.birth_ms ||
          snapshot.source.size > identity.size) throw new Error('Live ASR source/model mismatch at merge');
      let cursor = 0;
      for (const chunk of snapshot.chunks) {
        if (!Number.isFinite(chunk.start) || !Number.isFinite(chunk.end) || chunk.start < cursor - 0.01 ||
            chunk.end <= chunk.start || chunk.end > length + 0.25) throw new Error('Invalid live ASR merge coverage');
        chunks.push({ ...chunk, start: chunk.start + offset, end: chunk.end + offset });
        cursor = chunk.end;
      }
    }
    offset += length;
    const gap = i < sources.length - 1 ? gapAfter(i) : 0;
    if (!Number.isFinite(gap) || gap < 0) throw new Error('Invalid live ASR merge gap');
    if (gap) chunks.push({ start: offset, end: offset + gap, result: { text: '', timestamp: [], sentence_info: [] } });
    offset += gap;
  }
  if (Math.abs(await duration(output) - offset) > 0.25) throw new Error('Merged media timeline differs from live ASR timeline');
  await atomicLiveJson(liveCachePath(output), { version: 1, room_id: first.room_id, spec: first.spec,
    source: await mediaIdentity(output), chunks, updated_at: Date.now() / 1000 });
  return true;
}
