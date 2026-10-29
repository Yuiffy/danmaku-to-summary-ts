import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { QuestionRuntime } from '../live-vote/questions/EvidenceQuery';
import { updateRecordingFts } from '../live-vote/questions/RecordingFtsMaintenance';
import { createQQKnowledge, QQQuestionTools } from './QQKnowledge';
import { QQRequest } from './QQPolicy';
import { createQQAnswerer } from './QQAgent';
import { createQQImageTools } from './QQImageTools';

let directory: string, runtime: QuestionRuntime;
const request: QQRequest = { key: 'receipt', user: 'hashed-user', scope: 'group', targetId: 'group', msgId: 'msg',
  text: '来点七海情报', createdAt: Date.parse('2026-10-28T12:00:00+08:00') };
const config = { runtimeConfigPath: 'unused', roomId: '100', collaborationRooms: ['300'] };
const signal = () => new AbortController().signal;
const execute = (session: QQQuestionTools, name: string, args: unknown) => session.tools.find(tool => tool.name === name)!.execute(args) as Promise<any>;
const listing = { collection: 'recordings', kind: 'all', date: null, offset: 0, limit: 12, preview: 'head', cuesPerRecording: 2 };

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-knowledge-'));
  runtime = { questions: { enabled: true, providerConfigPath: path.join(directory, 'unused.json'),
    lexical: { enabled: true, directory: path.join(directory, 'fts') }, recordingRoots: {}, roomAliases: { '200': ['海子姐', 'Nana7mi'] } } };
  for (const [id, name] of [['100', '岁己SUI'], ['200', '七海Nana7mi'], ['300', '弥月Mizuki'], ['400', '礼墨Sumi']]) {
    const root = path.join(directory, `${id}_${name}`); await fs.mkdir(root); runtime.questions.recordingRoots[id] = [root];
    await fs.writeFile(path.join(root, '2026-10-27.srt'), `1\n00:00:01,000 --> 00:00:02,000\n${name}谈到咖喱饭\n`);
    await fs.writeFile(path.join(root, '2026-10-27.xml'), `<i><d p="3,1,25,0,0,0,123,0">${name}观众说咖喱饭</d></i>`);
    expect(await updateRecordingFts(runtime.questions.lexical!, id, [root], signal(), undefined, undefined, Date.now() + 60000))
      .toMatchObject({ updated: 2, complete: true });
  }
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

test.each(['来点七海情报', '七海nana7mi情报', '海子姐最近聊了什么', 'Nana7mi 情报'])(
  'configured-room mode routes %s to the broadcaster ASR and danmaku, without the default room', async text => {
    const session = createQQKnowledge(runtime, { ...config, allConfiguredRooms: true })({ ...request, text }, signal());
    try {
      expect(session.scope).toContain('七海Nana7mi'); expect(session.scope).not.toContain('岁己SUI');
      const result = await execute(session, 'search_recordings', { terms: ['咖喱饭'], kind: 'all', date: null });
      expect(new Set(result.hits.map((hit: any) => hit.roomId))).toEqual(new Set(['200']));
      expect(new Set(result.hits.map((hit: any) => hit.kind))).toEqual(new Set(['subtitle', 'danmaku']));
      expect(result.coverage).toEqual([expect.objectContaining({ roomId: '200', lexicalStatus: 'ready' })]);
      const context = await execute(session, 'read_context', { evidenceId: result.hits[0].evidenceId });
      expect(context.hit.roomId).toBe('200');
      await expect(execute(session, 'search_recordings', { terms: ['咖喱饭'], kind: 'all', date: null, roomId: '100' })).rejects.toThrow();
    } finally { await session.close(); }
  });

test('missing generated overviews still permit reading this broadcaster subtitles and audience messages', async () => {
  const session = createQQKnowledge(runtime, { ...config, allConfiguredRooms: true })(request, signal());
  try {
    const overview = await execute(session, 'read_live_overview', { date: null });
    expect(overview.overviews).toEqual([expect.objectContaining({ roomId: '200', artifacts: [] })]);
    const listed = await execute(session, 'list_recordings', listing);
    expect(listed.recordings).toHaveLength(2);
    expect(listed.recordings.every((entry: any) => entry.roomId === '200')).toBe(true);
    const read = await execute(session, 'read_recordings', { recordingIds: listed.recordings.map((entry: any) => entry.recordingId),
      startSeconds: 0, endSeconds: null, offset: 0, limitPerRecording: 4 });
    expect(JSON.stringify(read)).toContain('咖喱饭');
    expect(new Set(read.recordings.map((entry: any) => entry.kind))).toEqual(new Set(['subtitle', 'danmaku']));
  } finally { await session.close(); }
});

test('historical topics remain searchable after a recent overview and listing, with dated source context', async () => {
  const root = runtime.questions.recordingRoots['100'][0];
  await fs.writeFile(path.join(root, '2024-08-30.srt'), '1\n00:00:01,000 --> 00:00:02,000\n今天继续玩泰坦陨落2\n');
  await updateRecordingFts(runtime.questions.lexical!, '100', [root], signal(), undefined, undefined, Date.now() + 60000);
  const session = createQQKnowledge(runtime, config)({ ...request, text: '岁己上次玩泰坦陨落2是什么时候' }, signal());
  try {
    await execute(session, 'read_live_overview', { date: null });
    await execute(session, 'list_recordings', { ...listing, date: '2026-10-27' });
    const found = await execute(session, 'search_recordings', { terms: ['泰坦陨落'], kind: 'subtitle', date: null,
      query: null, withinEvidenceId: null, collection: 'recordings' });
    expect(found.hits).toEqual([expect.objectContaining({ date: '2024-08-30', roomId: '100', excerpt: '今天继续玩泰坦陨落2' })]);
    const context = await execute(session, 'read_context', { evidenceId: found.hits[0].evidenceId });
    expect(context.hit).toMatchObject({ date: '2024-08-30', roomId: '100', kind: 'subtitle' });
    expect(context.context.some((cue: any) => cue.text.includes('继续玩泰坦陨落2'))).toBe(true);
  } finally { await session.close(); }
});

test('legacy scope remains opt-in, default questions stay local, and QQ comparisons allow more than three rooms', async () => {
  const legacy = createQQKnowledge(runtime, config)(request, signal());
  expect(legacy.scope).toContain('岁己SUI'); expect(legacy.scope).not.toContain('七海Nana7mi'); await legacy.close();
  const knowledge = createQQKnowledge(runtime, { ...config, allConfiguredRooms: true });
  const local = knowledge({ ...request, text: '今天播了什么' }, signal());
  expect(local.scope).toContain('岁己SUI'); expect(local.scope).not.toContain('七海Nana7mi'); await local.close();
  const comparison = knowledge({ ...request, text: '岁己、七海和弥月最近都聊什么' }, signal());
  try {
    const result = await execute(comparison, 'search_recordings', { terms: ['咖喱饭'], kind: 'all', date: null });
    expect(new Set(result.hits.map((hit: any) => hit.roomId))).toEqual(new Set(['100', '200', '300']));
  } finally { await comparison.close(); }
  const four = knowledge({ ...request, text: '岁己、七海、弥月、礼墨的情报' }, signal());
  try {
    const result = await execute(four, 'search_recordings', { terms: ['咖喱饭'], kind: 'all', date: null });
    expect(new Set(result.hits.map((hit: any) => hit.roomId))).toEqual(new Set(['100', '200', '300', '400']));
  } finally { await four.close(); }
  expect(() => createQQKnowledge(runtime, { ...config, roomId: '999', allConfiguredRooms: true })).toThrow();
});

test('QQ permits eight configured rooms and rejects an excess only when a recording tool is selected', async () => {
  const extra = ['额外甲', '额外乙', '额外丙', '额外丁', '额外戊'];
  for (const [index, name] of extra.entries()) {
    const id = String(500 + index * 100), root = path.join(directory, `${id}_${name}`);
    await fs.mkdir(root); runtime.questions.recordingRoots[id] = [root];
  }
  const knowledge = createQQKnowledge(runtime, { ...config, allConfiguredRooms: true });
  const names = ['岁己', '七海', '弥月', '礼墨', ...extra];
  const eight = knowledge({ ...request, text: names.slice(0, 8).join('和') + '最近聊什么' }, signal());
  try {
    const result = await execute(eight, 'search_recordings', { terms: ['咖喱饭'], kind: 'all', date: null });
    expect(result.coverage).toHaveLength(8);
  } finally { await eight.close(); }
  const excess = knowledge({ ...request, text: names.join('和') + '最近聊什么' }, signal());
  expect(excess.scope).toContain('最多8位主播');
  await expect(execute(excess, 'search_recordings', { terms: ['咖喱饭'], kind: 'all', date: null })).rejects.toThrow('At most 8');
  await excess.close();
});

test('a multi-character drawing is not blocked by the unrelated recording room limit', async () => {
  const question = { ...request, text: '生成岁己七海弥月礼墨在健身房锻炼的图' };
  const knowledge = createQQKnowledge(runtime, { ...config, allConfiguredRooms: true });
  const render = jest.fn(async () => ({ status: 'generated' as const, message: '图片生成完成。' }));
  const load = jest.fn();
  const response = (message: unknown, finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message, finish_reason }] }) });
  const transport = jest.fn().mockResolvedValueOnce(response({ tool_calls: [{ id: 'draw', type: 'function',
    function: { name: 'generate_image', arguments: JSON.stringify({ mode: 'create', instruction: question.text, characters: [] }) } }] }, 'tool_calls'))
    .mockResolvedValueOnce(response({ content: JSON.stringify({ answer: '图片生成完成。', basis: 'general', evidenceIds: [] }) }));
  const images = createQQImageTools(question, { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high', dailyLimit: 300,
    userDailyLimit: 30, timeoutMs: 180000, characters: [] }, load, render);
  expect(await createQQAnswerer({ url: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'fake-key' },
    knowledge, transport as any, undefined, images)(question, signal())).toBe('图片生成完成。');
  expect(render).toHaveBeenCalledTimes(1); expect(load).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(2);
});
