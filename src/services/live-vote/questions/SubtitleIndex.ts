import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createServer } from 'net';
import { Embedder, EmbeddingConfig } from './EmbeddingClient';
import { chunkSubtitles, digest, listSubtitles, parseSubtitle, readSubtitle, recordingFolderDate, SubtitleSource, within } from './SubtitleCorpus';
import { writeSubtitleLexical } from './SubtitleLexicalIndex';

export interface IndexedSource extends SubtitleSource { hash: string; key: string; chunks: number }
export interface IndexManifest {
  version: string; roomId: string; roots: string[]; updatedAt: string; incomplete: boolean; sources: IndexedSource[];
}
export interface SemanticMatch extends SubtitleSource { hash: string; cue: number; score: number }
export interface SemanticFocus { query?: string; files?: ReadonlySet<string>; session?: SubtitleSource }
export type SemanticSearch = (date: string | null, terms: string[], focus?: SemanticFocus) => Promise<SemanticMatch[]>;
export function indexVersion(config: EmbeddingConfig): string {
  return digest(JSON.stringify(['subtitle-v1-400chars-15cues-overlap1', config.backend, config.model, config.dimensions]));
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), 'utf8');
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
}
export async function loadManifest(config: EmbeddingConfig, roomId: string, roots: string[]): Promise<IndexManifest | undefined> {
  if (!/^[1-9]\d*$/u.test(roomId)) throw new Error('Invalid index room');
  const file = path.join(config.directory, `${roomId}.json`);
  try {
    if ((await fs.stat(file)).size > 8 * 1024 * 1024) return undefined;
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as IndexManifest;
    if (value.version !== indexVersion(config) || value.roomId !== roomId || JSON.stringify(value.roots) !== JSON.stringify(roots) ||
      !Array.isArray(value.sources) || value.sources.length > 20000) return undefined;
    for (const source of value.sources) {
      if (!/^[a-f0-9]{64}$/u.test(source.key) || !/^[a-f0-9]{64}$/u.test(source.hash) ||
        !Number.isInteger(source.chunks) || source.chunks < 0 || source.chunks > 100000 ||
        typeof source.root !== 'string' || typeof source.file !== 'string' || !within(source.root, source.file) ||
        source.date !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(source.date)) return undefined;
    }
    return value;
  } catch { return undefined; }
}

/** OS-held single-writer lease. Process death releases it, even if a later process reuses the PID. */
export async function acquireIndexLock(directory: string): Promise<() => Promise<void>> {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'writer.lock');
  const canonical = await fs.realpath(directory);
  const identity = digest(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
  const server = createServer(socket => socket.destroy());
  // Windows named pipes have kernel-managed lifetime. The portable fallback is a loopback-only exclusive port.
  const address = process.platform === 'win32' ? { path: `\\\\.\\pipe\\subtitle-index-${identity}` } :
    { host: '127.0.0.1', port: 49152 + parseInt(identity.slice(0, 8), 16) % 16000, exclusive: true };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(new Error('Subtitle index writer already running or lock unavailable')));
      server.listen(address, resolve);
    });
  } catch (error) { server.close(); throw error; }
  const token = randomUUID();
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  try { await atomicJson(file, { pid: process.pid, token, lease: 'os-v1' }); }
  catch (error) { await close(); throw error; }
  return async () => {
    try {
      const owner = JSON.parse(await fs.readFile(file, 'utf8'));
      if (owner.token === token) await fs.unlink(file);
    } finally { await close(); }
  };
}

async function shardValid(directory: string, key: string, count: number, dimensions: number): Promise<boolean> {
  try {
    return (await fs.stat(path.join(directory, `${key}.f32`))).size === count * dimensions * 4;
  } catch { return false; }
}

/** Checkpoint each immutable shard. A failed room retains its previous readable manifest. */
export async function updateSubtitleRoom(config: EmbeddingConfig, roomId: string, roots: string[], embedder: Embedder,
  signal: AbortSignal, progress: (files: number, chunks: number) => void | Promise<void> = () => {}): Promise<IndexManifest> {
  if (!/^[1-9]\d*$/u.test(roomId)) throw new Error('Invalid index room');
  const directory = path.join(config.directory, 'shards');
  await fs.mkdir(directory, { recursive: true });
  const previous = await loadManifest(config, roomId, roots);
  const sources: IndexedSource[] = [];
  let incomplete = false, processed = 0, embedded = 0;
  for (const configuredRoot of roots) {
    let listed: SubtitleSource[];
    try { listed = await listSubtitles(configuredRoot, signal); }
    catch {
      signal.throwIfAborted();
      incomplete = true;
      // An offline drive is not deletion. Keep its last known records for the next run.
      sources.push(...(previous?.sources.filter(source => path.resolve(source.root) === path.resolve(configuredRoot)) || []));
      continue;
    }
    for (const source of listed) {
      signal.throwIfAborted();
      let snapshot: Awaited<ReturnType<typeof readSubtitle>>;
      try { snapshot = await readSubtitle(source, signal); }
      catch { signal.throwIfAborted(); incomplete = true; continue; }
      const cues = parseSubtitle(snapshot.content), chunks = chunkSubtitles(cues);
      const key = digest(indexVersion(config) + snapshot.hash);
      if (!(await shardValid(directory, key, chunks.length, config.dimensions))) {
        const file = path.join(directory, `${key}.f32`);
        const temporary = `${file}.${randomUUID()}.tmp`;
        const handle = await fs.open(temporary, 'wx');
        try {
          for (let offset = 0; offset < chunks.length; offset += 32) {
            signal.throwIfAborted();
            const batch = chunks.slice(offset, offset + 32);
            const vectors = await embedder.embed(batch.map(chunk => chunk.text), signal);
            if (vectors.length !== batch.length || vectors.some(vector => vector.length !== config.dimensions ||
              vector.some(value => !Number.isFinite(value)))) throw new Error('Invalid index embeddings');
            const bytes = Buffer.alloc(vectors.length * config.dimensions * 4);
            let position = 0;
            for (const vector of vectors) for (const value of vector) { bytes.writeFloatLE(value, position); position += 4; }
            await handle.writeFile(bytes);
            embedded += vectors.length;
          }
          await handle.close();
          await fs.rename(temporary, file);
        } finally { await handle.close().catch(() => {}); await fs.rm(temporary, { force: true }); }
      }
      // Metadata is deterministic, inexpensive to restore after interruption.
      await atomicJson(path.join(directory, `${key}.json`), chunks.map(chunk => chunk.cue));
      await writeSubtitleLexical(directory, key, cues);
      sources.push({ ...source, hash: snapshot.hash, key, chunks: chunks.length });
      await progress(++processed, embedded);
      if (processed % 20 === 0) {
        const completed = new Set(sources.map(item => item.file));
        await atomicJson(path.join(config.directory, `${roomId}.json`), {
          version: indexVersion(config), roomId, roots, updatedAt: new Date().toISOString(), incomplete: true,
          sources: [...sources, ...(previous?.sources.filter(item => !completed.has(item.file)) || [])]
        });
      }
    }
  }
  const manifest: IndexManifest = { version: indexVersion(config), roomId, roots, sources, incomplete, updatedAt: new Date().toISOString() };
  await atomicJson(path.join(config.directory, `${roomId}.json`), manifest);
  return manifest;
}

/** Remove only old unreferenced generated shards, retaining a seven-day recovery grace period. */
export async function pruneSubtitleShards(directory: string, now = Date.now()): Promise<number> {
  const used = new Set<string>();
  for (const name of await fs.readdir(directory)) {
    if (!/^[1-9]\d*\.json$/u.test(name)) continue;
    // A malformed manifest aborts cleanup rather than guessing which files are safe to delete.
    const manifest = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as IndexManifest;
    for (const source of manifest.sources) used.add(source.key);
  }
  const shards = path.join(directory, 'shards');
  let removed = 0;
  for (const name of await fs.readdir(shards)) {
    const key = /^([a-f0-9]{64})\.(?:json|f32|lex\.json\.gz)(?:\.[a-f0-9-]+\.tmp)?$/u.exec(name)?.[1];
    if (!key || used.has(key)) continue;
    const file = path.join(shards, name), stat = await fs.lstat(file);
    if (stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs > 7 * 86400000) { await fs.unlink(file); removed++; }
  }
  return removed;
}

/** Stream blocks off SSD: no full-room vector matrix retained in the vote process. */
export async function searchSubtitleIndex(config: EmbeddingConfig, roomId: string, roots: string[],
  vector: Float32Array, date: string | null, signal: AbortSignal, files?: ReadonlySet<string>): Promise<SemanticMatch[]> {
  if (vector.length !== config.dimensions) throw new Error('Query/index dimension mismatch');
  const manifest = await loadManifest(config, roomId, roots);
  if (!manifest) return [];
  const allowedRoots = new Set<string>();
  for (const root of roots) { try { allowedRoots.add(await fs.realpath(root)); } catch { /* Offline archive. */ } }
  const ranked: Array<{ source: IndexedSource; ordinal: number; score: number }> = [];
  const dedupe = new Set<string>();
  const blockRows = 256, rowBytes = config.dimensions * 4;
  const buffer = Buffer.alloc(blockRows * rowBytes);
  for (const source of manifest.sources) {
    signal.throwIfAborted();
    if (files && !files.has(source.file) || !allowedRoots.has(source.root) || date && !source.date?.startsWith(date) || dedupe.has(source.key)) continue;
    // Current filesystem membership is checked again before evidence registration.
    const relative = path.relative(source.root, source.file).split(path.sep);
    if (relative.length > 2 || relative.length === 2 && !recordingFolderDate(relative[0]) || !/\.srt$/iu.test(source.file)) continue;
    dedupe.add(source.key);
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try { handle = await fs.open(path.join(config.directory, 'shards', `${source.key}.f32`), 'r'); } catch { continue; }
    try {
      if ((await handle.stat()).size !== source.chunks * rowBytes) continue;
      for (let first = 0; first < source.chunks; first += blockRows) {
        signal.throwIfAborted();
        const rows = Math.min(blockRows, source.chunks - first), required = rows * rowBytes;
        let received = 0;
        while (received < required) {
          const { bytesRead } = await handle.read(buffer, received, required - received, first * rowBytes + received);
          if (!bytesRead) throw new Error('Incomplete vector shard');
          received += bytesRead;
        }
        for (let row = 0; row < rows; row++) {
          let score = 0;
          for (let dimension = 0; dimension < vector.length; dimension++) score += vector[dimension] * buffer.readFloatLE(row * rowBytes + dimension * 4);
          if (!Number.isFinite(score) || ranked.length >= 32 && score <= ranked[ranked.length - 1].score) continue;
          ranked.push({ source, ordinal: first + row, score });
          ranked.sort((a, b) => b.score - a.score);
          const fromFile = ranked.filter(item => item.source.file === source.file);
          if (fromFile.length > 4) ranked.splice(ranked.indexOf(fromFile.at(-1)!), 1);
          if (ranked.length > 32) ranked.pop();
        }
      }
    } finally { await handle.close(); }
  }
  const cueMaps = new Map<string, number[]>();
  const results: SemanticMatch[] = [];
  for (const item of ranked) {
    signal.throwIfAborted();
    let cues = cueMaps.get(item.source.key);
    if (!cues) {
      const file = path.join(config.directory, 'shards', `${item.source.key}.json`);
      if ((await fs.stat(file)).size > 1024 * 1024) continue;
      cues = JSON.parse(await fs.readFile(file, 'utf8')) as number[];
      if (!Array.isArray(cues) || cues.length !== item.source.chunks) continue;
      cueMaps.set(item.source.key, cues);
    }
    const cue = cues[item.ordinal];
    if (Number.isInteger(cue) && cue >= 0) results.push({ ...item.source, cue, score: item.score });
  }
  return results;
}
