const focus = require('./stream_game_focus');

const chapter = (title: string, start: number, extra: Record<string, unknown> = {}) => ({ title, start, end: start + 600, ...extra });

/**
 * Minimal stand-in for `stream_game_audience.loadAudience()`: `chats` is how many
 * danmaku lines land at a second, `words` overrides their text.
 */
const audienceFixture = ({ chats = {}, words = {} }: { chats?: Record<number, number>; words?: Record<number, string[]> }) => {
  const danmaku: Array<{ time: number; text: string }> = [];
  for (const [time, count] of Object.entries(chats)) {
    const texts = words[Number(time)] || [];
    for (let i = 0; i < count; i++) danmaku.push({ time: Number(time) + i * .5, text: texts[i % Math.max(1, texts.length)] || '哈哈' });
  }
  danmaku.sort((a, b) => a.time - b.time);
  return { danmaku, subtitles: [], gifts: [], duration: 3600,
    baseline: { perMinute: 10, peakMedian: 5, peakP90: 20 }, available: { danmaku: true, subtitles: false, gifts: false } };
};

describe('game episode title focus', () => {
  test('names the hardest bosses once and one area, instead of three boss spellings', () => {
    // The 2026-11-01 session as detected: one boss retried three times under different
    // spellings, a tutorial boss, a rest stop and a tower the player returns to twice.
    // 斧光大 / 斩娘阿花 are frame-reading slips; `stream_game_name_spelling` repairs those
    // before this stage (see its own suite), so this case locks the rest of the shape.
    const chapters = [
      chapter('启动游戏与首个 Boss 前准备', 0),
      chapter('调整手柄键位', 600),
      chapter('斧老大连续挑战', 1200, { kind: 'boss', nameEvidence: '斧老大' }),
      chapter('斧光大：彭猛', 1800, { kind: 'boss', nameEvidence: '斧光大：彭猛' }),
      chapter('驿站', 2400, { kind: 'location', nameEvidence: '驿站' }),
      chapter('前往杀气塔外围', 3000, { nameEvidence: '杀气塔' }),
      chapter('高塔探索', 3600, { kind: 'location', nameEvidence: '高塔' }),
      chapter('塔内探索', 4200),
      chapter('阿花', 4800, { kind: 'boss', nameEvidence: '阿花' }),
      chapter('新娘阿花', 5400, { kind: 'boss', nameEvidence: '新娘阿花' }),
      chapter('斩娘阿花', 6000, { kind: 'boss', nameEvidence: '斩娘阿花' })
    ];
    expect(focus.selectFocus(chapters, { end: 6600 }).focus).toBe('斧老大、斧光大：彭猛、新娘阿花、杀气塔');
  });

  test('strips retry suffixes and never repeats one boss under several spellings', () => {
    expect(focus.cleanLabel('新娘阿花连续挑战')).toBe('新娘阿花');
    expect(focus.cleanLabel('红花首领反复尝试')).toBe('红花首领');
    expect(focus.selectFocus([chapter('阿花', 0, { kind: 'boss' }), chapter('新娘阿花', 600, { kind: 'boss' })]).focus)
      .toBe('新娘阿花');
  });

  test('keeps session bookkeeping and pure activity labels out of the title', () => {
    const labels = ['启动游戏', '设置', '调整手柄键位', '探索与战斗', '战斗', '继续探索', '重新尝试与招式应对'];
    expect(focus.selectFocus(labels.map((title, i) => chapter(title, i * 600))).focus).toBe('探索与推进');
  });

  test('merges consecutive place chapters into one region', () => {
    // 杀气塔 → 高塔 → 驿站 are one sweep of the same area, not three title slots.
    const chapters = [chapter('前往杀气塔外围', 0), chapter('高塔探索', 600), chapter('驿站', 1200)];
    expect(focus.selectFocus(chapters, { end: 1800 }).focus).toBe('杀气塔');
  });

  test('respects the title budget and the four label limit', () => {
    const chapters = Array.from({ length: 6 }, (_, i) => chapter(`非常长的地点名称第${i + 1}号区域`, i * 600, { kind: 'location' }));
    const result = focus.selectFocus(chapters, { end: 3600 });
    expect(result.labels.length).toBeLessThanOrEqual(4);
    expect(focus.displayUnits(result.focus)).toBeLessThanOrEqual(focus.MAX_UNITS);
  });

  test('boss names lead the title and each group keeps play order', () => {
    const chapters = [chapter('驿站', 0, { kind: 'location' }), chapter('斧老大', 600, { kind: 'boss' }),
      chapter('新娘阿花', 1200, { kind: 'boss' }), chapter('地下室', 1800, { kind: 'location' })];
    // A rest stop is the weakest place name, so the explored area wins the slot.
    expect(focus.selectFocus(chapters, { end: 2400 }).focus).toBe('斧老大、新娘阿花、地下室');
  });

  test('keeps a third important boss instead of stopping at two', () => {
    const chapters = [chapter('斧老大', 0, { kind: 'boss', nameEvidence: '斧老大' }),
      chapter('斧光大：彭猛', 600, { kind: 'boss', nameEvidence: '斧光大：彭猛' }),
      chapter('新娘阿花', 1200, { kind: 'boss', nameEvidence: '新娘阿花' }),
      chapter('额外首领', 1800, { kind: 'boss', nameEvidence: '额外首领' })];
    expect(focus.selectFocus(chapters, { end: 2400 }).focus).toBe('斧老大、斧光大：彭猛、新娘阿花、额外首领');
  });

  test('a boss chat exploded over outranks one it slept through', () => {
    const chapters = [chapter('安静首领', 0, { kind: 'boss', nameEvidence: '安静首领' }),
      chapter('热闹首领', 600, { kind: 'boss', nameEvidence: '热闹首领' })];
    const audience = audienceFixture({ chats: { 0: 2, 600: 400 } });
    const ranked = focus.selectFocus(chapters, { end: 1200, audience }).details;
    const loud = ranked.find(row => row.label === '热闹首领');
    const quiet = ranked.find(row => row.label === '安静首领');
    expect(loud.importance).toBeGreaterThan(quiet.importance);
    expect(loud.peakDanmaku).toBeGreaterThan(quiet.peakDanmaku);
  });

  test('chat talking about one boss under another name merges the spellings', () => {
    // 2026-11-01: the chapter labelled 鬼新娘 is the same fight as 新娘阿花; chat kept
    // typing 阿花 while the model alternated names.
    const chapters = [chapter('阿花', 0, { kind: 'boss', nameEvidence: '阿花' }),
      chapter('新娘阿花', 1, { kind: 'boss', nameEvidence: '新娘阿花' }),
      chapter('鬼新娘', 600, { kind: 'boss', nameEvidence: '鬼新娘' })];
    const audience = audienceFixture({ chats: { 600: 30 }, words: { 600: ['阿花好难'] } });
    expect(focus.selectFocus(chapters, { end: 1200, audience }).focus).toBe('新娘阿花');
    expect(focus.selectFocus(chapters, { end: 1200 }).focus).toBe('新娘阿花、鬼新娘');
  });
});
