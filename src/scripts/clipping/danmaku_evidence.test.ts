const { getWindowDanmakuEvidence, createWindowDanmakuReader } = require('./own_selection');

describe('indexed audience evidence', () => {
  test('retains closed endpoints, equal-time ordering, duplicate rows and source object identity', () => {
    const shared = { time: 5, text: 'repeat' };
    const comments = [shared, { time: '1', text: 'first' }, { time: 5, text: 'other' }, shared,
      { time: 5.001, text: 'outside' }, { time: 'invalid', text: 'invalid' }];
    const order = comments.slice();
    const reader = createWindowDanmakuReader(comments, ['repeat']);
    const window = { start: 1, end: 5 };
    const result = reader(window);
    expect(result).toEqual(getWindowDanmakuEvidence(comments, window, ['repeat']));
    expect(result.totalCount).toBe(4);
    expect(result.topItems[0]).toEqual({ item: shared, count: 2 });
    expect(result.topItems[0].item).toBe(shared);
    expect(result.topTexts).toEqual(['repeat(x2)', 'first', 'other']);
    expect(comments).toEqual(order);
  });

  test('matches direct evidence selection across shuffled ranges, limits and repeated text', () => {
    let seed = 6271;
    const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
    const comments = Array.from({ length: 1500 }, (_, i) => Object.freeze({
      time: Math.round(random() * 1200) / 10, text: i % 3 ? `text-${i % 23}` : ` reaction-${i % 11} `
    }));
    const keywords = ['reaction', '7', '7'];
    const reader = createWindowDanmakuReader(comments, keywords);
    for (let iteration = 0; iteration < 150; iteration++) {
      const start = Math.round(random() * 1400) / 10 - 10;
      const window = { start, end: start + random() * 35 };
      const max = iteration % 19;
      expect(reader(window, max)).toEqual(getWindowDanmakuEvidence(comments, window, keywords, max));
    }
  });

  test('keeps invalid, reversed, empty and unbounded ranges consistent with direct filtering', () => {
    const comments = [{ time: -Infinity, text: 'before' }, { time: null, text: 'zero' },
      { time: 0, text: 'zero two' }, { time: 1, text: '' }, { time: Infinity, text: 'after' }];
    const reader = createWindowDanmakuReader(comments);
    for (const window of [{ start: NaN, end: 5 }, { start: 5, end: 1 }, { start: 0, end: 0 },
      { start: -Infinity, end: Infinity }, { start: Infinity, end: Infinity }, { start: 0, end: undefined }]) {
      expect(reader(window, 1)).toEqual(getWindowDanmakuEvidence(comments, window, [], 1));
    }
    expect(createWindowDanmakuReader([])({ start: 0, end: 10 }).totalCount).toBe(0);
  });

  test('rebuilding a planning pass observes source changes and never reuses an old index', () => {
    const comments = [{ time: 0, text: 'before' }];
    expect(createWindowDanmakuReader(comments)({ start: 0, end: 1 }).totalCount).toBe(1);
    comments[0].time = 10;
    comments[0].text = 'changed';
    comments.push({ time: 0.5, text: 'added' });
    const result = createWindowDanmakuReader(comments)({ start: 0, end: 1 });
    expect(result.totalCount).toBe(1);
    expect(result.topItems[0].item).toBe(comments[1]);
  });
});
