import { assertWatchBoundaries, watchContextIntervals, watchContextFrameTimes } from './activityWatchContext';

const event = { id: 'watch', kind: 'watch', start: 1000, end: 4000 };
const intervals = [{ start: 955, end: 1015 }, { start: 3985, end: 4045 }];
const openingIntervals = [{ start: 910, end: 1015 }, intervals[1]];
const cue = (start: number, text: string, source = 'audio_transcript') => ({ start, end: start + 5, text, source });

test('an ending far inside playback gets short later transition evidence without decoding its entire middle', () => {
  const result = watchContextIntervals(event, intervals, [cue(4600, '没有彩蛋，那我们现在搜索下一部')], 6000);
  expect(result).toEqual([...openingIntervals, { start: 4570, end: 4650 }]);
  expect(result.reduce((n, s) => n + s.end - s.start, 0)).toBe(245);
  expect(event.end).toBe(4000); // No source cue silently changes the retained boundary.
});

test('a later evidence window includes transition frames rather than only the middle of the film', () => {
  expect(watchContextFrameTimes(event, intervals)).toEqual([2500, 955, 1014.99, 3985, 4044.99]);
  expect(watchContextFrameTimes(event, [...intervals, { start: 4570, end: 4650 }])).toEqual([2500, 955, 1014.99, 4570, 4649.99, 4610]);
});

test('a disputed final end supplies both the original rough end and the actual rendered endpoint', () => {
  const disputed = { ...event, boundaryFeedback: { previousEnd: 4030 } };
  expect(watchContextFrameTimes(disputed, intervals))
    .toEqual(expect.arrayContaining([2500, 4000, 4029.75, 4044.75]));
  expect(watchContextIntervals(disputed, intervals, [], 6000)).toEqual([openingIntervals[0], { start: 3955, end: 4045 }]);
});

test('audience, another work and unbounded later evidence cannot extend a candidate', () => {
  expect(watchContextIntervals(event, intervals, [cue(4200, '结束了', 'audience'), cue(4700, '看完了')], 6000,
    [event, { id: 'next', start: 4500 }])).toEqual(openingIntervals);
  expect(watchContextIntervals(event, intervals, [cue(5000, '看完了')], 6000)).toEqual(openingIntervals);
  expect(watchContextIntervals({ ...event, kind: 'song' }, intervals, [cue(4300, '看完了')], 6000)).toEqual(intervals);
});

test('nearby repeated phrases share a window and total acquisition stays bounded', () => {
  const rows = [cue(4100, '结束了'), cue(4110, '看完了'), cue(4400, '没有彩蛋'), cue(4800, '下一个看什么')];
  const result = watchContextIntervals(event, intervals, rows, 6000);
  expect(result).toHaveLength(4);
  expect(result.at(-1)?.end).toBe(4450);
});

test('held boundaries stop before media work while confirmed enclosures remain eligible for full review', () => {
  expect(() => assertWatchBoundaries([{ ...event, verification: { decision: 'uncertain', reason: 'still playing' } }]))
    .toThrow('still playing');
  expect(() => assertWatchBoundaries([{ ...event, verification: { decision: 'keep' }, reviewIssues: [] }])).not.toThrow();
});

test('rough viewing starts include the preceding scene change without crossing another work', () => {
  const result = watchContextIntervals(event, intervals, [], 6000);
  expect(result[0]).toEqual({ start: 910, end: 1015 });
  expect(watchContextIntervals(event, intervals, [], 6000, [{ id: 'previous', kind: 'watch', start: 800, end: 940 }, event])[0])
    .toEqual({ start: 940, end: 1015 });
});

test('ordinary viewing packets show original opening and closing scenes as well as the middle', () => {
  const times = watchContextFrameTimes(event, intervals);
  expect(times).toEqual(expect.arrayContaining([955, 1014.99, 2500, 3985, 4044.99]));
});

test('declining further viewing locates evidence after a preview without approving its endpoint', () => {
  const result = watchContextIntervals(event, intervals, [cue(4090, '大家私下自己看吧')], 6000);
  expect(result.at(-1)).toEqual({ start: 4060, end: 4140 });
  expect(event.end).toBe(4000);
});
