const closing = require('./stream_game_closing');
const fs = require('fs'), path = require('path'), os = require('os');

describe('silent game exit handling', () => {
  test.each([[100.079, 160.08], [13634.079, 13694.08], [100.08, 160.079]])(
    'fractional closing endpoints retain continuous original-frame coverage (%s to %s)', async (spokenEnd, scanEnd) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-closing-fractional-'));
      try {
        const result = await closing.verifyClosingFrames({ spokenEnd, scanEnd, gameName: 'Game', host: 'Host',
          source: { mediaPath: 'original.flv', mediaBytes: '100', mediaMtimeNs: '1' }, mediaPath: 'original.flv', directory,
          root: {}, settings: {}, extract: async (args: string[]) => fs.writeFileSync(args.at(-1), Buffer.alloc(1280)),
          request: async (_prompt: string, inputs: any[]) => ({ text: JSON.stringify({ reason: 'Exit menu gives way to a clear talking scene',
            frames: inputs.map(i => ({ index: i.index, activity: i.time < spokenEnd + 16.5 ? 'game' : 'other',
              description: 'Actual original menu or talking scene' })) }) }) });
        expect(result.end).toBeCloseTo(spokenEnd + 16.5, 6);
        expect(result.samples.at(-1).time).toBe(scanEnd);
        expect(result.samples.every((sample: any, i: number) => !i || sample.time - result.samples[i - 1].time <= 2.001)).toBe(true);
        expect(closing.validateClosingReview(result, result.end)).toBe(result.end);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
  test('the spoken exit must retain later menus and fades, with a confirmed transition', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-closing-'));
    try {
      const request = jest.fn(async (prompt: string, inputs: any[]) => {
        expect(inputs.length).toBeLessThanOrEqual(8);
        expect(inputs.every(i => i.mimeType === 'image/jpeg')).toBe(true);
        return { text: JSON.stringify({ reason: 'Exit-confirmation menu and publisher fade disappear at 106.5',
          frames: inputs.map(i => ({ index: i.index, activity: i.time < 106.5 ? 'game' : 'other',
            description: i.time < 106.5 ? 'Live exit-confirmation menu or fading publisher logo' : 'Unobstructed talking scene' })) }) };
      });
      const result = await closing.verifyClosingFrames({ spokenEnd: 100, scanEnd: 112, gameName: 'Game', host: 'Host',
        source: { mediaPath: 'original.flv', mediaBytes: '100', mediaMtimeNs: '1' }, mediaPath: 'original.flv', directory,
        root: {}, settings: { provider: 'image-service', model: 'image-model' }, request,
        extract: async (args: string[]) => fs.writeFileSync(args.at(-1), Buffer.alloc(1280)) });
      expect(result).toMatchObject({ spokenEnd: 100, end: 106.5 });
      expect(closing.validateClosingReview(result, 106.5)).toBe(106.5);
      expect(() => closing.validateClosingReview(result, 100)).toThrow(/differs from original/);
      expect(result.samples.some((f: any) => f.time === 106.25)).toBe(true);
      expect(result.frames.at(-1).activity).toBe('other');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  test('a continuing game, unreadable frame or missing coverage cannot establish an exit', () => {
    const review = (activities: string[]) => ({ spokenEnd: 100, scanEnd: 108,
      samples: activities.map((_, i) => ({ time: 100 + i * 2 })),
      frames: activities.map((activity, i) => ({ index: i + 1, activity, description: 'Actual scene' })) });
    expect(() => closing.closingBoundary(review(['game', 'game', 'game', 'game', 'game']))).toThrow(/remains visible/);
    expect(() => closing.closingBoundary(review(['game', 'uncertain', 'other', 'other', 'other']))).toThrow(/remain uncertain/);
    expect(() => closing.closingBoundary(review(['game', 'other', 'other']))).toThrow(/coverage is incomplete/);
    expect(closing.closingBoundary(review(['other', 'other', 'other', 'other', 'other']))).toBe(100);
    expect(closing.closingBoundary(review(['uncertain', 'game', 'other', 'other', 'other']))).toBe(104);
    expect(() => closing.closingBoundary(review(['other', 'uncertain', 'other', 'other', 'other']))).toThrow(/remain uncertain/);
    expect(() => closing.closingBoundary(review(['game', 'other', 'other', 'game', 'other']))).toThrow(/remains visible/);
  });
  test.each([false, true])('rechecks a dark exit frame at original resolution and retains unresolved ambiguity (%s)', async (remainsUncertain) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-closing-context-'));
    try {
      const mediaPath = path.join(directory, 'original.flv');
      const extracts: string[][] = [];
      const request = jest.fn(async (prompt: string, inputs: any[]) => ({
        text: JSON.stringify({ reason: 'Compare the original exit-menu outline with the adjacent scenes',
          frames: inputs.map(i => ({ index: i.index,
            activity: i.time === 104 && (!prompt.includes('original resolution') || remainsUncertain) ? 'uncertain'
              : i.time < 104.5 ? 'game' : 'other',
            description: i.time < 104.5 ? 'Faint remaining exit menu' : 'Unobstructed talking scene' })) })
      }));
      const run = closing.verifyClosingFrames({ spokenEnd: 100, scanEnd: 110, gameName: 'Game', host: 'Host',
        source: { mediaPath, mediaBytes: '100', mediaMtimeNs: '1' }, mediaPath, directory,
        root: {}, settings: { provider: 'image-service', model: 'image-model' }, request,
        extract: async (args: string[]) => { extracts.push(args); fs.writeFileSync(args.at(-1), Buffer.alloc(1280)); } });
      if (remainsUncertain) await expect(run).rejects.toThrow(/remain uncertain/);
      else {
        const result = await run;
        expect(result.end).toBe(104.5);
        expect(result.contextReviews).toHaveLength(1);
        expect(closing.validateClosingReview(result, result.end)).toBe(104.5);
        fs.appendFileSync(result.contextReviews[0].responsePath, 'changed');
        expect(() => closing.validateClosingReview(result, result.end)).toThrow(/context evidence changed/);
      }
      expect(extracts.some(args => args.at(-1).includes('closing-context-') && !args.includes('-vf'))).toBe(true);
      expect(request.mock.calls.some(([prompt]) => prompt.includes('Black images with no identifiable game content'))).toBe(true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
