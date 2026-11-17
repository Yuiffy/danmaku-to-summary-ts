import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RecordingEvidence, parseRecordingSearch } from './RecordingEvidence';
import { AgentCompletionRequest, QuestionAgentStep, runQuestionAgent } from './QuestionAgent';
import { createFtsSearch } from './RecordingFtsIndex';
import { updateRecordingFts } from './RecordingFtsMaintenance';

let root: string;
const signal = () => new AbortController().signal;
const cue = (text: string, time = '00:01:00') => `1\n${time},000 --> ${time},900\n${text}\n\n`;
const focused = { terms: ['出门'], titleTerms: ['新衣'], kind: 'subtitle', date: null };
const latest = (input: AgentCompletionRequest) => JSON.parse(input.messages.filter(message =>
  message.role === 'tool' || message.role === 'user' && message.content?.includes('untrustedRecordingEvidence')).at(-1)!.content!).untrustedRecordingEvidence;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-title-'));
  await fs.writeFile(path.join(root, '2026_09_12_19_53_23_地雷装新衣发布回.srt'),
    cue('其实这个老同学我一开始是找') + cue('是找小迷鹿的结果小迷出门了', '02:26:24') + cue('我就说那找c几录吧', '02:26:27'));
  await fs.writeFile(path.join(root, '2026_10_01_20_00_00_聊天.srt'), cue('新衣回出门录语音，这只是另一场聊天'));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('filters titles before scanning and requires body evidence even when ASR omits the event and names', async () => {
  const evidence = new RecordingEvidence([root], signal());
  const result = await evidence.search(focused);
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]).toMatchObject({ date: '2026-09-12', time: '02:26:24', excerpt: '是找小迷鹿的结果小迷出门了' });
  expect(result.hits[0].context).toEqual(expect.arrayContaining([expect.objectContaining({ text: '我就说那找c几录吧' })]));
  expect((await evidence.search({ ...focused, terms: ['新衣'] })).hits).toEqual([]);
  expect((await evidence.search({ ...focused, date: '2026-10' })).hits).toEqual([]);
  expect((await evidence.search({ ...focused, titleTerms: null })).hits).toHaveLength(2);
});

it('applies the same source filter to FTS recall and still rejects stale source hashes', async () => {
  for (let i = 0; i < 40; i++) await fs.writeFile(path.join(root, `2026-10-02-chat-${i}.srt`), cue('出门'));
  const lexical = { enabled: true, directory: path.join(root, 'index') };
  expect(await updateRecordingFts(lexical, '100', [root], signal(), undefined, undefined, Date.now() + 60000))
    .toMatchObject({ updated: 42, complete: true });
  const evidence = new RecordingEvidence([root], signal(), { ftsSearch: createFtsSearch(lexical, '100', [root], signal()) });
  expect((await evidence.search(focused)).hits).toEqual([expect.objectContaining({ date: '2026-09-12', time: '02:26:24' })]);
  await fs.writeFile(path.join(root, '2026_09_12_19_53_23_地雷装新衣发布回.srt'), cue('修正以后没有相关原文'));
  const changed = new RecordingEvidence([root], signal(), { ftsSearch: createFtsSearch(lexical, '100', [root], signal()) });
  expect(await changed.search(focused)).toMatchObject({ hits: [], limited: true });
});

it('accepts an insufficient verdict after an actual title search without repeating it', async () => {
  const evidence = new RecordingEvidence([root], signal());
  let turns = 0;
  const result = await runQuestionAgent({ roomId: '100', uid: '1', question: '新衣回有没有提到大象？' }, signal(), evidence, async () => {
    turns++;
    if (turns === 1) return { content: null, tool_calls: [{ id: 'title', type: 'function', function: {
      name: 'search_recordings', arguments: JSON.stringify({ ...focused, terms: ['大象'] }) } }] };
    return { content: JSON.stringify({ action: 'insufficient', rankedEvidenceIds: [] }) };
  });
  expect(result.source).toBeUndefined();
  expect(turns).toBe(2);
});

it('rejects unbounded title filters and filters on the basename rather than a directory name', async () => {
  for (const titleTerms of [[], [''], ['a'.repeat(41)], ['a', 'b', 'c', 'd'], ['新衣\n'], 42]) {
    expect(() => parseRecordingSearch({ ...focused, titleTerms })).toThrow();
  }
  expect((await new RecordingEvidence([root], signal()).search({ ...focused, titleTerms: [path.basename(root)] })).hits).toEqual([]);
});

it('preserves incomplete title enumeration even when the index reports complete coverage', async () => {
  const evidence = new RecordingEvidence([root, path.join(root, 'offline')], signal(), {
    ftsSearch: async () => ({ available: true, complete: true, indexedFiles: 2, matches: [] })
  });
  expect(await evidence.search(focused)).toMatchObject({ limited: true });
});

it('recalls an isolated action cue when title words and repeated song-recording chatter crowd out indexed chunks', async () => {
  for (let day = 13; day <= 15; day++) await fs.writeFile(path.join(root, `2026-09-${day}-新衣活动.srt`),
    Array.from({ length: 4 }, (_, i) => cue(`声音有点小${day}-${i}`, `00:${String(i * 2).padStart(2, '0')}:00`)).join(''));
  const file = path.join(root, '2026_09_12_19_53_23_地雷装新衣发布回.srt');
  let content = Array.from({ length: 8 }, (_, i) => cue('新衣服好看吗', `00:${String(i * 2).padStart(2, '0')}:00`)).join('');
  content += cue('看一下聊天记录', '00:42:00') + cue('王府回忆录', '00:47:00');
  content += cue('其实这个老同学我一开始是找', '02:26:19') + cue('是找小迷鹿的结果小迷出门了', '02:26:24') + cue('我就说那找c几录吧', '02:26:27');
  content += Array.from({ length: 8 }, (_, i) => cue('录歌录完了录得太快，不停的录', `02:${String(30 + i * 2).padStart(2, '0')}:00`)).join('');
  await fs.writeFile(file, content);
  const lexical = { enabled: true, directory: path.join(root, 'index') };
  await updateRecordingFts(lexical, '100', [root], signal(), undefined, undefined, Date.now() + 60000);
  const evidence = new RecordingEvidence([root], signal(), { ftsSearch: createFtsSearch(lexical, '100', [root], signal()) });
  const result = await evidence.search({ ...focused, terms: ['新衣', '录', '声音'] });
  expect(result.hits.flatMap(hit => hit.context).map(line => line.text)).toContain('是找小迷鹿的结果小迷出门了');
});

it('replans an insufficient event lookup into a title-scoped search before giving up', async () => {
  const evidence = new RecordingEvidence([root], signal()), steps: QuestionAgentStep[] = [];
  let turns = 0;
  const result = await runQuestionAgent({ roomId: '100', uid: '1', question: '新衣回为什么临时换人？' }, signal(), evidence, async input => {
    turns++;
    if (turns === 1) return { content: null, tool_calls: [{ id: 'first', type: 'function', function: {
      name: 'search_recordings', arguments: JSON.stringify({ terms: ['录语音'], kind: 'subtitle', date: null }) } }] };
    if (turns === 2) return { content: JSON.stringify({ action: 'insufficient', rankedEvidenceIds: [] }) };
    if (turns === 3) {
      expect(input.toolChoice).toBe('required');
      expect(input.messages.at(-1)?.content).toContain('titleTerms');
      return { content: null, tool_calls: [{ id: 'focused', type: 'function', function: {
        name: 'search_recordings', arguments: JSON.stringify(focused) } }] };
    }
    const hit = latest(input).hits[0];
    return { content: JSON.stringify({ action: 'answer', certainty: 'supported', rankedEvidenceIds: [hit.evidenceId], evidenceIds: [hit.evidenceId],
      answer: '是，原本想找的同事出门了，才换人录制；昵称字幕存在识别误差。', shortAnswer: '是，原定同事出门了才换人录。' }) };
  }, step => steps.push(step));
  expect(result.answer).toContain('原本想找的同事出门了');
  expect(result.source).toMatchObject({ date: '2026-09-12', time: '02:26:24' });
  expect(steps).toContainEqual(expect.objectContaining({ validationIssue: 'event_search_needs_title_scope' }));
  expect(turns).toBe(4);
});

it.each(['insufficient', 'uncertain'] as const)('keeps the event scope and splits compound action terms after an %s recording answer', async verdict => {
  if (verdict === 'uncertain') await fs.writeFile(path.join(root, '2026_09_15_20_00_00_新衣后闲聊.srt'), cue('来个录语音版本好吗'));
  const evidence = new RecordingEvidence([root], signal()), steps: QuestionAgentStep[] = [];
  let turns = 0;
  const result = await runQuestionAgent({ roomId: '100', uid: '1', question: '新衣回叫人录语音，为什么不叫别人？' }, signal(), evidence, async input => {
    turns++;
    if (turns === 1) return { content: null, tool_calls: [{ id: 'compound', type: 'function', function: {
      name: 'search_recordings', arguments: JSON.stringify({ ...focused, terms: ['录语音', '配音'] }) } }] };
    if (turns === 2) {
      if (verdict === 'insufficient') return { content: JSON.stringify({ action: 'insufficient', rankedEvidenceIds: [] }) };
      const wrongHit = latest(input).hits[0];
      return { content: JSON.stringify({ action: 'answer', certainty: 'uncertain', rankedEvidenceIds: [wrongHit.evidenceId],
        evidenceIds: [wrongHit.evidenceId], answer: '只提到录语音，为什么换人暂无法确认。', shortAnswer: '原因暂无法确认。' }) };
    }
    const hits = latest(input).hits;
    const hit = hits.find((candidate: { excerpt: string }) => candidate.excerpt.includes('c几录'));
    expect(hit.context).toContainEqual(expect.objectContaining({ text: '是找小迷鹿的结果小迷出门了' }));
    return { content: JSON.stringify({ action: 'answer', certainty: 'supported', rankedEvidenceIds: [hit.evidenceId], evidenceIds: [hit.evidenceId],
      answer: '原定同事出门了，所以改找另一人录制。', shortAnswer: '原定同事出门了，才换人录。' }) };
  }, step => steps.push(step));
  expect(result.answer).toContain('原定同事出门了');
  expect(steps).toContainEqual(expect.objectContaining({ validationIssue: 'event_search_needs_short_actions' }));
  expect(turns).toBe(3);
});
