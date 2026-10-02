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
