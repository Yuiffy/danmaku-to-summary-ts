import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createRemoteEmbedder, Embedder, EmbeddingConfig, normalizedVector } from './EmbeddingClient';
import { acquireIndexLock, loadManifest, pruneSubtitleShards, searchSubtitleIndex, updateSubtitleRoom } from './SubtitleIndex';
import { chunkSubtitles, listSubtitles, parseSubtitle } from './SubtitleCorpus';
import { RecordingEvidence } from './RecordingEvidence';
import { nextIndexRun } from './IndexSchedule';

let directory: string, room: string, file: string, config: EmbeddingConfig;
const signal = new AbortController().signal;
const text = (value: string) => `1\n00:00:01,000 --> 00:00:02,000\n${value}\n\n2\n00:00:03,000 --> 00:00:05,000\n后来去了别的地方\n`;
let embedder: Embedder;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-index-'));
  room = path.join(directory, 'recordings');
  await fs.mkdir(path.join(room, '2025_01_01'), { recursive: true });
  file = path.join(room, '2025_01_01/stream.srt');
  await fs.writeFile(file, text('以前挑战过玛尔基特'));
  config = { enabled: true, backend: 'daiyu', directory: path.join(directory, 'index'), model: 'fixture', dimensions: 32 };
  embedder = { embed: jest.fn(async texts => texts.map(() => normalizedVector(Array.from({ length: 32 }, (_, i) => i === 0 ? 1 : 0), 32))) };
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

it('builds incrementally, ranks and scopes by room/date/version, and removes deleted sources', async () => {
  const roots = [room];
  const first = await updateSubtitleRoom(config, '100', roots, embedder, signal);
  expect(first.sources).toHaveLength(1);
  expect(embedder.embed).toHaveBeenCalledTimes(1);
  await updateSubtitleRoom(config, '100', roots, embedder, signal);
  expect(embedder.embed).toHaveBeenCalledTimes(1);
  const vector = (await embedder.embed(['question'], signal))[0];
  expect(await searchSubtitleIndex(config, '100', roots, vector, '2025', signal)).toMatchObject([{ file, cue: 0, score: 1 }]);
  expect(await searchSubtitleIndex(config, '200', roots, vector, null, signal)).toEqual([]);
  expect(await searchSubtitleIndex(config, '100', roots, vector, '2026', signal)).toEqual([]);
  expect(await loadManifest({ ...config, model: 'different' }, '100', roots)).toBeUndefined();
  expect(await loadManifest(config, '100', [directory])).toBeUndefined();
  await fs.writeFile(file, text('修改后的字幕'));
  const changed = await updateSubtitleRoom(config, '100', roots, embedder, signal);
  expect(changed.sources[0].hash).not.toBe(first.sources[0].hash);
  await fs.unlink(file);
  expect((await updateSubtitleRoom(config, '100', roots, embedder, signal)).sources).toEqual([]);
});

it('keeps an offline archive and completed shards after interruption, and rejects concurrent writers', async () => {
  const release = await acquireIndexLock(config.directory);
  await expect(acquireIndexLock(config.directory)).rejects.toThrow('already running');
  await release();
  // A reused/live PID in a stale status file must not prevent recovery after the OS lease disappeared.
  await fs.writeFile(path.join(config.directory, 'writer.lock'), JSON.stringify({ pid: process.pid, token: 'stale' }));
  await (await acquireIndexLock(config.directory))();
  await updateSubtitleRoom(config, '100', [room], embedder, signal);
  await fs.rename(room, room + '-offline');
  const offline = await updateSubtitleRoom(config, '100', [room], embedder, signal);
  expect(offline).toMatchObject({ incomplete: true, sources: [expect.objectContaining({ file })] });
  await fs.rename(room + '-offline', room);
  await fs.writeFile(path.join(room, '2025_01_01/new.srt'), text('另一个节目'));
  await expect(updateSubtitleRoom(config, '100', [room], { embed: async () => { throw new Error('offline'); } }, signal)).rejects.toThrow('offline');
  expect((await loadManifest(config, '100', [room]))?.sources).toHaveLength(1);
  const aborted = new AbortController(); aborted.abort();
  await expect(updateSubtitleRoom(config, '100', [room], embedder, aborted.signal)).rejects.toThrow();
});

it('turns semantic matches into verified citations, rejects stale text and falls back on failure', async () => {
  await updateSubtitleRoom(config, '100', [room], embedder, signal);
  const vector = (await embedder.embed(['query'], signal))[0];
  const semanticSearch = (date: string | null) => searchSubtitleIndex(config, '100', [room], vector, date, signal);
  const evidence = new RecordingEvidence([room], signal, { semanticSearch });
  const result = await evidence.search({ terms: ['魂类游戏'], kind: 'subtitle', date: null });
  expect(result.hits).toHaveLength(1);
  expect(evidence.clue(result.hits[0].evidenceId)?.excerpt).toBe('以前挑战过玛尔基特');
  expect(JSON.stringify(result)).not.toContain(directory);
  await fs.writeFile(file, text('今天天气很好'));
  expect((await new RecordingEvidence([room], signal, { semanticSearch }).search({ terms: ['魂类游戏'], kind: 'subtitle', date: null })).hits).toEqual([]);
  const fallback = new RecordingEvidence([room], signal, { semanticSearch: async () => { throw new Error('offline'); } });
  expect((await fallback.search({ terms: ['天气'], kind: 'subtitle', date: null })).hits).toHaveLength(1);
});

it('rejects semantic source injection and ignores speaker copies and linked directories', async () => {
  const secret = path.join(directory, 'private'); await fs.mkdir(secret);
  await fs.writeFile(path.join(secret, 's.srt'), text('不能读取'));
  await fs.symlink(secret, path.join(room, '2024_01_01'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.copyFile(file, file.replace('.srt', '.speaker.srt'));
  expect(await listSubtitles(room, signal)).toHaveLength(1);
  const injected = new RecordingEvidence([room], signal, { semanticSearch: async () => [{
    file: path.join(secret, 's.srt'), root: secret, date: '2025-01-01', hash: 'a'.repeat(64), cue: 0, score: 1
  }] });
  expect((await injected.search({ terms: ['不能读取'], kind: 'all', date: null })).hits).toEqual([]);
});

it('chunks bounded speech with overlap and schedules daily catch-up/retries in Shanghai time', () => {
  const cues = Array.from({ length: 40 }, (_, i) => ({ seconds: i, text: '一段讲话' }));
  expect(chunkSubtitles(cues).map(chunk => chunk.cue)).toEqual([7, 21, 33]);
  expect(parseSubtitle(text('你好'))[0]).toEqual({ seconds: 1, text: '你好' });
  const now = Date.parse('2026-10-07T06:00:00+08:00');
  expect(nextIndexRun(now)).toBe(now);
  expect(nextIndexRun(now, now)).toBe(Date.parse('2026-10-08T05:00:00+08:00'));
  expect(nextIndexRun(now, now - 86400000, now)).toBe(now + 900000);
  expect(nextIndexRun(now, now - 86400000, now - 1800000)).toBe(now);
});

it('validates provider dimensions/order/finiteness and redacts remote errors', async () => {
  const settings = { url: 'http://localhost/v1/chat/completions', apiKey: 'private' };
  const row = Array.from({ length: 32 }, () => 1);
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ index: 1, embedding: row }, { index: 0, embedding: row }] }) });
  const remote = createRemoteEmbedder(config, settings, transport);
  expect(await remote.embed(['a', 'b'], signal)).toHaveLength(2);
  expect(transport.mock.calls[0][0]).toBe('http://localhost/v1/embeddings');
  expect(() => normalizedVector([NaN], 1)).toThrow();
  expect(() => normalizedVector([0], 1)).toThrow();
  transport.mockResolvedValue({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [1] }] }) });
  await expect(remote.embed(['a'], signal)).rejects.toThrow('Embedding provider request failed');
});

it('publishes partial checkpoints and only prunes unreferenced shards after the grace period', async () => {
  for (let i = 0; i < 21; i++) await fs.writeFile(path.join(room, `2025_01_01/copy${String(i).padStart(2, '0')}.srt`), text('相同字幕'));
  const failing: Embedder = { embed: async (texts, abort) => {
    if (texts.some(value => value.includes('玛尔基特'))) throw new Error('interrupted');
    return embedder.embed(texts, abort);
  } };
  await expect(updateSubtitleRoom(config, '100', [room], failing, signal)).rejects.toThrow('interrupted');
  const partial = await loadManifest(config, '100', [room]);
  expect(partial).toMatchObject({ incomplete: true });
  expect(partial?.sources).toHaveLength(20);
  expect(embedder.embed).toHaveBeenCalledTimes(1); // Identical exports reuse a content-addressed shard.
  const orphan = path.join(config.directory, 'shards', 'a'.repeat(64) + '.f32');
  await fs.writeFile(orphan, 'unused');
  expect(await pruneSubtitleShards(config.directory)).toBe(0);
  await fs.utimes(orphan, new Date(0), new Date(0));
  expect(await pruneSubtitleShards(config.directory)).toBe(1);
  expect(await loadManifest(config, '100', [room])).toEqual(partial);
});
