const verification = require('./stream_game_verification');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('original gameplay evidence review', () => {
  const event = { start: 100, end: 300 };
  const frames = [{ time: 85 }, { time: 108 }, { time: 292 }, { time: 315 }];
  const observations = (activities: string[]) => ({
    decision: 'keep', reason: 'Original audio and frames inspected', start: 100, end: 300,
    startObserved: true, endObserved: true, publicCopySupported: true,
    audioObservations: [{ index: 1, heardWords: '开始游戏' }, { index: 2, heardWords: '今天先玩到这里' }],
    frameObservations: activities.map((activity, i) => ({ index: i + 1, activity,
      description: activity === 'gameplay' ? 'character and game HUD' : 'talking avatar and merchandise poster' }))
  });
  const parse = (row: any) => verification.parseVerification({ text: JSON.stringify(row) }, event, 500, frames);

  test('chat about the game cannot approve a recording with only avatar frames', () => {
    expect(() => parse(observations(['other', 'other', 'other', 'other']))).toThrow(/no visible live gameplay/);
    expect(() => parse(observations(['watching_game', 'watching_game', 'other', 'other']))).toThrow(/no visible live gameplay/);
    expect(parse({ ...observations(['other', 'other', 'other', 'other']), decision: 'exclude' }).decision).toBe('exclude');
  });

  test('visible gameplay must occur inside the retained interval and observations cannot be omitted', () => {
    expect(() => parse(observations(['gameplay', 'other', 'other', 'gameplay']))).toThrow(/inside its boundaries/);
    expect(() => parse(observations(['gameplay', 'gameplay', 'gameplay', 'other']))).toThrow(/omit visible live gameplay/);
    expect(parse(observations(['other', 'gameplay', 'gameplay', 'other'])).decision).toBe('keep');
    const row = observations(['other', 'gameplay', 'gameplay', 'other']);
    row.frameObservations.pop();
    expect(() => parse(row)).toThrow(/every original/);
    expect(() => parse({ ...observations(['other', 'gameplay', 'gameplay', 'other']), audioObservations: [] })).toThrow(/every original/);
  });
  test('independent boundaries use local audio coordinates and quotes from the correct excerpt', () => {
    const audio = [{ start: 90, end: 130 }, { start: 280, end: 320 }];
    const rows = [{ source: 'audio_transcript', start: 100, end: 110, text: '我要打开游戏了' },
      { source: 'audio_transcript', start: 295, end: 305, text: '今天游戏先玩到这里' }];
    const row = { decision: 'keep', reason: 'heard launch and closing speech', timeBasis: 'audio_local_seconds',
      start: { audioIndex: 1, seconds: 10 }, end: { audioIndex: 2, seconds: 25 }, startObserved: true, endObserved: true,
      audioObservations: [{ index: 1, heardWords: '我要打开游戏了' }, { index: 2, heardWords: '今天游戏先玩到这里' }] };
    const parseBoundary = (value: any) => verification.parseBoundaryVerification({ text: JSON.stringify(value) }, audio, rows);
    expect(parseBoundary(row)).toMatchObject({ start: 100, end: 305 });
    expect(() => parseBoundary({ ...row, end: { audioIndex: 2, seconds: 305 } })).toThrow(/outside its original/);
    expect(() => parseBoundary({ ...row, audioObservations: [...row.audioObservations].reverse() })).toThrow(/quote does not match/);
  });
  test('long chapter reviews use bounded original frames and an independent audio request', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-boundary-review-'));
    try {
      const srtPath = path.join(directory, 'source.srt');
      fs.writeFileSync(srtPath, '1\n00:01:40,000 --> 00:01:42,000\n我要打开游戏了\n\n2\n00:08:10,000 --> 00:08:20,000\n今天游戏先玩到这里\n');
      const chapters = Array.from({ length: 12 }, (_, i) => ({ start: 110 + i * 25, title: '探索与推进',
        description: '探索游戏场景。', evidenceIds: ['T1'] }));
      const candidate = { id: 'game-1', gameId: 'elden-ring', start: 100, end: 500, chapters, evidenceIds: ['T1', 'T2'],
        visualWindow: { first: 137, last: 487 } };
      const options = { mediaPath: 'source.flv', srtPath, config: { ai: { text: { gemini: { model: 'gemini-3-flash-preview' } } } },
        extract: async (args: string[]) => fs.writeFileSync(args.at(-1), Buffer.alloc(1280)),
        verifyRequest: jest.fn(async (prompt: string, inputs: any[], _root: any, settings: any) => {
          expect(inputs.length).toBeLessThanOrEqual(8);
          expect(inputs.every(i => i.mimeType === 'image/jpeg')).toBe(true);
          expect(settings.apiMode).toBe('gemini_native');
          const frameRows = JSON.parse(prompt.match(/Images are (\[.*?\])\./s)[1]);
          const chapterRows = prompt.includes('Proposed untrusted chapter: ')
            ? [JSON.parse(prompt.match(/Proposed untrusted chapter: (\{.*?\})\. Phase /s)[1])]
            : JSON.parse(prompt.match(/listed here against its cited original text AND nearby original frames: (\[.*?\])\./s)[1]);
          return { text: JSON.stringify({ reason: 'Observed character and game HUD',
            frameObservations: frameRows.map((f: any) => ({ index: f.index,
              activity: f.recordingSeconds >= 100 && f.recordingSeconds < 500 ? 'gameplay' : 'other', description: 'Actual original frame' })),
            chapterReviews: chapterRows.map((c: any) => ({ index: c.index, supported: c.title !== 'Unsupported victory', reason: 'Source and frame checked' })) }) };
        }),
        boundaryRequest: jest.fn(async (prompt: string, inputs: any[]) => {
          expect(prompt).not.toContain('我要打开游戏了');
          expect(prompt).not.toContain('SOURCE TEXT');
          expect(inputs.filter(i => i.mimeType === 'audio/mpeg')).toHaveLength(1);
          const launch = prompt.includes('locate the start of');
          return { text: JSON.stringify({ decision: 'keep', reason: 'Heard actual launch or closing speech',
            seconds: launch ? 130 : 160, observed: true, quoteSeconds: launch ? 130 : 150,
            boundaryAnchor: launch ? 'before_phrase' : 'after_phrase',
            heardWords: launch ? '我要打开游戏了' : '今天游戏先玩到这里' }) };
        }),
        closingRequest: jest.fn(async (prompt: string) => {
          const frames = JSON.parse(prompt.match(/Images are (\[.*?\])\./s)[1]);
          return { text: JSON.stringify({ reason: 'Game image has already disappeared after closing speech',
            frames: frames.map((f: any) => ({ index: f.index, activity: 'other', description: 'Unobstructed talking scene' })) }) };
        }) };
      const plan = { source: { id: 'fixture' }, duration: 600, streamerName: 'Host' };
      const config = { ai: { timeoutMs: 1000, maxTokens: 1024 }, games: [{ id: 'elden-ring', name: '艾尔登法环' }] };
      const result = await verification.verifyGame(candidate, plan, options, config, { directory });
      expect(result).toMatchObject({ version: 3, decision: 'keep', start: 100, end: 500, boundaryReview: { decision: 'keep' } });
      expect(options.verifyRequest.mock.calls.length).toBeGreaterThan(1);
      expect(options.boundaryRequest).toHaveBeenCalledTimes(2);
      expect(options.boundaryRequest.mock.calls[0][1].some((f: any) => f.time === 137)).toBe(true);
      expect(options.boundaryRequest.mock.calls[1][1].some((f: any) => f.time === 487)).toBe(true);
      expect(new Set(result.chapterReviews.map((c: any) => c.index)).size).toBe(12);
      expect(result.endFrameReview).toMatchObject({ spokenEnd: 500, end: 500 });
      const unsupported = { ...candidate, chapters: chapters.map((c, i) => i ? c : { ...c, title: 'Unsupported victory' }) };
      const blocked = await verification.verifyGame(unsupported, plan, options, config, { directory });
      expect(blocked).toMatchObject({ version: 3, decision: 'uncertain' });
      expect(blocked.reason).toContain('Chapter 1:');
      expect(options.boundaryRequest).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  test('independently heard boundary phrases bind to unique original timestamps, never the model clock', () => {
    const span = { start: 280, end: 350 };
    const rows = [{ source: 'audio_transcript', start: 295, end: 300, text: '我关闭游戏了' },
      { source: 'audio_transcript', start: 305, end: 310, text: '再见再见' }];
    const row = { decision: 'keep', reason: 'Heard actual closing', observed: true, boundaryAnchor: 'after_phrase',
      seconds: 60, quoteSeconds: 60, heardWords: '我关闭游戏了' };
    const parse = (value: any, evidence = rows) => verification.parseBoundaryExcerpt({text:JSON.stringify(value)}, span, 'end', evidence);
    expect(parse(row)).toMatchObject({ seconds: 20, quoteSource: {start:295,end:300}, timingSource:'original_transcript_quote' });
    expect(() => parse({...row,heardWords:'别处的开局话'})).toThrow(/absent or ambiguous/);
    expect(() => parse(row,[...rows,{source:'audio_transcript',start:320,end:325,text:'我关闭游戏了'}])).toThrow(/absent or ambiguous/);
  });
  test('image service configuration does not change the independent audio service', () => {
    const root = { ai: { text: { gemini: { model: 'audio-model' }, daiYu: { baseUrl: 'http://localhost:8080' } } } };
    const config = { ai: { frameProvider: 'daiYu', frameApiMode: 'openai_chat', frameModel: 'image-model', boundaryModel: 'audio-pro' } };
    expect(verification.mediaSettings(root, config, 'frames')).toMatchObject({ provider: 'daiYu', apiMode: 'openai_chat', model: 'image-model' });
    expect(verification.mediaSettings(root, config, 'boundary')).toMatchObject({ provider: 'tuZi', apiMode: 'gemini_native', model: 'audio-pro' });
  });
});
