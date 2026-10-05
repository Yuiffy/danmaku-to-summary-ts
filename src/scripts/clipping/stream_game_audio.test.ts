const fs = require('fs');
const os = require('os');
const path = require('path');
const audioReview = require('./stream_game_audio');
const { extractEvidence } = require('./stream_game_evidence');
const { parseBoundaryExcerpt } = require('./stream_game_verification');

describe('independent local game boundary audio', () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-local-audio-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
  const source = { mediaPath: 'original.flv', mediaBytes: '2000', mediaMtimeNs: '42' };
  async function excerpt(start = 100, end = 130) {
    const span = { start, end, path: path.join(directory, 'audio.mp3'), mimeType: 'audio/mpeg' };
    await extractEvidence(async (args: string[]) => fs.writeFileSync(args.at(-1), Buffer.alloc(1280, 1)),
      ['-y', '-ss', String(start), '-i', source.mediaPath, '-t', String(end-start), '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'libmp3lame', '-b:a', '64k', span.path], { sourceIdentity: source });
    return span;
  }
  const decode = jest.fn(async () => ({ segments: [{ start: 2, end: 4, text: '准备启动游戏了' },
    { start: 15, end: 17, text: '我的艾尔登法环' }] }));
  const value = () => ({ text: JSON.stringify({ decision: 'keep', reason: 'Independent transcription establishes launch preparation',
    observed: true, boundaryAnchor: 'before_phrase', heardWords: '准备启动游戏了', seconds: 20, quoteSeconds: 20 }) });
  const rows = [{ source: 'audio_transcript', start: 102, end: 104, text: '准备启动游戏了' }];
  async function request(span: any, transcribe = decode) {
    return audioReview.requestLocalBoundary({ audio: span, frames: [], kind: 'start', source, root: {}, settings: {},
      gameName: '艾尔登法环', host: '岁己', transcribe, request: jest.fn(async (prompt: string, inputs: any[]) => {
        expect(inputs.every(i => i.mimeType.startsWith('image/'))).toBe(true);
        expect(prompt).toContain('NOT audio');
        expect(prompt).toContain('FIRST actual launch/preparation');
        expect(prompt).toContain('准备启动游戏了');
        return value();
      }) });
  }
  test('new audio decoding and source timestamps both bind the phrase, never the model clock', async () => {
    const span = await excerpt(), response = await request(span);
    const result = audioReview.bindIndependentBoundary(response, span, 'start', rows, source, parseBoundaryExcerpt);
    expect(result).toMatchObject({ seconds: 2, quoteSource: { start: 102, end: 104 },
      independentlyTranscribedQuote: { contextIndex: 0, quoteSource: { start: 102, end: 104 } } });
    expect(result.localAudioEvidence.primary).toMatchObject({ method: 'independent_local_asr', audioPath: span.path });
    const again = jest.fn(decode);
    await audioReview.transcribeOriginalAudio(span, {}, source, { transcribe: again });
    expect(again).not.toHaveBeenCalled();
  });
  test('editing audio, ASR, or changing the original recording invalidates cached evidence', async () => {
    const span = await excerpt(), response = await request(span), primary = response.meta.localAudioEvidence.primary;
    fs.appendFileSync(primary.asrPath, ' ');
    expect(() => audioReview.bindIndependentBoundary(response, span, 'start', rows, source, parseBoundaryExcerpt)).toThrow(/evidence changed/);
    expect(() => audioReview.checkAudioReceipt(span, { ...source, mediaMtimeNs: '99' })).toThrow(/not bound/);
    fs.appendFileSync(span.path, 'changed sound');
    expect(() => audioReview.checkAudioReceipt(span, source)).toThrow(/not bound/);
  });
  test('source-only phrases and disagreeing audio offsets cannot pass', async () => {
    const span = await excerpt();
    const response = await request(span, jest.fn(async () => ({ segments: [{ start: 20, end: 22, text: '准备启动游戏了' }] })));
    expect(() => audioReview.bindIndependentBoundary(response, span, 'start', rows, source, parseBoundaryExcerpt)).toThrow(/disagree/);
    const absent = await audioReview.transcribeOriginalAudio(span, { asr: { paraformer: { model: 'another-model' } } }, source,
      { transcribe: jest.fn(async () => ({ segments: [{ start: 2, end: 4, text: '今天不玩游戏了' }] })) });
    const missing = { ...value(), meta: { localAudioEvidence: { version: 1, method: 'independent_local_asr', primary: absent, retranscriptions: [] } } };
    expect(() => audioReview.bindIndependentBoundary(missing, span, 'start', rows, source, parseBoundaryExcerpt)).toThrow(/absent or ambiguous/);
    expect(() => audioReview.bindIndependentBoundary(value(), span, 'start', rows, source, parseBoundaryExcerpt)).toThrow(/missing its actual/);
  });
  test('invalid local timing and audio from a different window are rejected', async () => {
    expect(() => audioReview.transcriptRows({ segments: [{ start: 2, end: 80, text: 'phrase' }] }, 30)).toThrow(/invalid timing/);
    const span = await excerpt(), response = await request(span);
    expect(() => audioReview.bindIndependentBoundary(response, { ...span, start: 101 }, 'start', rows, source, parseBoundaryExcerpt)).toThrow(/missing its actual/);
  });
  test('targeted launch decoding keeps acoustic small-group timing and preserves its coarse evidence', async () => {
    const span = await excerpt(), coarse = await audioReview.transcribeOriginalAudio(span, {}, source, { transcribe: decode });
    const coarseBytes = fs.readFileSync(coarse.asrPath);
    const fineDecode = jest.fn(async (_audio: string, config: any) => {
      expect(config.asr.paraformer.max_subtitle_chars).toBe(1);
      expect(config.asr.paraformer.enable_speaker).toBe(false);
      expect(config.asr.corrections).toEqual({});
      return { segments: [{ start: 2, end: 4, text: '准备启动游戏了' }] };
    });
    const fine = await audioReview.transcribeOriginalAudio(span, {}, source, { transcribe: fineDecode, preciseTiming: true });
    expect(fine.asrPath).not.toBe(coarse.asrPath);
    expect(fs.readFileSync(coarse.asrPath)).toEqual(coarseBytes);
    expect(audioReview.readOriginalTranscript(coarse, source)[0].start).toBe(102);
    expect(audioReview.readOriginalTranscript(fine, source)[0].start).toBe(102);
  });
  test.each([
    ['nearby reviewed transition', 118, 'other', 1],
    ['sparse images', 141, 'other', 0],
    ['watching gameplay', 118, 'watching_game', 0],
    ['unreviewed image', 118, undefined, 0]
  ])('generic transition speech only receives finer decoding at a %s', async (_label, gameTime, priorActivity, expected) => {
    const span = await excerpt(100, 160), extract = jest.fn(async (args: string[]) => {
      fs.writeFileSync(args.at(-1), Buffer.alloc(1280, 2));
    });
    const transcribe = jest.fn(async (_file: string, config: any) => ({ segments: config.asr.paraformer.max_subtitle_chars === 1
      ? [{ start: 5, end: 10, text: '嗯嗯嗯我走了' }]
      : [{ start: 2, end: 4, text: '等一下我来了' }, { start: 15, end: 20, text: '嗯嗯嗯我走了' }] }));
    const response = await audioReview.requestLocalBoundary({ audio: span,
      frames: [{ index: 2, time: gameTime }, { index: 1, time: 110 }],
      frameObservations: [{ index: 1, activity: priorActivity }, { index: 2, activity: 'gameplay' }],
      kind: 'start', source, root: {}, settings: {}, gameName: '艾尔登法环', host: '岁己', transcribe, extract,
      request: jest.fn(async (prompt: string) => {
        expect(prompt).toContain('alone do not establish game launch');
        return { text: JSON.stringify({ decision: 'uncertain', reason: 'Transition meaning remains ambiguous' }) };
      }) });
    expect(extract).toHaveBeenCalledTimes(expected as number);
    expect(transcribe).toHaveBeenCalledTimes(1 + (expected as number));
    expect(response.meta.localAudioEvidence.retranscriptions).toHaveLength(expected as number);
    expect(JSON.parse(response.text).decision).toBe('uncertain');
    if (expected) expect(response.meta.localAudioEvidence.retranscriptions[0]).toMatchObject({ start: 110, end: 125 });
  });
  test('humming before a launch cannot choose the cut when an acoustic small-group decode isolates the words', async () => {
    const span = await excerpt(100, 135);
    const response = await request(span, jest.fn(async () => ({ segments: [
      { start: 2, end: 22, text: '谢礼物嗯嗯啦啦准备启动游戏了' }
    ] })));
    const narrow = { start: 110, end: 130, path: path.join(directory, 'fine.mp3'), mimeType: 'audio/mpeg' };
    await extractEvidence(async (args: string[]) => fs.writeFileSync(args.at(-1), Buffer.alloc(1280, 2)),
      ['-y', '-ss', '110', '-i', source.mediaPath, '-t', '20', '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'libmp3lame', '-b:a', '64k', narrow.path], { sourceIdentity: source });
    response.meta.localAudioEvidence.retranscriptions.push(await audioReview.transcribeOriginalAudio(narrow, {}, source,
      { preciseTiming: true, transcribe: jest.fn(async () => ({ segments: [
        { start: 1, end: 9, text: '嗯嗯啦啦' }, { start: 10, end: 10.4, text: '准备' },
        { start: 10.4, end: 11, text: '启动' }, { start: 11, end: 11.8, text: '游戏' }, { start: 11.8, end: 12, text: '了' }
      ] })) }));
    const result = audioReview.bindIndependentBoundary(response, span, 'start', [
      { source: 'audio_transcript', start: 120, end: 122, text: '准备启动游戏了' }
    ], source, parseBoundaryExcerpt);
    expect(result.seconds).toBe(20);
    expect(result.independentlyTranscribedQuote).toEqual({ contextIndex: 1, quoteSource: { start: 120, end: 122 },
      resolvedCoarseQuotes: [{ contextIndex: 0, quoteSource: { start: 102, end: 122 } }] });
  });
  test('split and merged source sentences require the same complete independently decoded words and clock', async () => {
    const span = await excerpt();
    const merged = [{ source: 'audio_transcript', start: 102, end: 109, text: '我还知道呢准备启动游戏了' }];
    const response = await request(span, jest.fn(async () => ({ segments: [
      { start: 2, end: 5.2, text: '我还知道呢' }, { start: 5.21, end: 9, text: '准备启动游戏了' }
    ] })));
    const bound = audioReview.bindIndependentBoundary(response, span, 'start', merged, source, parseBoundaryExcerpt);
    expect(bound.seconds).toBe(2);
    expect(bound.independentlyTranscribedQuote).toEqual({ contextIndex: 0, quoteSource: { start: 105.21, end: 109 },
      alignedSourceContext: { mode: 'whole_cues', words: '我还知道呢准备启动游戏了', quoteSource: { start: 102, end: 109 } } });
    expect(() => audioReview.bindIndependentBoundary(response, span, 'start',
      [{ ...merged[0], text: '没有听到的句子准备启动游戏了' }], source, parseBoundaryExcerpt)).toThrow(/disagree/);
    expect(() => audioReview.bindIndependentBoundary(response, span, 'start',
      [{ ...merged[0], start: 109, end: 116 }], source, parseBoundaryExcerpt)).toThrow(/disagree/);
  });
  test('a literal cue prefix resolves different filler segmentation only immediately before the actual launch', async () => {
    const span = await excerpt();
    const merged = [{ source: 'audio_transcript', start: 102, end: 109, text: '我还知道呢准备启动游戏了' }];
    const response = await request(span, jest.fn(async () => ({ segments: [
      { start: 2, end: 5.2, text: '我还知道呢嗯嗯' }, { start: 5.21, end: 9, text: '准备启动游戏了' }
    ] })));
    expect(audioReview.bindIndependentBoundary(response, span, 'start', merged, source, parseBoundaryExcerpt)
      .independentlyTranscribedQuote.alignedSourceContext).toEqual({ mode: 'leading_cue_prefix', words: '我还知道呢',
        quoteSource: { start: 102, end: 105.2 } });
    const separatedSpan = await excerpt(100, 135);
    const separated = await request(separatedSpan, jest.fn(async () => ({ segments: [
      { start: 2, end: 3, text: '我还知道呢嗯嗯' }, { start: 7, end: 9, text: '准备启动游戏了' }
    ] })));
    expect(() => audioReview.bindIndependentBoundary(separated, separatedSpan, 'start', merged, source, parseBoundaryExcerpt)).toThrow(/disagree/);
  });
  test.each([22, 4])('a finer independent excerpt resolves a coarse sentence only within its actual speech range (%s)', async (coarseEnd) => {
    const span = await excerpt(100, 135);
    const response = await request(span, jest.fn(async () => ({ segments: [
      { start: 2, end: coarseEnd, text: '谢礼物准备启动游戏了' }
    ] })));
    const narrow = { start: 115, end: 130, path: path.join(directory, 'narrow.mp3'), mimeType: 'audio/mpeg' };
    await extractEvidence(async (args: string[]) => fs.writeFileSync(args.at(-1), Buffer.alloc(1280, 2)),
      ['-y', '-ss', '115', '-i', source.mediaPath, '-t', '15', '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'libmp3lame', '-b:a', '64k', narrow.path], { sourceIdentity: source });
    response.meta.localAudioEvidence.retranscriptions.push(await audioReview.transcribeOriginalAudio(narrow, {}, source,
      { transcribe: jest.fn(async () => ({ segments: [{ start: 5, end: 7, text: '准备启动游戏了' }] })) }));
    const actualRows = [{ source: 'audio_transcript', start: 120, end: 122, text: '准备启动游戏了' }];
    if (coarseEnd === 4) expect(() => audioReview.bindIndependentBoundary(response, span, 'start', actualRows, source, parseBoundaryExcerpt)).toThrow(/disagree/);
    else {
      const result = audioReview.bindIndependentBoundary(response, span, 'start', actualRows, source, parseBoundaryExcerpt);
      expect(result.seconds).toBe(20);
      expect(result.independentlyTranscribedQuote).toEqual({ contextIndex: 1, quoteSource: { start: 120, end: 122 },
        resolvedCoarseQuotes: [{ contextIndex: 0, quoteSource: { start: 102, end: 122 } }] });
    }
  });
  test('complete non-playing audits cannot manufacture speech or omit original frame observations', async () => {
    const span = await excerpt(), primary = await audioReview.transcribeOriginalAudio(span, {}, source,
      { transcribe: jest.fn(async () => ({ segments: [{ start: 2, end: 5, text: '昨天已经打完了今天只讨论' }] })) });
    const frames = [{ index: 1, time: 108 }];
    const row = { decision: 'exclude', activity: 'discussion', reason: 'Retrospective speech on a talking scene',
      quotes: ['昨天已经打完了'], frames: [{ index: 1, activity: 'other', description: 'Talking avatar, no game interface' }] };
    const parse = (value: any) => audioReview.parseNonPlayingReview({text:JSON.stringify(value)},frames,primary,source);
    expect(parse(row).decision).toBe('exclude');
    expect(parse({decision:'uncertain',reason:'Possible offscreen game operation'}).decision).toBe('uncertain');
    for (const changed of [{...row,quotes:['我正在启动游戏']},{...row,frames:[]},
      {...row,frames:[{...row.frames[0],activity:'gameplay'}]},{...row,decision:'keep'}]) expect(()=>parse(changed)).toThrow();
  });
  test('a non-playing quote repair must still match the independent original decode', async () => {
    const frame = { index: 2, time: 108, path: path.join(directory, 'frame.jpg') };
    fs.writeFileSync(frame.path, 'original frame');
    const row = { decision: 'exclude', activity: 'discussion', reason: 'Explicit retrospective conversation',
      quotes: ['昨天已经打完了'], frames: [{ index: 2, activity: 'other', description: 'Talking-avatar scene' }] };
    const request = jest.fn().mockResolvedValueOnce({ text: JSON.stringify({ ...row, quotes: ['正在玩法环'] }) })
      .mockResolvedValueOnce({ text: JSON.stringify(row) });
    const options = { event: { start: 110, end: 115 }, duration: 130, frames: [frame], source, directory, root: {}, settings: {},
      contextSeconds: 10, host: '岁己', gameName: '艾尔登法环', request,
      extract: async (args: string[]) => fs.writeFileSync(args.at(-1), Buffer.alloc(1280, 1)),
      transcribe: jest.fn(async () => ({ segments: [{ start: 2, end: 5, text: '昨天已经打完了今天只讨论' }] })) };
    expect((await audioReview.reviewNonPlayingCandidate(options)).decision).toBe('exclude');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toContain('Keep uncertain');
    request.mockReset().mockResolvedValue({ text: JSON.stringify({ ...row, quotes: ['正在玩法环'] }) });
    await expect(audioReview.reviewNonPlayingCandidate(options)).rejects.toThrow(/quote is absent/);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
