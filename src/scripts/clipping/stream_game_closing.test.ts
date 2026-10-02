const closing = require('./stream_game_closing');
const fs = require('fs'), path = require('path'), os = require('os');

describe('silent game exit handling', () => {
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
    expect(() => closing.closingBoundary(review(['game', 'other', 'other', 'game', 'other']))).toThrow(/remains visible/);
  });
});
