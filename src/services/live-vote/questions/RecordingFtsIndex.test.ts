import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createFtsSearch, RecordingFtsConfig } from './RecordingFtsIndex';
import { updateRecordingFts } from './RecordingFtsMaintenance';
import { queryRecordingEvidence, QuestionRuntime } from './EvidenceQuery';
import { QuestionCorpus } from './QuestionCorpus';
import { validateQuestionConfig } from './QuestionPolicy';

let directory: string, root: string, lexical: RecordingFtsConfig, runtime: QuestionRuntime;
const signal = () => new AbortController().signal;
const srt = (text: string, time = '00:00:01') => `1\n${time},000 --> ${time},500\n${text}\n`;
const sc = (user: string, start = '2026-06-17T23:00:00+08:00', seconds = 2) =>
  `<i><BililiveRecorderRecordInfo start_time="${start}"/><sc ts="${seconds}" user="${user}" uid="123">躺在床上莫名又会想</sc></i>`;
const update = (roots = [root]) => updateRecordingFts(lexical, '100', roots, signal(), undefined, undefined, Date.now() + 60000);
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-fts-')); root = path.join(directory, '100_岁己'); await fs.mkdir(root);
  lexical = { enabled: true, directory: path.join(directory, 'fts') };
  runtime = { questions: { enabled: true, providerConfigPath: path.join(directory, 'unused.json'), recordingRoots: { '100': [root] }, lexical } };
});
afterEach(async () => { jest.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

it('serves the shared skill CLI and bot corpus with Chinese short terms, filters, and verified SC identities', async () => {
  await fs.writeFile(path.join(root, '2024-09-30.srt'), srt('昨天体检，测量身高体重'));
  await fs.writeFile(path.join(root, '2026-06-17.xml'), sc('原作者'));
  await fs.writeFile(path.join(root, '2026-10-20.xml'), sc('复读', '2026-10-20T20:00:00+08:00'));
  expect(await update()).toMatchObject({ updated: 3, complete: true });
  const listing = jest.spyOn(require('fs/promises'), 'opendir').mockRejectedValue(new Error('raw scan must not run'));
  const result = await queryRecordingEvidence(runtime, { roomId: '100', question: '体检有说身高吗', terms: ['体检', '身高'], kind: 'subtitle', date: '2024', expandTop: 1 }, signal());
  expect(result).toMatchObject({ lexicalStatus: 'ready', indexComplete: true, indexedFiles: 3, embeddingStatus: 'disabled', limited: false });
  expect(result.hits[0]).toMatchObject({ date: '2024-09-30', excerpt: '昨天体检,测量身高体重', roomId: '100' });
  const corpus = new QuestionCorpus(runtime.questions, { roomId: '100', question: '躺在床上莫名又会想最早是谁发的' }, signal());
  const hit = (await corpus.search({ terms: ['躺在床上莫名又会想'], kind: 'danmaku', date: null })).hits[0];
  expect(hit).toMatchObject({ senderName: '原作者', senderUid: '123', messageType: 'superchat', sentAt: '2026-06-17T23:00:02.000+08:00' });
  expect(listing).not.toHaveBeenCalled();
});

it('incrementally imports recovery files and corrections, removes deleted files, and preserves offline roots', async () => {
  const file = path.join(root, '2026-10-01.srt'); await fs.writeFile(file, srt('旧的奶茶'));
  expect((await update()).updated).toBe(1); expect((await update()).updated).toBe(0);
  await fs.writeFile(file, srt('修正后的抱枕礼物'));
  await fs.writeFile(path.join(root, '2026-10-01-recovery.xml'), '<i><d p="1,1,25,0,0,0,1,0">补档弹幕</d></i>');
  expect((await update()).updated).toBe(2);
  const search = createFtsSearch(lexical, '100', [root], signal());
  expect((await search(null, ['奶茶'], { kind: 'all', earliest: false })).matches).toHaveLength(0);
  expect((await search(null, ['补档'], { kind: 'danmaku', earliest: false })).matches).toHaveLength(1);
  const offline = root + '-offline'; await fs.rename(root, offline);
  expect(await update()).toMatchObject({ deleted: 0, complete: false }); await fs.rename(offline, root);
  await fs.unlink(file); expect((await update()).deleted).toBe(1);
  expect((await search(null, ['抱枕'], { kind: 'all', earliest: false })).matches).toHaveLength(0);
});

it('recalls alternative phrasings even when another passage contains every search term', async () => {
  await fs.writeFile(path.join(root, '2026-03-14.srt'), srt('我天天洗澡，到现在还在坚持每天洗澡'));
  await fs.writeFile(path.join(root, '2026-08-03.srt'), srt('好像是去年的秋天开始每天洗澡', '00:57:48'));
  await update();
  const result = await queryRecordingEvidence(runtime, { roomId: '100', question: '什么时候开始每天洗澡',
    terms: ['每天洗澡', '天天洗澡'], kind: 'subtitle', date: null, expandTop: 0 }, signal());
  expect(result.hits.map(hit => hit.date)).toEqual(expect.arrayContaining(['2026-03-14', '2026-08-03']));
  expect(result.hits.find(hit => hit.date === '2026-08-03')).toMatchObject({ time: '00:57:48', excerpt: '好像是去年的秋天开始每天洗澡' });
});

it('ranks a named shop in verified subtitles ahead of short audience keyword matches', async () => {
  await fs.writeFile(path.join(root, '2026-09-01.xml'), '<i><d p="1,1,25,0,0,0,1,0">咖喱</d></i>');
  await fs.writeFile(path.join(root, '2026-10-18.srt'),
    srt('小明说想吃coco', '00:49:29') + '\n' + srt('就是那个coco咖喱一番屋', '00:49:34') +
    '\n' + srt('我和小明吃的咖喱猪排饭', '00:49:48'));
  await update();
  const result = await queryRecordingEvidence(runtime, { roomId: '100', question: '她们吃的咖喱是哪家？',
    terms: ['咖喱'], kind: 'all', date: null, expandTop: 1 }, signal());
  expect(result.hits[0]).toMatchObject({ kind: 'subtitle', date: '2026-10-18', time: '00:49:34', excerpt: '就是那个coco咖喱一番屋' });
  expect(result.hits[0].expanded).toMatchObject({ context: expect.arrayContaining([
    expect.objectContaining({ text: '我和小明吃的咖喱猪排饭' })
  ]) });
  // Audience evidence is still available and chronological queries retain their meaning.
  expect(result.hits.some(hit => hit.kind === 'danmaku')).toBe(true);
  const earliest = await queryRecordingEvidence(runtime, { roomId: '100', question: '咖喱最早出现在哪？',
    terms: ['咖喱'], kind: 'all', date: null, expandTop: 0 }, signal());
  expect(earliest.hits[0]).toMatchObject({ date: '2026-09-01', kind: 'danmaku' });
});

it('rejects stale hashes before citation and never crosses configured rooms, dates or changed roots', async () => {
  const file = path.join(root, '2024-09-30.srt'); await fs.writeFile(file, srt('体检身高')); await update();
  await fs.writeFile(file, srt('已经改成无关内容'));
  const result = await queryRecordingEvidence(runtime, { roomId: '100', question: '体检身高', terms: ['体检'], kind: 'subtitle', date: null, expandTop: 0 }, signal());
  expect(result.hits).toHaveLength(0); expect(result.limited).toBe(true);
  expect((await createFtsSearch(lexical, '200', [root], signal())(null, ['体检'], { kind: 'all', earliest: false })).available).toBe(false);
  expect((await createFtsSearch(lexical, '100', [root + '-different'], signal())(null, ['体检'], { kind: 'all', earliest: false })).available).toBe(false);
  expect((await createFtsSearch(lexical, '100', [root], signal())('2026', ['体检'], { kind: 'all', earliest: false })).matches).toHaveLength(0);
});

it('locates session followups across multipart exports and keyword anchors late within XML chunks', async () => {
  const base = path.join(root, '2024_09_30_20_00_00_体检');
  await fs.writeFile(base + '_1_fix.srt', srt('昨天去检查了'));
  await fs.writeFile(base + '_3_fix.srt', srt('说过身高体重', '02:21:12'));
  await fs.writeFile(path.join(root, '2026-10-01.xml'), '<i>' + Array.from({ length: 15 }, (_, i) =>
    `<d p="${i},1,25,0,0,0,1,0">普通弹幕${i}</d>`).join('') + '<sc ts="16" user="目标">罕见目标短语</sc></i>');
  await update();
  const corpus = new QuestionCorpus(runtime.questions, { roomId: '100', question: '体检后说什么' }, signal());
  const event = await corpus.search({ terms: ['昨天'], kind: 'subtitle', date: null });
  const followup = await corpus.search({ terms: ['身高'], kind: 'subtitle', date: null, withinEvidenceId: event.hits[0].evidenceId });
  expect(followup.hits[0]).toMatchObject({ excerpt: '说过身高体重', time: '02:21:12' });
  expect((await corpus.search({ terms: ['罕见目标'], kind: 'danmaku', date: null })).hits[0]).toMatchObject({ senderName: '目标', time: '00:00:16' });
});

it('handles phrase punctuation safely, falls back when unavailable, and honors cancellation and config bounds', async () => {
  await fs.writeFile(path.join(root, '2026-10-01.srt'), srt('体检身高')); await update();
  const search = createFtsSearch(lexical, '100', [root], signal());
  expect((await search(null, ['" OR body:*'], { kind: 'all', earliest: false })).matches).toHaveLength(0);
  const aborted = new AbortController(); aborted.abort();
  await expect(createFtsSearch(lexical, '100', [root], aborted.signal)(null, ['体检'], { kind: 'all', earliest: false })).rejects.toThrow();
  const missing = { ...runtime.questions, lexical: { ...lexical, directory: path.join(directory, 'missing') } };
  expect((await new QuestionCorpus(missing, { roomId: '100', question: '体检' }, signal()).search({ terms: ['体检'], kind: 'subtitle', date: null })).hits).toHaveLength(1);
  expect(() => validateQuestionConfig({ ...runtime.questions, lexical: { ...lexical, pollIntervalMs: 1 } })).toThrow('lexical');
});

it('rebuilds XML cue positions when bot filtering changes and chooses the actual earliest cue inside a chunk', async () => {
  const xml = '<i><BililiveRecorderRecordInfo start_time="2026-06-17T23:00:00+08:00"/>' +
    '<d p="0,1,25,0,0,0,99,0">机器人消息</d><sc ts="20" user="较晚">目标原话</sc><sc ts="10" user="最早">目标原话</sc></i>';
  await fs.writeFile(path.join(root, '2026-06-17.xml'), xml); await update();
  runtime.botUid = '99';
  expect((await createFtsSearch(lexical, '100', [root], signal(), '99')(null, ['目标原话'], { kind: 'danmaku', earliest: true })).available).toBe(false);
  expect((await updateRecordingFts(lexical, '100', [root], signal(), '99', undefined, Date.now() + 60000)).updated).toBe(1);
  const result = await queryRecordingEvidence(runtime, { roomId: '100', question: '目标原话最早是谁发的', terms: ['目标原话'], kind: 'danmaku', date: null, expandTop: 0 }, signal());
  expect(result.hits[0]).toMatchObject({ senderName: '最早', time: '00:00:10' });
});
