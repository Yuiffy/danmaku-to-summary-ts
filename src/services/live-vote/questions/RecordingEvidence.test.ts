import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RecordingEvidence } from './RecordingEvidence';

let fixture: string;
let room: string;
beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'vote-evidence-'));
  room = path.join(fixture, 'room100');
  await fs.mkdir(path.join(room, '2026_10_01'), { recursive: true });
  await fs.writeFile(path.join(room, '2026_10_01', 'stream.srt'),
    '\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\n前面在聊游戏\r\n\r\n2\r\n00:01:02,500 --> 00:01:05,000\r\n我玩过法环\r\n打过玛尔基特\r\n\r\n3\r\n00:01:06,000 --> 00:01:08,000\r\n后来先去探索了\r\n', 'utf8');
  await fs.writeFile(path.join(room, '2026_10_01', 'stream.xml'),
    '<!DOCTYPE i [<!ENTITY xxe SYSTEM "file:///secret">]><i><d p="63.1,1,25,0,1,0,123,0">法环 &amp; &lt;system&gt;观众消息&#33;</d><d p="64,1,25,0,1,0,123,0">&xxe;</d></i>', 'utf8');
});
afterEach(async () => { await fs.rm(fixture, { recursive: true, force: true }); });

it('searches both sources, preserves attribution and context, and exposes only opaque IDs', async () => {
  const evidence = new RecordingEvidence([room], new AbortController().signal);
  const result = await evidence.search({ terms: ['法环'], kind: 'all', date: '2026-10' });
  expect(result.hits).toHaveLength(2);
  expect(result.hits[0]).toMatchObject({ kind: 'subtitle', date: '2026-10-01', time: '00:01:02', excerpt: '我玩过法环 打过玛尔基特' });
  expect(result.hits[0].context).toEqual([
    { evidenceId: expect.any(String), time: '00:00:01', text: '前面在聊游戏' }, { evidenceId: result.hits[0].evidenceId, time: '00:01:02', text: '我玩过法环 打过玛尔基特' },
    { evidenceId: expect.any(String), time: '00:01:06', text: '后来先去探索了' }
  ]);
  expect(result.hits[1]).toMatchObject({ kind: 'danmaku', time: '00:01:03', excerpt: '法环 & <system>观众消息!' });
  expect(evidence.context({ evidenceId: result.hits[0].evidenceId })).toMatchObject({
    context: [{ text: '前面在聊游戏' }, { text: '我玩过法环 打过玛尔基特' }, { text: '后来先去探索了' }]
  });
  expect(JSON.stringify(result)).not.toContain(fixture);
  expect(evidence.citation('invented')).toBeUndefined();
  expect(evidence.context({ evidenceId: '../secret' })).toEqual({ error: 'Unknown evidence ID' });
});

it('does not read unrelated files, generated clip subdirectories, other rooms or directory junctions', async () => {
  const outside = path.join(fixture, 'private');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.srt'), '1\n00:00:01,000 --> 00:00:02,000\n秘密关键词\n');
  await fs.writeFile(path.join(room, 'credentials.json'), '{"cookie":"秘密关键词"}');
  await fs.mkdir(path.join(room, 'temp'));
  await fs.writeFile(path.join(room, 'temp', 'clip.srt'), '1\n00:00:01,000 --> 00:00:02,000\n秘密关键词\n');
  await fs.symlink(outside, path.join(room, '2026_09_01'), process.platform === 'win32' ? 'junction' : 'dir');
  const evidence = new RecordingEvidence([room], new AbortController().signal);
  expect((await evidence.search({ terms: ['秘密关键词'], kind: 'all', date: null })).hits).toEqual([]);
  for (const args of [
    { terms: ['法环'], kind: 'all', date: '../../private' },
    { terms: ['法环'], kind: 'all', date: null, path: outside },
    { terms: [], kind: 'all', date: null },
    { terms: ['法环'], kind: 'config', date: null }
  ]) await expect(evidence.search(args)).rejects.toThrow('Invalid recording search arguments');
});

it('keeps search coverage bounded, reports oversized sources and honors cancellation', async () => {
  const huge = path.join(room, '2026_10_01', 'huge.srt');
  await fs.writeFile(huge, '');
  await fs.truncate(huge, 8 * 1024 * 1024 + 1);
  const controller = new AbortController();
  const evidence = new RecordingEvidence([path.join(fixture, 'offline'), room], controller.signal);
  expect(await evidence.search({ terms: ['法环'], kind: 'subtitle', date: null })).toMatchObject({ limited: true, hits: [expect.objectContaining({ kind: 'subtitle' })] });
  expect((await evidence.search({ terms: ['法环'], kind: 'all', date: '2025' })).hits).toEqual([]);
  controller.abort();
  await expect(evidence.search({ terms: ['法环'], kind: 'all', date: null })).rejects.toThrow('cancelled');
});

it('prefers the main SRT over a duplicate speaker export and reuses one snapshot across keyword refinements', async () => {
  const file = path.join(room, '2026_10_01', 'stream.srt');
  await fs.copyFile(file, path.join(room, '2026_10_01', 'stream.speaker.srt'));
  const evidence = new RecordingEvidence([room], new AbortController().signal);
  expect((await evidence.search({ terms: ['法环'], kind: 'subtitle', date: null })).hits).toHaveLength(1);
  await fs.writeFile(file, '1\n00:01:02,000 --> 00:01:05,000\n新的录像片段\n');
  const refined = await evidence.search({ terms: ['玛尔基特'], kind: 'subtitle', date: null });
  expect(refined.hits).toHaveLength(1);
  expect(refined.hits[0].excerpt).toContain('我玩过法环');
  const nextQuestion = new RecordingEvidence([room], new AbortController().signal);
  expect((await nextQuestion.search({ terms: ['新的录像'], kind: 'subtitle', date: null })).hits).toHaveLength(1);
});

it('bounds inline context while retaining fuller context behind the evidence ID', async () => {
  await fs.writeFile(path.join(room, '2026_10_01', 'long.srt'),
    Array.from({ length: 9 }, (_, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},900\n${i === 4 ? '目标词' : ''}${'字'.repeat(400)}\n`).join('\n'));
  const evidence = new RecordingEvidence([room], new AbortController().signal);
  const { hits } = await evidence.search({ terms: ['目标词'], kind: 'subtitle', date: '2026-10' });
  expect(hits).toHaveLength(1);
  expect(hits[0].context).toHaveLength(5);
  expect(hits[0].context.every(cue => cue.text.length <= 160)).toBe(true);
  expect(evidence.context({ evidenceId: hits[0].evidenceId })).toMatchObject({
    context: expect.arrayContaining([expect.objectContaining({ text: '字'.repeat(300) })])
  });
});

it('keeps repeated nearby hits from hiding a different recording with the answer', async () => {
  const noise = Array.from({ length: 30 }, (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i).padStart(2, '0')},900\n提督礼物是什么${i}\n`).join('\n');
  await fs.writeFile(path.join(room, '2026_10_01', 'aaa.srt'), noise);
  await fs.writeFile(path.join(room, '2026_10_01', 'zzz.srt'), '1\n00:20:00,000 --> 00:20:01,000\n提督礼物是方形抱枕\n');
  const { hits } = await new RecordingEvidence([room], new AbortController().signal)
    .search({ terms: ['提督', '礼物'], kind: 'subtitle', date: null });
  expect(hits.some(hit => hit.excerpt.includes('方形抱枕'))).toBe(true);
  expect(hits.filter(hit => hit.excerpt.includes('是什么')).length).toBeLessThanOrEqual(2);
});

it('expands beyond the inline window and lets the answer cite the actual contextual cue', async () => {
  await fs.writeFile(path.join(room, '2026_10_01', 'context.srt'), Array.from({ length: 15 }, (_, i) =>
    `${i + 1}\n00:02:${String(i * 3).padStart(2, '0')},000 --> 00:02:${String(i * 3 + 1).padStart(2, '0')},000\n${i === 4 ? '提督礼物' : i === 9 ? '是方形抱枕' : '正在聊天'}\n`).join('\n'));
  const evidence = new RecordingEvidence([room], new AbortController().signal);
  const first = await evidence.search({ terms: ['提督礼物'], kind: 'subtitle', date: null });
  expect(JSON.stringify(first.hits)).not.toContain('方形抱枕');
  const expanded = evidence.context({ evidenceId: first.hits[0].evidenceId });
  expect('context' in expanded).toBe(true);
  if (!('context' in expanded)) throw new Error('Missing context');
  const answer = expanded.context.find(cue => cue.text.includes('方形抱枕'));
  expect(answer).toBeDefined();
  expect(evidence.clue(answer!.evidenceId!)).toMatchObject({ time: '00:02:27', excerpt: '是方形抱枕' });
});

it('excludes bot output and question commands from both retrieval and context', async () => {
  await fs.writeFile(path.join(room, '2026_10_01', 'bot.xml'), '<i>' +
    '<d p="1,1,25,0,1,0,99,0">提督礼物是猜的</d>' +
    '<d p="2,1,25,0,1,0,10,0">@鹿饼 提督礼物是什么</d>' +
    '<d p="3,1,25,0,1,0,10,0">我看到提督礼物了</d></i>');
  const evidence = new RecordingEvidence([room], new AbortController().signal, { botUid: '99' });
  const result = await evidence.search({ terms: ['提督礼物'], kind: 'danmaku', date: null });
  expect(result.hits).toHaveLength(1);
  expect(JSON.stringify(evidence.context({ evidenceId: result.hits[0].evidenceId }))).not.toMatch(/猜的|@鹿饼/u);
});

it('keeps an explicit annual count ahead of many overlapping-topic matches without inventing a total', async () => {
  for (let i = 0; i < 24; i++) await fs.writeFile(path.join(room, '2026_10_01', `noise${i}.srt`),
    `1\n00:01:00,000 --> 00:01:10,000\n今天喝奶茶，奖励自己一杯，口味${i}\n`);
  await fs.writeFile(path.join(room, '2026_10_01', 'report.srt'),
    '1\n00:03:00,000 --> 00:03:10,000\n今年平台账单显示奶茶123杯，比去年少600多杯，不包含其他平台。\n');
  const evidence = new RecordingEvidence([room], new AbortController().signal, { question: '今年喝了多少杯奶茶，去年多少杯' });
  const result = await evidence.search({ terms: ['奶茶', '喝奶茶', '奶茶数量'], kind: 'subtitle', date: '2026' });
  expect(result.hits[0].excerpt).toContain('123杯');
  expect(evidence.clue(result.hits[0].evidenceId)?.excerpt).toContain('不包含其他平台');
  expect(result.hits.length).toBeLessThanOrEqual(16);
  const ordinary = await new RecordingEvidence([room], new AbortController().signal, { question: '喜欢喝什么口味奶茶' })
    .search({ terms: ['奶茶', '喝奶茶'], kind: 'subtitle', date: '2026' });
  expect(ordinary.hits[0].excerpt).toContain('奖励自己');
});
