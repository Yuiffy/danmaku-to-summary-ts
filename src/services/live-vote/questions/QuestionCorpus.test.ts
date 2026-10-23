import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { QuestionCorpus } from './QuestionCorpus';
import { formatQuestionRecord, LiveQuestionConfig, validateQuestionConfig } from './QuestionPolicy';
import { embeddingQuestion, questionScope } from './QuestionScope';
import { runQuestionAgent } from './QuestionAgent';
import { normalizedVector } from './EmbeddingClient';
import { updateSubtitleRoom } from './SubtitleIndex';

let directory: string, config: LiveQuestionConfig;
const signal = () => new AbortController().signal;
const args = { terms: ['舰礼'], kind: 'all', date: '2026-10' };
const catalog = (item = '方形抱枕', status = 'official') => ({ version: 1, months: [{
  month: '2026-10', note: '未公布总督礼物，不推定继承低档礼物。',
  entries: [{ tier: 'captain', items: ['行李牌'], condition: '达到150舰才追加', status: 'recorded', sources: ['s1'] },
    { tier: 'admiral', items: [item], condition: '', status, sources: ['s1'] }],
  sources: [{ id: 's1', kind: 'official-dynamic', date: '2026-09-30', title: '十月礼物预告', excerpt: '提督礼物是方形抱枕',
    url: 'https://example.invalid/never-fetch', file: 'never-open-this', privateField: 'must-not-leak' }]
}] });
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'question-corpus-'));
  config = { enabled: true, providerConfigPath: path.join(directory, 'missing.json'), recordingRoots: {}, roomAliases: { '100': ['小岁'] } };
  for (const [id, name, phrase] of [['100', '岁己SUI', '提督礼物是抱枕'], ['200', '七海Nana7mi', '舰长礼物是立牌'], ['300', '礼墨Sumi', '总督礼物是围巾'], ['400', '南町Nightin', '舰长礼物是贴纸']]) {
    const root = path.join(directory, `${id}_${name}`); await fs.mkdir(root); config.recordingRoots[id] = [root];
    await fs.writeFile(path.join(root, '2026-10-06.srt'), `1\n00:00:01,000 --> 00:00:03,000\n${phrase}\n\n2\n00:00:04,000 --> 00:00:06,000\n已经公布了\n`);
  }
  const file = path.join(directory, 'gifts.json'); await fs.writeFile(file, JSON.stringify(catalog())); config.giftCatalogs = { '100': file };
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

it('defaults to current room, routes explicit names/aliases and comparisons, and bounds the scope', () => {
  expect(questionScope(config, '100', '这个月的舰礼是什么').map(r => r.roomId)).toEqual(['100']);
  expect(questionScope(config, '200', '小岁这个月的舰礼是什么').map(r => r.roomId)).toEqual(['100']);
  expect(questionScope(config, '100', '七海和你的舰礼有什么区别').map(r => r.roomId)).toEqual(['100', '200']);
  expect(questionScope(config, '300', '岁己和七海的舰礼是什么').map(r => r.roomId)).toEqual(['100', '200']);
  expect(questionScope(config, '100', '直播间200的舰礼是什么').map(r => r.roomId)).toEqual(['200']);
  expect(() => questionScope(config, '999', '舰礼')).toThrow();
  expect(() => questionScope(config, '100', '岁己七海礼墨南町的舰礼')).toThrow();
  expect(() => validateQuestionConfig({ ...config, giftCatalogs: { '999': path.join(directory, 'gifts.json') } })).toThrow();
  expect(() => validateQuestionConfig({ ...config, giftCatalogs: { '100': '../secret.json' } })).toThrow();
});

it('expands fleet shorthand, keeps room-qualified IDs and rejects invented scope/path/context arguments', async () => {
  const corpus = new QuestionCorpus(config, { roomId: '300', question: '岁己和七海的舰礼是什么' }, signal());
  const result = await corpus.search(args);
  expect(new Set(result.hits.map(hit => hit.roomId))).toEqual(new Set(['100', '200']));
  expect(result.hits.some(hit => hit.excerpt === '舰长礼物是立牌')).toBe(true);
  expect(result.hits.some(hit => hit.excerpt === '提督礼物是抱枕')).toBe(true);
  expect(result.hits.some(hit => hit.excerpt.includes('围巾'))).toBe(false);
  for (const hit of result.hits) {
    expect(corpus.citation(hit.evidenceId)?.roomId).toBe(hit.roomId);
    for (const cue of hit.context) if (cue.evidenceId) expect(corpus.citation(cue.evidenceId)?.roomId).toBe(hit.roomId);
    const context = corpus.context({ evidenceId: hit.evidenceId });
    expect(context).toHaveProperty('hit.roomId', hit.roomId);
  }
  expect(corpus.citation('r300_ev1')).toBeUndefined();
  expect(corpus.context({ evidenceId: '../gifts.json' })).toHaveProperty('error');
  await expect(corpus.search({ ...args, roomId: '300' })).rejects.toThrow();
  await expect(corpus.search({ ...args, path: directory })).rejects.toThrow();
  expect(embeddingQuestion('舰礼是什么')).toContain('总督');
  expect(embeddingQuestion('玩过什么游戏')).toBe('玩过什么游戏');
});

it('selects gift month rather than announcement date and preserves tiers, conditions and uncertain sources', async () => {
  const corpus = new QuestionCorpus(config, { roomId: '100', question: '十月舰礼是什么' }, signal());
  const result = await corpus.search(args), hit = result.hits[0];
  expect(hit).toMatchObject({ kind: 'gift-catalog', catalogMonth: '2026-10', date: '2026-09-30', roomName: '岁己SUI' });
  expect(hit.excerpt).toContain('达到150舰才追加');
  expect(hit.excerpt).toContain('舰长（录播整理，ASR可能有误）');
  expect(hit.excerpt).toContain('提督（官方公告）：方形抱枕');
  expect(hit.excerpt).toContain('总督：本月档案未收录');
  expect(JSON.stringify(result)).not.toMatch(/must-not-leak|never-fetch|never-open-this/);
  expect((await corpus.search({ ...args, date: '2026-09' })).hits.some(hit => hit.kind === 'gift-catalog')).toBe(false);
  expect((await corpus.search({ ...args, kind: 'danmaku' })).hits).toEqual([]);
  const record = formatQuestionRecord({ request: { roomId: '200', uid: '1', question: '岁己舰礼' }, result: { answer: '舰礼', clues: [corpus.clue(hit.evidenceId)!] } });
  expect(record).toContain('岁己SUI（100）'); expect(record).toContain('所属月2026-10'); expect(record).toContain('达到150舰');
  await fs.writeFile(config.giftCatalogs!['100'], JSON.stringify(catalog('玩偶', 'lead')));
  const updated = await new QuestionCorpus(config, { roomId: '100', question: '舰礼' }, signal()).search(args);
  expect(updated.hits[0].excerpt).toContain('提督（仅线索，未确认）：玩偶');
});

it('falls back to recordings for unavailable catalogs and honors cancellation', async () => {
  await fs.writeFile(config.giftCatalogs!['100'], '{not json');
  const corpus = new QuestionCorpus(config, { roomId: '100', question: '舰礼是什么' }, signal());
  expect((await corpus.search(args)).hits[0]).toMatchObject({ kind: 'subtitle', excerpt: '提督礼物是抱枕' });
  expect(corpus.coverage.get('100')?.catalogStatus).toBe('unavailable');
  const controller = new AbortController(); controller.abort();
  await expect(new QuestionCorpus(config, { roomId: '100', question: '舰礼' }, controller.signal).search(args)).rejects.toThrow();
});

it('shares one question embedding across rooms and refinements and closes the local model once', async () => {
  const semantic = { enabled: true, backend: 'local' as const, dimensions: 512, model: 'fixture', directory: path.join(directory, 'index'), modelDirectory: path.join(directory, 'model') };
  config.semantic = semantic;
  const encoder = { embed: jest.fn(async (texts: string[]) => texts.map(() => normalizedVector(Array(512).fill(1), 512))), close: jest.fn(async () => {}) };
  for (const roomId of ['100', '200']) await updateSubtitleRoom(semantic, roomId, config.recordingRoots[roomId], encoder, signal());
  encoder.embed.mockClear();
  const corpus = new QuestionCorpus(config, { roomId: '100', question: '岁己和七海的舰礼' }, signal(), undefined, () => encoder);
  await corpus.search(args); await corpus.search({ ...args, date: null }); await corpus.close();
  expect(encoder.embed).toHaveBeenCalledTimes(1); expect(encoder.close).toHaveBeenCalledTimes(1);
  expect(corpus.coverage.get('100')?.indexedFiles).toBe(1); expect(corpus.coverage.get('200')?.indexedFiles).toBe(1);
});

it('re-embeds a focused query, reuses it across dates/rooms, and bounds new query embeddings', async () => {
  const semantic = { enabled: true, backend: 'local' as const, dimensions: 512, model: 'fixture', directory: path.join(directory, 'index'), modelDirectory: path.join(directory, 'model') };
  config.semantic = semantic;
  const encoder = { embed: jest.fn(async (texts: string[]) => texts.map(() => normalizedVector(Array(512).fill(1), 512))), close: jest.fn(async () => {}) };
  for (const roomId of ['100', '200']) await updateSubtitleRoom(semantic, roomId, config.recordingRoots[roomId], encoder, signal());
  encoder.embed.mockClear();
  const corpus = new QuestionCorpus(config, { roomId: '100', question: '岁己和七海体检有没有测身高' }, signal(), undefined, () => encoder);
  try {
    await corpus.search({ ...args, query: '去体检的经历' });
    await corpus.search({ ...args, query: '去体检的经历', date: null });
    await corpus.search({ ...args, query: '体检测量项目' });
    expect(encoder.embed.mock.calls.map(call => call[0])).toEqual([['去体检的经历'], ['体检测量项目']]);
    for (let i = 0; i < 8; i++) await corpus.search({ ...args, query: `检索重点${i}` });
    expect(encoder.embed).toHaveBeenCalledTimes(6);
    expect(encoder.close).not.toHaveBeenCalled();
  } finally { await corpus.close(); }
  expect(encoder.close).toHaveBeenCalledTimes(1);
});

it('filters session sources before semantic top-K and keeps focused followups in the anchor room', async () => {
  config.giftCatalogs = {};
  const root = config.recordingRoots['100'][0];
  const base = '2024_10_01_00_50_09_秋日';
  await fs.writeFile(path.join(root, `${base}_1_fix.srt`), '1\n00:26:48,000 --> 00:26:51,000\n昨天去体检了\n');
  await fs.writeFile(path.join(root, `${base}_3_fix.srt`), '1\n02:21:12,000 --> 02:21:15,000\n检查的是普通身高体重项目\n');
  // More globally superior matches than the semantic candidate cap, all outside the session.
  for (let i = 0; i < 40; i++) await fs.writeFile(path.join(root, `2024_10_01_12_00_${String(i).padStart(2, '0')}_别场.srt`), '1\n00:01:00,000 --> 00:01:03,000\n身高玩笑\n');
  config.semantic = { enabled: true, backend: 'local', dimensions: 512, model: 'fixture', directory: path.join(directory, 'index'), modelDirectory: path.join(directory, 'model') };
  const vector = (first: number, second: number) => Float32Array.from([first, second, ...Array(510).fill(0)]);
  const encoder = { embed: jest.fn(async (texts: string[]) => texts.map(text => text.includes('普通') ? vector(0.8, 0.6) : vector(1, 0))), close: jest.fn(async () => {}) };
  for (const roomId of ['100', '200']) await updateSubtitleRoom(config.semantic, roomId, config.recordingRoots[roomId], encoder, signal());
  const corpus = new QuestionCorpus(config, { roomId: '100', question: '岁己和七海体检有测身高吗' }, signal(), undefined, () => encoder);
  try {
    const event = await corpus.search({ terms: ['体检'], kind: 'subtitle', date: null, query: '去体检的经历' });
    const anchor = event.hits.find(hit => hit.excerpt.includes('昨天去体检'))!;
    expect(anchor).toBeDefined();
    const result = await corpus.search({ terms: ['无字面命中'], kind: 'subtitle', date: null, query: '测量项目', withinEvidenceId: anchor.evidenceId });
    expect(result.hits.some(hit => hit.excerpt.includes('普通身高体重'))).toBe(true);
    expect(result.hits.every(hit => hit.roomId === '100' && !hit.excerpt.includes('玩笑'))).toBe(true);
    await expect(corpus.search({ ...args, withinEvidenceId: 'r200_ev999' })).rejects.toThrow('session');
    await expect(corpus.search({ ...args, withinEvidenceId: '../../private' })).rejects.toThrow();
    await expect(corpus.search({ ...args, query: 'x'.repeat(121) })).rejects.toThrow();
  } finally { await corpus.close(); }
});

it('refuses a gift catalog ID as a recording-session anchor', async () => {
  const corpus = new QuestionCorpus(config, { roomId: '100', question: '舰礼' }, signal());
  const result = await corpus.search(args);
  await expect(corpus.search({ ...args, withinEvidenceId: result.hits.find(hit => hit.kind === 'gift-catalog')!.evidenceId })).rejects.toThrow('session');
});

it('recalls an old event beyond the recent 250-file scan without a date or an embedding provider', async () => {
  const root = config.recordingRoots['100'][0];
  for (let i = 0; i < 260; i++) await fs.writeFile(path.join(root, `2026-10-07-${i}.srt`), `1\n00:00:01,000 --> 00:00:03,000\n玩笑身高一米八，第${i}段\n`);
  const old = path.join(root, '2024-01-01.srt');
  await fs.writeFile(old, '1\n00:26:48,000 --> 00:26:51,000\n昨天去体检了\n\n2\n02:21:12,000 --> 02:21:15,000\n体检是普通的身高体重项目\n');
  config.semantic = { enabled: true, backend: 'local', dimensions: 512, model: 'fixture', directory: path.join(directory, 'index'), modelDirectory: path.join(directory, 'model') };
  const encoder = { embed: async (texts: string[]) => texts.map(() => normalizedVector(Array(512).fill(1), 512)) };
  await updateSubtitleRoom(config.semantic, '100', [root], encoder, signal());
  const request = { roomId: '100', question: '上次体检有没有测身高' };
  const corpus = new QuestionCorpus(config, request, signal());
  const events = await corpus.search({ terms: ['体检'], kind: 'subtitle', date: null, query: '去体检的经历' });
  expect(events.hits[0]).toMatchObject({ date: '2024-01-01' });
  expect(corpus.coverage.get('100')?.lexicalStatus).toBe('ready');
  const details = await corpus.search({ terms: ['身高'], kind: 'subtitle', date: null, withinEvidenceId: events.hits[0].evidenceId });
  expect(details.hits[0]).toMatchObject({ date: '2024-01-01', time: '02:21:12' });
  expect(details.hits.every(hit => hit.date === '2024-01-01')).toBe(true);
  // Metadata is recall only: current source content must still match its digest before citation.
  await fs.writeFile(old, '1\n00:00:01,000 --> 00:00:03,000\n已经改成无关字幕\n');
  const next = new QuestionCorpus(config, request, signal());
  expect((await next.search({ terms: ['体检'], kind: 'subtitle', date: null })).hits).toEqual([]);
});

it('uses indexed session membership for followups even when directory enumeration is unavailable', async () => {
  const root = config.recordingRoots['100'][0], base = '2024_01_01_20_00_00_旧场';
  await fs.writeFile(path.join(root, `${base}_1_fix.srt`), '1\n00:26:48,000 --> 00:26:51,000\n昨天去检查了\n');
  await fs.writeFile(path.join(root, `${base}_3_fix.srt`), '1\n02:21:12,000 --> 02:21:15,000\n测量了身高体重\n');
  config.semantic = { enabled: true, backend: 'local', dimensions: 512, model: 'fixture', directory: path.join(directory, 'index'), modelDirectory: path.join(directory, 'model') };
  await updateSubtitleRoom(config.semantic, '100', [root], { embed: async texts => texts.map(() => normalizedVector(Array(512).fill(1), 512)) }, signal());
  const listing = jest.spyOn(require('fs/promises'), 'opendir').mockRejectedValue(new Error('directory enumeration unavailable'));
  try {
    const corpus = new QuestionCorpus(config, { roomId: '100', question: '检查时有没有测身高' }, signal());
    const event = await corpus.search({ terms: ['昨天'], kind: 'subtitle', date: null });
    expect(event.hits[0]).toMatchObject({ time: '00:26:48' });
    const detail = await corpus.search({ terms: ['身高'], kind: 'subtitle', date: null, withinEvidenceId: event.hits[0].evidenceId });
    expect(detail.hits[0]).toMatchObject({ time: '02:21:12', excerpt: '测量了身高体重' });
  } finally { listing.mockRestore(); }
});

it('allows the agent to cite catalog evidence while never exposing file/network tools', async () => {
  const request = { roomId: '200', uid: 'test', question: '小岁的舰礼是什么' };
  const corpus = new QuestionCorpus(config, request, signal());
  let turn = 0;
  const result = await runQuestionAgent(request, signal(), corpus, async input => {
    if (++turn === 1) return { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_recordings', arguments: JSON.stringify(args) } }] };
    const evidence = JSON.parse(input.messages.filter(message => message.role === 'tool').at(-1)!.content!).untrustedRecordingEvidence;
    const id = evidence.hits[0].evidenceId;
    return { content: JSON.stringify({ action: 'answer', rankedEvidenceIds: [id], certainty: 'supported', answer: '岁己提督礼物是方形抱枕，总督礼单未收录。', shortAnswer: '岁己提督礼物是方形抱枕。', evidenceIds: [id] }) };
  });
  expect(result.source).toMatchObject({ roomId: '100', kind: 'gift-catalog', catalogMonth: '2026-10' });
  expect(result.answer).toContain('方形抱枕');
});
