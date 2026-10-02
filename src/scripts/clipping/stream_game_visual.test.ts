const visual = require('./stream_game_visual');

describe('independent full gameplay timeline', () => {
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
