import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RecordingEvidence } from './RecordingEvidence';
import { QuestionCorpus } from './QuestionCorpus';
import { aggregateEvidence } from './QuestionTools';
import { runQuestionAgent } from './QuestionAgent';
import { formatQuestionRecord, NO_EVIDENCE } from './QuestionPolicy';

let root: string;
const listing = (overrides = {}) => ({ collection: 'recordings', kind: 'subtitle', date: '2026-10', offset: 0,
  limit: 32, preview: 'head', cuesPerRecording: 8, ...overrides });
const reading = (recordingIds: string[], overrides = {}) => ({ recordingIds, startSeconds: 0, endSeconds: null, offset: 0, limitPerRecording: 10, ...overrides });
const srt = (seconds: number, text: string) => `1\n00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000 --> 00:59:59,000\n${text}\n`;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-browser-'));
  await fs.writeFile(path.join(root, '2026_10_01_20_00_00_聊天_1_fix.srt'), srt(300, '晚上好，开始聊天啦') + '\n' + srt(360, '先说说今天的游戏'));
  await fs.writeFile(path.join(root, '2026_10_01_20_00_00_聊天_2_fix.srt'), srt(10, '这是中途分段，不是开播'));
  await fs.writeFile(path.join(root, '2026_10_02_20_00_00_聊天_1_fix.srt'), srt(420, '晚上好，麦克风开了'));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('browses dated recording heads, identifies multipart sessions and preserves citations', async () => {
  const evidence = new RecordingEvidence([root], new AbortController().signal);
  const page = await evidence.list(listing());
  expect(page.total).toBe(3); expect(page.limited).toBe(false);
  const parts = page.recordings.filter(entry => entry.date === '2026-10-01');
  expect(parts.map(entry => entry.part)).toEqual([1, 2]);
  expect(parts[0].sessionId).toBe(parts[1].sessionId);
  expect(parts[0].preview.map(hit => hit.time)).toEqual(['00:05:00', '00:06:00']);
  for (const entry of page.recordings) for (const hit of entry.preview) expect(evidence.clue(hit.evidenceId)?.excerpt).toBe(hit.excerpt);
  expect(page.recordings.every(entry => entry.timeBasis === 'recording_offset')).toBe(true);
  expect(JSON.stringify(page)).not.toContain(root);
});

it('reads arbitrary time ranges and continuations using listed IDs or search evidence IDs', async () => {
  const evidence = new RecordingEvidence([root], new AbortController().signal);
  const page = await evidence.list(listing({ limit: 1, offset: 1, preview: 'none' }));
  expect(page.nextOffset).toBe(2); expect(page.limited).toBe(true);
  const id = page.recordings[0].recordingId;
  const first = await evidence.read(reading([id], { limitPerRecording: 1 }));
  expect(first.recordings[0].nextCueOffset).toBe(1);
  expect(first.limited).toBe(true);
  const second = await evidence.read(reading([id], { offset: 1 }));
  expect(second.recordings[0].preview[0].excerpt).toContain('游戏');
  const range = await evidence.read(reading([first.recordings[0].preview[0].evidenceId], { startSeconds: 301, endSeconds: 400 }));
  expect(range.recordings[0].preview.map(hit => hit.time)).toEqual(['00:06:00']);
  await expect(evidence.read(reading(['../private.srt']))).rejects.toThrow();
  await expect(evidence.read(reading(['rec999']))).rejects.toThrow();
  await expect(evidence.list({ ...listing(), path: root })).rejects.toThrow();
  await expect(evidence.read(reading(Array.from({ length: 32 }, (_, n) => `rec${n}`), { limitPerRecording: 80 }))).rejects.toThrow();
});

it('browses and searches highlights and clip SRTs while excluding unrelated folders', async () => {
  await fs.mkdir(path.join(root, '2026_10_03'));
  const day = path.join(root, '2026_10_03');
  await fs.writeFile(path.join(day, '录制-100-20261003-200000-聊天_AI_HIGHLIGHT.txt'), '【摘要】\n[1m] 歌曲\n[7m24s] 我把麦克风关了，怪不得没声音\n[20m] 继续玩游戏\n');
  await fs.mkdir(path.join(day, 'own_stream_fun_clips'));
  await fs.writeFile(path.join(day, 'own_stream_fun_clips', 'fun.srt'), srt(2, '麦克风没有开，难怪没有声音'));
  await fs.mkdir(path.join(day, 'temp'));
  await fs.writeFile(path.join(day, 'temp', 'secret.srt'), srt(1, '不能读取的麦克风秘密'));
  const evidence = new RecordingEvidence([root], new AbortController().signal);
  const highlights = await evidence.list(listing({ collection: 'highlights', preview: 'sample', cuesPerRecording: 2 }));
  expect(highlights.recordings).toHaveLength(1);
  expect(highlights.recordings[0]).toMatchObject({ kind: 'highlight', timeBasis: 'highlight_approximate' });
  expect(highlights.recordings[0].preview.map(hit => hit.time)).toEqual(['00:01:00', '00:20:00']);
  const search = await evidence.search({ collection: 'highlights', kind: 'all', date: '2026-10', terms: ['麦克风'] });
  expect(search.hits[0]).toMatchObject({ kind: 'highlight', time: '00:07:24' });
  const clips = await evidence.list(listing({ collection: 'clips' }));
  expect(clips.recordings).toHaveLength(1);
  expect(clips.recordings[0]).toMatchObject({ kind: 'clip-subtitle', timeBasis: 'clip_offset' });
  const clipSearch = await evidence.search({ collection: 'clips', kind: 'subtitle', date: '2026-10', terms: ['麦克风'] });
  expect(clipSearch.hits[0].kind).toBe('clip-subtitle');
  expect(JSON.stringify(clips)).not.toContain('秘密');
  expect(formatQuestionRecord({ request: { roomId: '100', uid: '1', question: '趣事' }, result: { answer: '片中提到没开麦', clues: [evidence.clue(clipSearch.hits[0].evidenceId)!] } })).toContain('切片字幕（切片内时间）');
});

it('qualifies listed IDs across rooms and cannot read an unseen or out-of-scope source', async () => {
  const other = path.join(root, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, '2026-10-03.srt'), srt(1, '另一房间内容'));
  const corpus = new QuestionCorpus({ enabled: true, providerConfigPath: path.join(root, 'config.json'), recordingRoots: { '100': [root], '200': [other] } },
    { roomId: '100', question: '看看开头' }, new AbortController().signal);
  const page = await corpus.list(listing());
  expect(page.recordings.every(entry => entry.recordingId.startsWith('r100_'))).toBe(true);
  const result = await corpus.read(reading([page.recordings[0].recordingId]));
  expect(result.recordings[0].preview[0].roomId).toBe('100');
  expect(corpus.citation(result.recordings[0].preview[0].evidenceId)?.roomId).toBe('100');
  await expect(corpus.read(reading(['r200_rec1']))).rejects.toThrow();
});

it('lets the agent compose browsing and arithmetic for a comparison without a task-specific tool', async () => {
  const signal = new AbortController().signal, evidence = new RecordingEvidence([root], signal);
  let calls = 0;
  const result = await runQuestionAgent({ roomId: '100', uid: '1', question: '统计十月开场等待多久' }, signal, evidence, async input => {
    if (++calls === 1) return { content: null, tool_calls: [{ id: 'browse', type: 'function', function: { name: 'list_recordings', arguments: JSON.stringify(listing()) } }] };
    const toolResult = JSON.parse(input.messages.filter(message => message.content?.includes('untrustedRecordingEvidence')).at(-1)!.content!).untrustedRecordingEvidence;
    if (calls === 2) {
      const ids = toolResult.recordings.filter((entry: { part: number }) => entry.part === 1).map((entry: { preview: Array<{ evidenceId: string }> }) => entry.preview[0].evidenceId);
      return { content: JSON.stringify({ action: 'tool', rankedEvidenceIds: ids, tool: { name: 'aggregate_evidence', arguments: { evidenceIds: ids, groupBy: 'all' } } }) };
    }
    expect(toolResult.groups[0]).toMatchObject({ count: 2, meanSeconds: 360, medianSeconds: 360, minSeconds: 300, maxSeconds: 420 });
    const ids = toolResult.groups[0].evidenceIds;
    return { content: JSON.stringify({ action: 'answer', certainty: 'supported', rankedEvidenceIds: ids, evidenceIds: ids,
      answer: '已查两段开口字幕，距录制起点平均约6分钟，范围5到7分钟；不代表整月或实际开播起点。', shortAnswer: '已查2段，均约6分钟（录制估算）' }) };
  });
  expect(result.answer).toContain('平均约6分钟'); expect(result.clues).toHaveLength(2); expect(calls).toBe(3);
  expect(() => aggregateEvidence({ evidenceIds: ['unknown'], groupBy: 'all' }, id => evidence.citation(id))).toThrow();
  const id = (await evidence.list(listing())).recordings[0].preview[0].evidenceId;
  expect(() => aggregateEvidence({ evidenceIds: [id, id], groupBy: 'all' }, key => evidence.citation(key))).toThrow();
});

it('honors cancellation and offline roots instead of claiming full coverage', async () => {
  const controller = new AbortController();
  const evidence = new RecordingEvidence([root, path.join(root, 'offline')], controller.signal);
  expect((await evidence.list(listing())).limited).toBe(true);
  controller.abort();
  await expect(evidence.list(listing())).rejects.toThrow();
});

it('links recognized archive copies by recording clock and marks sampled previews as incomplete', async () => {
  const mirror = path.join(root, 'mirror'); await fs.mkdir(mirror);
  await fs.copyFile(path.join(root, '2026_10_01_20_00_00_聊天_1_fix.srt'), path.join(mirror, '录制-100-20261001-200000-聊天.srt'));
  const day = path.join(mirror, '2026_10_01'); await fs.mkdir(day);
  await fs.rename(path.join(mirror, '录制-100-20261001-200000-聊天.srt'), path.join(day, '录制-100-20261001-200000-聊天.srt'));
  const evidence = new RecordingEvidence([root, mirror], new AbortController().signal);
  const page = await evidence.list(listing({ preview: 'sample', cuesPerRecording: 1 }));
  const copies = page.recordings.filter(entry => entry.date === '2026-10-01' && entry.part !== 2);
  expect(copies).toHaveLength(2);
  expect(copies[0].sessionId).toBe(copies[1].sessionId);
  expect(copies[0].recordingId).not.toBe(copies[1].recordingId);
  expect(copies.every(entry => entry.sampled && entry.totalCues === 2 && entry.nextCueOffset === null)).toBe(true);
  expect(page.limited).toBe(true);
});

it('reports oversized sources without reading or citing their contents', async () => {
  const large = path.join(root, '2026-10-03.srt');
  await fs.writeFile(large, srt(1, '不能作为已读取证据'));
  await fs.truncate(large, 8 * 1024 * 1024 + 1);
  const evidence = new RecordingEvidence([root], new AbortController().signal);
  const page = await evidence.list(listing({ date: '2026-10-03' }));
  expect(page.limited).toBe(true);
  expect(page.recordings[0].preview).toEqual([]);
  expect(page.recordings[0].totalCues).toBeNull();
});

it('reserves evidence capacity after a large overview so focused reading can still finish', async () => {
  const content = Array.from({ length: 80 }, (_, index) => srt(index, `字幕${index}`)).join('\n');
  for (let n = 0; n < 32; n++) await fs.writeFile(path.join(root, `2026-10-03-${n}.srt`), content);
  const evidence = new RecordingEvidence([root], new AbortController().signal);
  const page = await evidence.list(listing({ date: '2026-10-03', cuesPerRecording: 12 }));
  expect(page.recordings.flatMap(entry => entry.preview)).toHaveLength(128);
  const focused = await evidence.read(reading(page.recordings.slice(0, 4).map(entry => entry.recordingId), { limitPerRecording: 80 }));
  expect(focused.recordings.flatMap(entry => entry.preview)).toHaveLength(320);
  expect(focused.limited).toBe(false);
});

it('refines a truncated overview once before accepting an insufficient verdict', async () => {
  await fs.writeFile(path.join(root, '2026-10-03.srt'), srt(10, '歌词片段') + '\n' + srt(420, '大家晚上好，正式开始'));
  const signal = new AbortController().signal, evidence = new RecordingEvidence([root], signal);
  const observe = jest.fn(), read = jest.spyOn(evidence, 'read');
  let calls = 0;
  const result = await runQuestionAgent({ roomId: '100', uid: '1', question: '看看最新一场开头何时开始聊天' }, signal, evidence, async input => {
    if (++calls === 1) return { content: null, tool_calls: [{ id: 'head', type: 'function', function: {
      name: 'list_recordings', arguments: JSON.stringify(listing({ date: '2026-10-03', cuesPerRecording: 1 })) } }] };
    if (calls === 2) return { content: JSON.stringify({ action: 'insufficient', rankedEvidenceIds: [] }) };
    const result = JSON.parse(input.messages.filter(message => message.content?.includes('untrustedRecordingEvidence')).at(-1)!.content!).untrustedRecordingEvidence;
    const cue = result.recordings[0].preview.find((hit: { excerpt: string }) => hit.excerpt.includes('晚上好'));
    return { content: JSON.stringify({ action: 'answer', certainty: 'supported', rankedEvidenceIds: [cue.evidenceId], evidenceIds: [cue.evidenceId],
      answer: '录制第7分钟出现开场问候字幕，实际开播起点未核实。', shortAnswer: '录制第7分钟出现问候。' }) };
  }, observe);
  expect(result.source?.time).toBe('00:07:00');
  expect(read).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ readFallback: true }));
});

it('requires a fresh read when the first four recordings do not cover the requested opening samples', async () => {
  // Recent reconnection fragments and a long song intro can occupy the entire fallback batch.
  const lyrics = Array.from({ length: 81 }, (_, index) => srt(index, '歌曲片段')).join('\n');
  for (let day = 4; day <= 7; day++) await fs.writeFile(path.join(root, `2026-10-0${day}.srt`), lyrics);
  await fs.writeFile(path.join(root, '2026-10-03.srt'), lyrics + '\n' + srt(420, '大家晚上好，能听到吗'));
  const signal = new AbortController().signal, evidence = new RecordingEvidence([root], signal);
  const read = jest.spyOn(evidence, 'read'), observe = jest.fn();
  let calls = 0, candidate = '';
  const result = await runQuestionAgent({ roomId: '100', uid: '1', question: '统计近7天开场等待时长' }, signal, evidence, async input => {
    calls++;
    if (calls === 1) return { content: null, tool_calls: [{ id: 'heads', type: 'function', function: {
      name: 'list_recordings', arguments: JSON.stringify(listing({ cuesPerRecording: 1 })) } }] };
    const data = JSON.parse(input.messages.filter(message => message.content?.includes('untrustedRecordingEvidence')).at(-1)!.content!).untrustedRecordingEvidence;
    if (calls === 2) {
      candidate = data.recordings.find((entry: { date: string }) => entry.date === '2026-10-03').recordingId;
      return { content: JSON.stringify({ action: 'insufficient', rankedEvidenceIds: [] }) };
    }
    if (calls === 3) {
      expect(data.recordings).toHaveLength(4);
      expect(data.recordings.every((entry: { preview: Array<{ excerpt: string }> }) => entry.preview.every(cue => cue.excerpt === '歌曲片段'))).toBe(true);
      return { content: JSON.stringify({ action: 'insufficient', rankedEvidenceIds: [] }) };
    }
    if (calls === 4) {
      expect(input.toolChoice).toBe('required');
      expect(input.messages.at(-1)?.content).toContain('续读');
      return { content: null, tool_calls: [{ id: 'opening', type: 'function', function: {
        name: 'read_recordings', arguments: JSON.stringify(reading([candidate], { offset: 80 })) } }] };
    }
    const cue = data.recordings[0].preview.find((hit: { excerpt: string }) => hit.excerpt.includes('晚上好'));
    return { content: JSON.stringify({ action: 'answer', certainty: 'supported', rankedEvidenceIds: [cue.evidenceId], evidenceIds: [cue.evidenceId],
      answer: '只核实一个样本，录制约7分钟出现开场问候；其余场次未核实，无法统计完整7天。', shortAnswer: '已查1段约7分钟，7天统计不全。' }) };
  }, observe);
  expect(result.source?.time).toBe('00:07:00');
  expect(read).toHaveBeenCalledTimes(2);
  expect(calls).toBe(5);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ validationIssue: 'incomplete_browse_needs_refinement' }));
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ phase: 'read_recordings', browse: {
    total: 4, returned: 4, cues: 320, unfinished: 4, nextOffset: null
  } }));
});

it.each([false, true])('bounds browsing recovery and skips it when all previews have been read (truncated=%s)', async truncated => {
  const content = Array.from({ length: truncated ? 200 : 2 }, (_, index) => srt(index, '歌曲片段')).join('\n');
  await fs.writeFile(path.join(root, '2026-10-03.srt'), content);
  const signal = new AbortController().signal, evidence = new RecordingEvidence([root], signal);
  const read = jest.spyOn(evidence, 'read'), observe = jest.fn();
  let calls = 0, candidate = '';
  const result = await runQuestionAgent({ roomId: '100', uid: '1', question: '这场开头何时开始聊天' }, signal, evidence, async input => {
    if (++calls === 1) return { content: null, tool_calls: [{ id: 'heads', type: 'function', function: {
      name: 'list_recordings', arguments: JSON.stringify(listing({ date: '2026-10-03', cuesPerRecording: 1 })) } }] };
    const data = JSON.parse(input.messages.filter(message => message.content?.includes('untrustedRecordingEvidence')).at(-1)!.content!).untrustedRecordingEvidence;
    candidate ||= data.recordings[0].recordingId;
    if (calls === 4) {
      expect(input.toolChoice).toBe('required');
      return { content: null, tool_calls: [{ id: 'continue', type: 'function', function: {
        name: 'read_recordings', arguments: JSON.stringify(reading([candidate], { offset: 80 })) } }] };
    }
    return { content: JSON.stringify({ action: 'insufficient', rankedEvidenceIds: [] }) };
  }, observe);
  expect(result.answer).toBe(NO_EVIDENCE);
  expect(calls).toBe(truncated ? 5 : 3);
  expect(read).toHaveBeenCalledTimes(truncated ? 2 : 1);
  expect(observe.mock.calls.filter(([step]) => step.validationIssue === 'incomplete_browse_needs_refinement')).toHaveLength(truncated ? 1 : 0);
  expect(JSON.stringify(observe.mock.calls)).not.toContain('歌曲片段');
  expect(JSON.stringify(observe.mock.calls)).not.toContain(root);
});
