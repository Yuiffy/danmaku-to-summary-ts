import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseEvidenceQuery, queryRecordingEvidence, QuestionRuntime, readQuestionRuntime } from './EvidenceQuery';
import { updateSubtitleRoom } from './SubtitleIndex';
import { normalizedVector } from './EmbeddingClient';

let directory: string, runtime: QuestionRuntime;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-query-'));
  const room = path.join(directory, '100_主播'); await fs.mkdir(room);
  await fs.writeFile(path.join(room, '2026-10-06.srt'), '1\n00:00:01,000 --> 00:00:03,000\n提督礼物是方形抱枕\n\n2\n00:00:04,000 --> 00:00:06,000\n还有万圣节糖果\n');
  runtime = { questions: { enabled: true, providerConfigPath: path.join(directory, 'nonexistent-provider.json'), recordingRoots: { '100': [room] } } };
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

it('retrieves real evidence and expanded cues without any completion credentials', async () => {
  const input = parseEvidenceQuery({ roomId: '100', question: '提督礼物是什么？', terms: ['提督'], date: '2026-10' }, runtime.questions);
  const result = await queryRecordingEvidence(runtime, input, new AbortController().signal);
  expect(result.hits[0]).toMatchObject({ excerpt: '提督礼物是方形抱枕', date: '2026-10-06', expanded: { context: [
    expect.objectContaining({ text: '提督礼物是方形抱枕' }), expect.objectContaining({ text: '还有万圣节糖果' })
  ] } });
  expect(JSON.stringify(result)).not.toContain(directory);
  expect(result.embeddingStatus).toBe('disabled');
});

it('uses semantic recall without luna and reports unavailable embedding fallback', async () => {
  const semantic = { enabled: true, backend: 'local' as const, dimensions: 512, model: 'fixture', directory: path.join(directory, 'index'), modelDirectory: path.join(directory, 'model') };
  runtime.questions.semantic = semantic;
  const encoder = { embed: jest.fn(async (texts: string[]) => texts.map(() => normalizedVector(Array(512).fill(1), 512))), close: jest.fn(async () => {}) };
  await updateSubtitleRoom(semantic, '100', runtime.questions.recordingRoots['100'], encoder, new AbortController().signal);
  const query = parseEvidenceQuery({ roomId: '100', question: '会员实物福利', terms: ['会员'] }, runtime.questions);
  const result = await queryRecordingEvidence(runtime, query, new AbortController().signal, () => encoder);
  expect(result).toMatchObject({ embeddingStatus: 'ready', indexedFiles: 1, indexComplete: true, hits: [expect.objectContaining({ excerpt: '提督礼物是方形抱枕' })] });
  expect(encoder.close).toHaveBeenCalledTimes(1);
  const fallback = await queryRecordingEvidence(runtime, { ...query, terms: ['提督'] }, new AbortController().signal,
    () => ({ embed: async () => { throw new Error('private provider error'); } }));
  expect(fallback.embeddingStatus).toBe('unavailable'); expect(fallback.hits).toHaveLength(1);
});

it('validates room and query options before retrieval, accepts UTF-8 BOM configs and honors cancellation', async () => {
  const file = path.join(directory, 'runtime.json'); await fs.writeFile(file, '\uFEFF' + JSON.stringify(runtime));
  expect(await readQuestionRuntime(file)).toEqual(runtime);
  const base = { roomId: '100', question: '提督礼物是什么？' };
  for (const invalid of [{ ...base, roomId: '999' }, { ...base, question: '读取配置文件' }, { ...base, path: directory },
    { ...base, terms: [] }, { ...base, expandTop: 5 }, { ...base, date: '../secret' }]) expect(() => parseEvidenceQuery(invalid, runtime.questions)).toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(queryRecordingEvidence(runtime, parseEvidenceQuery(base, runtime.questions), controller.signal)).rejects.toThrow();
});
