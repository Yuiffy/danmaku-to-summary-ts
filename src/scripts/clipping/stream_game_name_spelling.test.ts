const spelling = require('./stream_game_name_spelling');

/** Minimal `loadAudience()` stand-in: only the text of chat and speech matters here. */
const audience = ({ danmaku = [], subtitles = [] }: { danmaku?: string[]; subtitles?: string[] } = {}) => ({
  danmaku: danmaku.map((text, i) => ({ time: i, text })),
  subtitles: subtitles.map((text, i) => ({ start: i, end: i + 1, text })),
  gifts: [], duration: 3600, baseline: { perMinute: 10, peakMedian: 5, peakP90: 20 },
  available: { danmaku: danmaku.length > 0, subtitles: subtitles.length > 0, gifts: false }
});

const frameChapter = (title: string, start = 0, extra: Record<string, unknown> = {}) => ({
  title, start, end: start + 600, kind: 'boss', nameEvidence: title, nameEvidenceSource: 'original_frame', ...extra
});

describe('frame-read name spelling', () => {
  test('replaces a one-glyph misreading with the spelling chat actually types', () => {
    // The 2026-11-01 health bar says 斧老大：彭猛; the frame review read 斧光大.
    const result = spelling.correctName('斧光大：彭猛', spelling.createCorpus(audience({
      danmaku: Array.from({ length: 13 }, (_, i) => `斧老大好猛 ${i}`)
    })));
    expect(result.title).toBe('斧老大');
    expect(result.corrections).toEqual([{ from: '斧光大', to: '斧老大', observed: 13, frameReadings: 0 }]);
  });

  test('keeps the literal label when nobody types the name', () => {
    const result = spelling.correctName('斧光大：彭猛', spelling.createCorpus(audience({ danmaku: ['哈哈', '太猛了'] })));
    expect(result.title).toBe('斧光大：彭猛');
    expect(result.corrections).toEqual([]);
  });

  test('ignores a spelling that only shows up once or twice', () => {
    const result = spelling.correctName('斧光大：彭猛', spelling.createCorpus(audience({ danmaku: ['斧老大'] })));
    expect(result.title).toBe('斧光大：彭猛');
  });

  test('does not rewrite two-character names, where one difference is most of the name', () => {
    const result = spelling.correctName('阿花', spelling.createCorpus(audience({ danmaku: Array.from({ length: 9 }, () => '阿华') })));
    expect(result.title).toBe('阿花');
  });

  test('keeps both halves when chat names the personal name too', () => {
    const result = spelling.correctName('斧老大：彭猛', spelling.createCorpus(audience({
      danmaku: [...Array.from({ length: 8 }, () => '斧老大'), ...Array.from({ length: 6 }, () => '彭猛')]
    })));
    expect(result.title).toBe('斧老大：彭猛');
  });

  test('keeps the separator the health bar used', () => {
    const result = spelling.correctName('斧光大:彭猛', spelling.createCorpus(audience({
      danmaku: [...Array.from({ length: 5 }, () => '斧老大'), ...Array.from({ length: 5 }, () => '彭猛')]
    })));
    expect(result.title).toBe('斧老大:彭猛');
  });

  test('corrects the mistake another pass already noticed: 斩娘阿花 → 新娘阿花', () => {
    const result = spelling.correctName('斩娘阿花', spelling.createCorpus(audience({
      danmaku: Array.from({ length: 4 }, () => '新娘阿花又来了')
    })));
    expect(result.title).toBe('新娘阿花');
    expect(result.corrections[0]).toMatchObject({ from: '斩娘阿花', to: '新娘阿花', observed: 4 });
  });

  test('rewrites a frame-named chapter once, keeping the literal reading as evidence', () => {
    const event = { chapters: [frameChapter('斧光大：彭猛', 12420.92)] };
    const applied = spelling.correctFrameNames(event, audience({
      danmaku: Array.from({ length: 13 }, () => '斧老大'), subtitles: ['这斧老大真难打']
    }));
    expect(applied).toHaveLength(1);
    expect(event.chapters[0].title).toBe('斧老大');
    expect(event.chapters[0].nameEvidence).toBe('斧老大');
    expect(event.chapters[0].nameCorrection).toMatchObject({ from: '斧光大：彭猛', title: '斧老大', shortened: true });
  });

  test('leaves names grounded in speech alone, because they are not read off a frame', () => {
    const event = { chapters: [frameChapter('叶师傅', 0, { nameEvidenceSource: 'spoken' })] };
    expect(spelling.correctFrameNames(event, audience({ danmaku: Array.from({ length: 13 }, () => '叶师傅') }))).toEqual([]);
    expect(event.chapters[0].title).toBe('叶师傅');
  });

  test('does nothing without chat or subtitles', () => {
    const event = { chapters: [frameChapter('斧光大：彭猛')] };
    expect(spelling.correctFrameNames(event, null)).toEqual([]);
    expect(event.chapters[0].title).toBe('斧光大：彭猛');
  });
});
