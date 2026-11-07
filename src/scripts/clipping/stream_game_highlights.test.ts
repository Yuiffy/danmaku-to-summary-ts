const { buildHighlightPlan, mergeRanges } = require('./stream_game_highlights');

const cue = (start, end, text) => ({ start, end, text });
const event = (id, chapters) => ({ id, gameId: 'shadow-blade-zero', start: 0, end: 1000, chapters, verification: { decision: 'keep' } });

describe('stream game highlights', () => {
  test('keeps body in source order even when candidates score out of order', () => {
    const audience = { subtitles: [cue(700, 704, '我靠完了'), cue(100, 104, '准备进入')], danmaku: [], gifts: [], baseline: { peakMedian: 1 } };
    const plan = buildHighlightPlan({ events: [event('e1', [
      { start: 100, title: '探索', kind: 'phase', description: '探索' },
      { start: 700, title: '阿花', kind: 'boss', description: 'Boss 战' }
    ])], audience, bodySeconds: 120, teaserSeconds: 8, teaserSegments: 1 });
    expect(plan.body.map(row => row.start)).toEqual([...plan.body].sort((a, b) => a.start - b.start).map(row => row.start));
    expect(plan.teaser[0].chapter.title).toBe('阿花');
  });

  test('merges only nearby ranges from the same event', () => {
    expect(mergeRanges([
      { eventId: 'a', start: 10, end: 20, duration: 10, score: 1 },
      { eventId: 'a', start: 25, end: 30, duration: 5, score: 2 },
      { eventId: 'b', start: 31, end: 40, duration: 9, score: 9 }
    ], 6)).toHaveLength(2);
  });
});
