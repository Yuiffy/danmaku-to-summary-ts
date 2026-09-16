export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const asr = require('./asr_backends');
const { loadAsrEvidence } = require('./evidence_sidecar');
const { resolveProofreadingOptions, readSuperChats, loadProofreadingContext, proofreadSubtitleTexts,
  groupSubtitleChecks, summarizeSubtitleProofreading } = require('./subtitle_proofreading');

const enabled = { enabled: true, roomId: '25788785', contextSeconds: 20, maxContextChars: 400 };
const config = { asr: { subtitleProofreading: { enabled: true, roomIds: ['25788785'] } } };
const rows = (texts, step = 4) => texts.map((text, index) => ({ start: index * step, end: index * step + 3, text }));
const prepare = (texts, options = enabled) => proofreadSubtitleTexts(rows(texts), texts, options);

describe('room-scoped subtitle proofreading', () => {
  let directory;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-proofreading-')); });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

  test('only explicitly enabled rooms receive the profile', () => {
    expect(resolveProofreadingOptions(config, { room_id: '25788785' }).enabled).toBe(true);
    expect(resolveProofreadingOptions(config, { room_id: 'other' }).enabled).toBe(false);
    expect(resolveProofreadingOptions({}, { roomId: '25788785' }).enabled).toBe(false);
    expect(prepare(['我这个兜豆呀'], { ...enabled, enabled: false }).texts).toEqual(['我这个兜豆呀']);
    expect(prepare(['我这个兜豆呀'], { ...enabled, roomId: 'other' }).texts).toEqual(['我这个兜豆呀']);
  });

  test.each([
    [['我这个兜豆呀'], ['我了个豆豆呀']],
    [['这种嘎了个game呀'], ['这种galgame呀']],
    [['二游角色', '打了game可能是不是会喜欢温柔的大姐姐'], ['二游角色', 'galgame可能是不是会喜欢温柔的大姐姐']],
    [['打开workbody要一分钟'], ['打开WorkBuddy要一分钟']],
    [['机械盘太满', '我的衣盆爆满了', '就是我的机械盆'], ['机械盘太满', '我的E盘爆满了', '就是我的机械盘']],
    [['我e盘没红啊', '我一盘玫红就是我刚开资', '软件都在机械盘'], ['我e盘没红啊', '我E盘没红就是我刚开机', '软件都在机械盘']],
    [['刷首页看封面', '你看我刷手眼'], ['刷首页看封面', '你看我刷首页']],
    [['正常情况应该秒出', '这叫秒夫吗'], ['正常情况应该秒出', '这叫秒出吗']],
    [['以前mixup的时候', '看看雪莉还要跟冰冰百灵报备', '刷到冰冰月灵灵的切片'], ['以前mixup的时候', '栞栞Shiori还要跟病院坂Rei报备', '刷到病院坂Rei的切片']],
    [['跟看看小妮远的要死', '太远了'], ['跟栞栞Shiori远的要死', '太远了']],
    [['cos小猫猫', '我的下一套衣服比较大众审美'], ['cos小猫帽', '我的下一套衣服比较大众审美']],
    [['平安岁我跟你说'], ['饼干岁我跟你说']]
  ])('applies a curated literal rule only with its required local support: %j', (input, expected) => {
    const result = prepare(input);
    expect(result.texts).toEqual(expected);
    expect(result.edits.length).toBeGreaterThan(0);
    expect(result.edits.every(edit => edit.method === 'curated_context')).toBe(true);
  });

  test.each([
    '给我家猫小猫猫买下一套衣服',
    '小猫猫在睡觉',
    '大人们在讨论二游角色',
    '妈妈下班了，爸爸也来了',
    '升级电脑后安装galgame',
    '吃小菜，饼干岁也来一碟',
    '小蔡是我的同事，发了朋友圈',
    '刚打了game，现在要休息',
    '一盘玫红颜料',
    '我e盘没红，桌上我一盘玫红颜料',
    '这个电脑控制的机械盆用于浇水',
    '二游让我熬夜，昨天打了game可能没睡好',
    '我跟你说，祝你平安岁，年年如此',
    '刚开资发工资',
    '看看雪莉，她不是栞栞，是另一位雪莉',
    '打开myworkbodyhelper',
    '打开workbody_plugin',
    'fizzy fuzzy dizzy',
    '祝大家平安岁岁，我跟你说',
    '这个场景没有报备，而不是有报备',
    '他只花了一百六十八，不是一百八十六'
  ])('does not globally rewrite ambiguous words or larger terms: %s', text => {
    expect(prepare([text]).texts).toEqual([text]);
  });

  test('context is temporal, not a whole-recording bag of words', () => {
    const segments = [{ start: 0, end: 3, text: '我跟你说' }, { start: 300, end: 303, text: '祝大家平安岁' }];
    expect(proofreadSubtitleTexts(segments, segments.map(row => row.text), enabled).texts[1]).toBe('祝大家平安岁');
  });

  test('does not infer unlisted transcript corrections from a nearby SC', () => {
    const input = ['收到一个问题', '你应该不要参加这个活动', '我再看一看'];
    const options = { ...enabled, superchat: { messages: [{ id: 'SC1', time: 0, text: '你应该参加这个活动' }] } };
    expect(prepare(input, options).texts).toEqual(input);
  });

  test('requires strong unchanged anchors and a unique prior SC for known aliases', () => {
    const input = ['等一下刚刚佳佳在做什么呢', '那会儿你卡了都没听到'];
    const options = { ...enabled, superchat: { sha256: 'xml-hash', messages: [
      { id: 'SC1', time: 0, text: '等一下等一下刚刚嘉嘉在做什么呢那会儿你卡了都没听到' }
    ] } };
    const result = prepare(input, options);
    expect(result.texts[0]).toBe('等一下刚刚嘉嘉在做什么呢');
    expect(result.edits[0]).toMatchObject({ method: 'superchat_anchors', evidence: { id: 'SC1', xmlSha256: 'xml-hash' } });
    expect(prepare(['佳佳在做什么'], options).texts[0]).toBe('佳佳在做什么');
    expect(prepare(input, { ...options, superchat: { messages: [...options.superchat.messages, ...options.superchat.messages] } }).texts).toEqual(input);
    expect(prepare(input, { ...options, superchat: { messages: [options.superchat.messages[0],
      { id: 'SC2', time: 0, text: options.superchat.messages[0].text.replace('嘉嘉', '佳佳') }] } }).texts).toEqual(input);
    expect(prepare(input, { ...options, superchat: { messages: [{ ...options.superchat.messages[0], time: 1 }] } }).texts).toEqual(input);
    expect(prepare(input, { ...options, superchat: { messages: [{ ...options.superchat.messages[0], time: -100 }] } }).texts).toEqual(input);
  });

  test('preserves the SC joke instead of converting several responses to a hundred', () => {
    const input = ['一呼百应的感觉', '小孙一呼己应的问题不大'];
    const options = { ...enabled, superchat: { messages: [{ id: 'SC1', time: 0,
      text: '确实是一呼百应的感觉小岁一呼几应的问题不大' }] } };
    const result = prepare(input, options);
    // Neither rule may bootstrap its anchors from the other rule's correction.
    expect(result.texts).toEqual(input);
    expect(groupSubtitleChecks(result.checks)[0]).toMatchObject({ type: 'superchat_reading',
      reference: '确实是一呼百应的感觉小岁一呼几应的问题不大' });
    const oneError = prepare(['一呼百应的感觉', '小岁一呼己应的问题不大'], options);
    expect(oneError.texts[1]).toBe('小岁一呼几应的问题不大');
  });

  test('SC loading is separate from D IDs, bounded, and fail-open on missing/corrupt XML', async () => {
    const file = path.join(directory, 'source.xml');
    expect((await readSuperChats(file)).status).toBe('missing');
    fs.writeFileSync(file, '<i><d p="1,0,0,0,0,0,42">hello</d><sc ts="2" user="User">嘉嘉在做什么？</sc><sc ts="bad">invalid</sc></i>');
    const read = await readSuperChats(file);
    expect(read.messages).toEqual([{ id: 'SC1', time: 2, text: '嘉嘉在做什么？' }]);
    expect(read.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await loadProofreadingContext(config, { roomId: '25788785', xmlPath: file })).superchat.status).toBe('available');
    expect((await require('../own_stream_clipper').parseDanmakuXml(file))).toEqual([{ time: 1, text: 'hello', uid: '42' }]);
    fs.writeFileSync(file, '<i><sc>');
    expect((await readSuperChats(file)).status).toBe('invalid');
  });

  test('groups many foreign-output flags and repeated ambiguous terms without deleting speech', () => {
    const input = ['onepersonandsavinganentireworld', 'anotherenglishsentencewithoutspaces', '这个quizy', '还是quizy', '打开WorkBuddy'];
    const prepared = prepare(input);
    expect(prepared.texts).toEqual(input);
    const groups = groupSubtitleChecks(prepared.checks);
    expect(groups).toHaveLength(2);
    expect(groups[0].occurrences).toHaveLength(2);
    expect(groups[1]).toMatchObject({ original: 'quizy', suggestion: 'crazy' });
    expect(groups[1].occurrences).toHaveLength(2);
    expect(groups.every(group => group.windows.every(span => span.start >= 0 && span.end - span.start <= 30))).toBe(true);
    expect(prepare(['https://example.com/longlatinidentifierexample']).checks).toHaveLength(0);
  });

  test('audio-check windows retain all occurrences without exceeding thirty seconds or clip bounds', () => {
    const grouped = groupSubtitleChecks([
      { type: 'possible_foreign_audio', start: 2, end: 70, text: 'foreign speech', cue: 1 },
      { type: 'possible_foreign_audio', start: 72, end: 75, text: 'more speech', cue: 2 }
    ], { start: 5, end: 74 });
    expect(grouped[0].occurrences).toHaveLength(2);
    expect(grouped[0].windows[0].start).toBe(5);
    expect(grouped[0].windows.at(-1).end).toBe(74);
    expect(grouped[0].windows.every(span => span.start >= 5 && span.end <= 74 && span.end - span.start <= 30)).toBe(true);
  });

  test('plain and speaker SRTs share text, preserve raw ASR and do not change times or speakers', () => {
    const file = path.join(directory, 'source.srt');
    const source = [{ start: 1.125, end: 4.5, text: '打开workbody', raw_text: '打开workbody', speaker: 'Host' }];
    const result = asr.normalizeAsrResult({ backend: 'fixture', segments: source });
    const options = { write_evidence: true, proofreading: enabled, strip_punctuation: true, max_chars_per_line: 18 };
    asr.writeSrt(result, file, options);
    const speakerFile = asr.writeSpeakerReviewSrt(result, file, options);
    const parsed = asr.parseSrt(file).segments;
    expect(parsed[0]).toMatchObject({ start: 1.125, end: 4.5, text: '打开WorkBuddy' });
    expect(fs.readFileSync(speakerFile, 'utf8')).toContain('WorkBuddy');
    expect(source[0].text).toBe('打开workbody');
    const linked = loadAsrEvidence(file, parsed);
    expect(linked.status).toBe('available');
    expect(linked.segments[0].asrEvidence).toMatchObject({ recognizedText: '打开workbody', correctedText: '打开WorkBuddy',
      sourceSpan: { rawText: '打开workbody' }, proofreading: { edits: [{ from: 'workbody', to: 'WorkBuddy' }] } });
    const summary = summarizeSubtitleProofreading(linked.segments, { start: 1, end: 5 });
    expect(summary.automaticEdits).toHaveLength(1);
    expect(summary.advisory).toBe(true);
    expect(summarizeSubtitleProofreading(linked.segments, { start: 5, end: 9 }).automaticEdits).toHaveLength(0);
  });

  test('preflight sees automatic normalization as provenance, not a user-verified edit', () => {
    const { buildPreflightEvidence, buildPreflightInput, buildPreflightPrompt } = require('../clipping/preflight_evidence');
    const evidence = buildPreflightEvidence([{ start: 0, end: 5, text: '打开WorkBuddy',
      asrEvidence: { recognizedText: '打开workbody', proofreading: { edits: [{ from: 'workbody', to: 'WorkBuddy', method: 'curated_context' }] } } }]);
    const group = { index: 'E1', start: 0, end: 5, matchSegments: [], cues: evidence.cues };
    const input = buildPreflightInput(group, evidence, { keywords: ['Host'], minClipSeconds: 1, maxClipSeconds: 10 });
    expect(input.subtitles[0].automaticNormalizations[0].method).toBe('curated_context');
    expect(input.verifiedEdits).toBeUndefined();
    expect(buildPreflightPrompt(input)).toContain('not human transcripts or speaker identity proof');
  });

  test('disabled proofreading leaves SRT bytes exactly as before, including user revision writes', () => {
    const result = { segments: rows(['打开workbody', '我这个兜豆呀']) };
    const first = path.join(directory, 'first.srt');
    const second = path.join(directory, 'second.srt');
    asr.writeSrt(result, first, { corrections: { enabled: false } });
    asr.writeSrt(result, second, { corrections: { enabled: false }, proofreading: { ...enabled, enabled: false } });
    expect(fs.readFileSync(second)).toEqual(fs.readFileSync(first));
  });
});
