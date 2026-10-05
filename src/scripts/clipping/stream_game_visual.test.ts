const visual = require('./stream_game_visual');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { getGameConfig } = require('./stream_game_plan');
const { mediaSettings } = require('./stream_game_verification');

describe('independent full gameplay timeline', () => {
  test.each([
    [{}, { provider: 'daiYu', apiMode: 'openai_chat', model: 'sub-model' }],
    [{ ai: { frameModel: 'frame-model' } }, { provider: 'daiYu', apiMode: 'openai_chat', model: 'frame-model' }],
    [{ visual: { provider: 'tuZi', apiMode: 'gemini_native', model: 'explicit-visual-model' } },
      { provider: 'tuZi', apiMode: 'gemini_native', model: 'explicit-visual-model' }]
  ])('full timeline sends the resolved media route to its request adapter (%j)', async (gameSettings, expected) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-timeline-routing-'));
    try {
      const overrides = gameSettings as any;
      const root = { ai: { text: { daiYu: { textModel: 'sub-model' }, gemini: { model: 'paid-gemini' } } },
        streamGameClips: { ...overrides, ai: { timeoutMs: 1234, maxTokens: 3333, ...overrides.ai } } };
      const jpeg = await sharp({ create: { width: 480, height: 270, channels: 3, background: '#101010' } }).jpeg().toBuffer();
      const visualRequest = jest.fn(async (_prompt: string, inputs: any[], _root: any, settings: any) => {
        expect(settings).toEqual({ ...expected, timeoutMs: 600000 });
        expect(inputs.every(input => input.mimeType.startsWith('image/'))).toBe(true);
        return { text: JSON.stringify({ ranges: [{ first: 1, last: 2, kind: 'other', note: 'Talking scene' }] }) };
      });
      const plan = { source: { mediaPath: 'fixture.flv' }, duration: 1, streamerName: 'Host' };
      const extract = jest.fn(async (args: string[]) => fs.writeFileSync(args.at(-1), jpeg));
      const options = { config: root, mediaPath: 'fixture.flv', visualRequest, extract };
      const first = await visual.auditGameTimeline(plan, options, getGameConfig(root), { directory });
      expect(await visual.auditGameTimeline(plan, options, getGameConfig(root), { directory })).toEqual(first);
      expect(visualRequest).toHaveBeenCalledTimes(1);
      expect(extract).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('uncertain samples use independent local ASR by default without sending audio to the image provider', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-sample-routing-'));
    try {
      const config = getGameConfig({}), source = { mediaPath: 'original.flv' };
      const timeline = { key: 'local-audio', samples: [{ index: 1, time: 60 }],
        ranges: [{ first: 1, last: 1, kind: 'uncertain', note: 'Need original context' }] };
      const transcribe = jest.fn(async () => ({ segments: [{ start: 2, end: 5, text: '昨天已经打完了今天只讨论' }] }));
      const visualRequest = jest.fn(async (prompt: string, inputs: any[], _root: any, settings: any) => {
        expect(settings).toMatchObject({ provider: 'daiYu', apiMode: 'openai_chat' });
        expect(inputs).toHaveLength(5);
        expect(inputs.every(input => input.mimeType === 'image/jpeg')).toBe(true);
        expect(prompt).toContain('ASR and images, NOT audio');
        expect(prompt).toContain('昨天已经打完了今天只讨论');
        return { text: JSON.stringify({ kind: 'other', heardWords: '昨天已经打完了', reason: 'Discussing earlier gameplay',
          frames: inputs.map((_input, index) => ({ index: index + 1, activity: 'other', description: 'Talking avatar' })) }) };
      });
      const result = await visual.resolveUncertainSamples(timeline, { source, duration: 120, streamerName: 'Host' },
        { config: {}, mediaPath: source.mediaPath, transcribe, visualRequest,
          extract: async (args: string[]) => fs.writeFileSync(args.at(-1), Buffer.alloc(1280)) }, config,
        { directory }, mediaSettings({}, config, 'visual'), path.join(directory, 'TIMELINE.json'));
      expect(result.ranges[0].kind).toBe('other');
      expect(result.temporalReviews[0]).toMatchObject({ version: 3, evidenceMethod: 'independent_local_asr' });
      expect(transcribe).toHaveBeenCalledTimes(1);
      expect(visualRequest).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('requires complete visual coverage and an allowed game', () => {
    const games = [{ id: 'elden-ring' }];
    const ranges = [{ first: 1, last: 2, kind: 'other', note: 'avatar' },
      { first: 3, last: 4, kind: 'gameplay', gameId: 'elden-ring', note: 'live game HUD' }];
    expect(visual.parseTimeline({ text: JSON.stringify({ ranges }) }, 4, games).ranges).toHaveLength(2);
    expect(() => visual.parseTimeline({ text: JSON.stringify({ ranges }) }, 5, games)).toThrow(/every sample/);
    expect(() => visual.parseTimeline({ text: JSON.stringify({ ranges: [{ ...ranges[1], first: 1, gameId: 'another-game' }] }) }, 4, games)).toThrow();
  });
  test('temporal review retains uncertainty and cannot promote an unsupported game', () => {
    const games = [{ id: 'elden-ring' }];
    expect(visual.parseSampleReview({ text: JSON.stringify({ kind: 'uncertain', reason: 'black frames and silent audio' }) }, games))
      .toMatchObject({ kind: 'uncertain', gameId: null });
    expect(() => visual.parseSampleReview({ text: JSON.stringify({ kind: 'gameplay', gameId: 'unknown', reason: 'HUD' }) }, games)).toThrow();
    const evidence = { heardWords: '我量一下给你看', frames: Array.from({ length: 5 }, (_, i) => ({ index: i + 1,
      activity: i ? 'black' : 'other', description: i ? 'black screen' : 'talking avatar with a desk' })) };
    expect(visual.parseSampleReview({ text: JSON.stringify({ ...evidence, kind: 'other', gameId: 'elden-ring', reason: 'host discussing hardware' }) }, games).gameId).toBeNull();
    expect(() => visual.parseSampleReview({ text: JSON.stringify({ ...evidence, kind: 'gameplay', gameId: 'elden-ring', reason: 'guessed HUD' }) }, games)).toThrow(/actual frame/);
  });
  test('menus remain in one full session and nearby audio launch points are retained', () => {
    const plan = { events: [{ id: 'game-1', gameId: 'elden-ring', start: 150, end: 730, startObserved: true, endObserved: true,
      chapters: [], excludedRanges: [], evidenceIds: ['T1'], windows: [1] }] };
    const samples = Array.from({ length: 10 }, (_, i) => ({ time: i * 120 }));
    const timeline = { key: 'x', samples, ranges: [{ first: 1, last: 4, kind: 'other' },
      { first: 5, last: 5, kind: 'gameplay', gameId: 'elden-ring', note: 'game HUD' },
      { first: 6, last: 7, kind: 'gameplay', gameId: 'elden-ring', note: 'inventory and gameplay' },
      { first: 8, last: 10, kind: 'other' }] };
    expect(visual.reconcileTimeline(plan, timeline)).toHaveLength(1);
    expect(visual.reconcileTimeline(plan, timeline)[0]).toMatchObject({ start: 150, end: 730 });
  });
  test('a long capture setup retains the detected launch for independent boundary review', () => {
    const plan = { events: [{ id: 'game-1', gameId: 'elden-ring', start: 100, end: 1500, startObserved: true, endObserved: true,
      chapters: [], excludedRanges: [], evidenceIds: ['T1'], windows: [1] }] };
    const samples = Array.from({ length: 15 }, (_, i) => ({ time: i * 120 }));
    const timeline = { key: 'setup', samples, ranges: [{ first: 1, last: 10, kind: 'other' },
      { first: 11, last: 13, kind: 'gameplay', gameId: 'elden-ring', note: 'live game after capture setup' },
      { first: 14, last: 15, kind: 'other' }] };
    expect(visual.reconcileTimeline(plan, timeline)[0]).toMatchObject({ start: 100, end: 1500 });
  });
  test('sparse visual classification cannot discard a text-observed game ending', () => {
    const plan = { events: [{ id: 'game-1', gameId: 'elden-ring', start: 100, end: 1500, startObserved: true, endObserved: true,
      chapters: [], excludedRanges: [], evidenceIds: ['T1'], windows: [1] }] };
    const samples = Array.from({ length: 15 }, (_, i) => ({ time: i * 120 }));
    const timeline = { key: 'ending', samples, ranges: [{ first: 1, last: 2, kind: 'other' },
      { first: 3, last: 10, kind: 'gameplay', gameId: 'elden-ring', note: 'live game' },
      { first: 11, last: 15, kind: 'other' }] };
    expect(visual.reconcileTimeline(plan, timeline)[0]).toMatchObject({ start: 100, end: 1500 });
    const uncertainMerged = { ...plan, events: [{ ...plan.events[0], end: 1680, endObserved: false }],
      rawEvents: [plan.events[0], { ...plan.events[0], start: 1440, end: 1680, startObserved: false, endObserved: false }] };
    expect(visual.reconcileTimeline(uncertainMerged, timeline)[0]).toMatchObject({ start: 100, end: 1500 });
  });
});
