const focus = require('./stream_game_focus');

const chapter = (title: string, start: number, extra: Record<string, unknown> = {}) => ({ title, start, end: start + 600, ...extra });

describe('game episode title focus', () => {
  test('names the hardest bosses once and one area, instead of three boss spellings', () => {
    // The 2026-11-01 session as detected: one boss retried three times under different
    // spellings, a tutorial boss, a rest stop and a tower the player returns to twice.
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
    expect(focus.selectFocus(chapters, { end: 6600 }).focus).toBe('斧老大、新娘阿花、杀气塔');
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

  test('falls back to named areas when a session has no boss chapters', () => {
    const chapters = [chapter('前往杀气塔外围', 0), chapter('高塔探索', 600), chapter('驿站', 1200)];
    expect(focus.selectFocus(chapters, { end: 1800 }).focus).toBe('杀气塔、高塔探索、驿站');
  });

  test('respects the title budget and the three label limit', () => {
    const chapters = Array.from({ length: 6 }, (_, i) => chapter(`非常长的地点名称第${i + 1}号区域`, i * 600, { kind: 'location' }));
    const result = focus.selectFocus(chapters, { end: 3600 });
    expect(result.labels.length).toBeLessThanOrEqual(3);
    expect(focus.displayUnits(result.focus)).toBeLessThanOrEqual(focus.MAX_UNITS);
  });

  test('boss names lead the title and each group keeps play order', () => {
    const chapters = [chapter('驿站', 0, { kind: 'location' }), chapter('斧老大', 600, { kind: 'boss' }),
      chapter('新娘阿花', 1200, { kind: 'boss' }), chapter('地下室', 1800, { kind: 'location' })];
    expect(focus.selectFocus(chapters, { end: 2400 }).focus).toBe('斧老大、新娘阿花、驿站');
  });
});
