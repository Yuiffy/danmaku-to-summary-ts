import { alignWatchParts, blackScanWindows, blackSettings, parseBlackSpans, WatchPart } from './watchBlackPolicy';

const settings = blackSettings({ enabled: true, region: '.27,.25,.58,.55' });
const parts = (start: number, lengths: number[], id = 'film'): WatchPart[] => lengths.map(duration => {
  const part = { activityId: id, start, end: start + duration, duration }; start += duration; return part;
});

test('rejects invalid regions and thresholds instead of scanning the host/full canvas', () => {
  for (const region of [null, '0,0,2,1', '-.1,0,.5,.5', [0, 0, 0, 1], [0, 0, NaN, 1]]) {
    expect(() => blackSettings({ enabled: true, region })).toThrow('region');
  }
  expect(() => blackSettings({ enabled: true, region: settings.region, pixelThreshold: .9 })).toThrow('pixelThreshold');
  expect(() => blackSettings({ enabled: true, region: settings.region, searchSeconds: Infinity })).toThrow('searchSeconds');
  expect(blackSettings({ enabled: false }).enabled).toBe(false);
});

test('scans bounded neighborhoods of internal Ps and never between different films', () => {
  expect(blackScanWindows([...parts(100, [1500, 1500]), ...parts(4000, [1000], 'other')], settings))
    .toEqual([{ start: 1299, end: 1901 }]);
  expect(blackScanWindows(parts(0, [900]), settings)).toEqual([]);
});

test('converts seek-local black intervals to recording time and excludes pauses/window edges', () => {
  const text = 'black_start:0 black_end:1 black_duration:1\n'
    + 'black_start:50.2 black_end:51 black_duration:0.8\n'
    + 'black_start:60 black_end:90 black_duration:30\n'
    + 'black_start:90 black_end:90.1 black_duration:0.1\n'
    + 'black_start:98 black_end:100 black_duration:2';
  expect(parseBlackSpans(text, { start: 1000, end: 1100 }, settings)).toEqual([{ start: 1050.2, end: 1051 }]);
});

test('joint alignment preserves every source second, caps Ps and balances among matching blacks', () => {
  const baseline = parts(100, [1500, 1500, 1500]);
  const report = alignWatchParts(baseline, [{ start: 1649, end: 1651 }, { start: 2999, end: 3001 }], settings, 1800);
  expect(report.parts.map(p => [p.start, p.end])).toEqual([[100, 1650], [1650, 3000], [3000, 4600]]);
  expect(report.cuts.every(cut => cut.method === 'movie_region_black')).toBe(true);
  expect(report.parts.reduce((sum, p) => sum + p.duration, 0)).toBe(4500);
});

test('rejects an attractive cut that leaves an overlong final P; no black retains balanced boundaries', () => {
  const baseline = parts(0, [1750, 1750]);
  expect(alignWatchParts(baseline, [{ start: 1499, end: 1501 }], settings, 1800).parts.map(p => p.end)).toEqual([1750, 3500]);
  expect(alignWatchParts(baseline, [], settings, 1800).cuts).toEqual([{ activityId: 'film', baseline: 1750, time: 1750, method: 'balanced' }]);
});

test('distinct films, very short sessions and original part count remain intact', () => {
  const baseline = [...parts(0, [1500, 1500]), ...parts(4000, [50], 'short')];
  const report = alignWatchParts(baseline, [{ start: 1449, end: 1451 }, { start: 3050, end: 3052 }], settings, 1800);
  expect(report.parts.map(p => [p.start, p.end])).toEqual([[0, 1450], [1450, 3000], [4000, 4050]]);
  expect(() => alignWatchParts([{ start: 0, end: 1801, duration: 1801 }], [], settings, 1800)).toThrow('continuous');
});

test('equally complete black splits prefer verified movie cadence over a nearer incidental fade', () => {
  const report = alignWatchParts(parts(0, [1500, 1500]), [{ start: 1499, end: 1501 }, { start: 1449, end: 1451 }],
    settings, 1800, [1450]);
  expect(report.parts[0].end).toBe(1450);
});

test('three-minute movie Ps stay candidates: a two-hour archive still uses five 24-minute Ps', () => {
  const baseline = parts(0, [1440, 1440, 1440, 1440, 1440]);
  const movieTimes = Array.from({ length: 39 }, (_, i) => (i + 1) * 180);
  const report = alignWatchParts(baseline, movieTimes.map(time => ({ start: time - .5, end: time + .5 })),
    settings, 1800, movieTimes);
  expect(report.parts).toHaveLength(5);
  expect(report.parts.map(part => part.duration)).toEqual([1440, 1440, 1440, 1440, 1440]);
  expect(report.cuts.map(cut => cut.time)).toEqual([1440, 2880, 4320, 5760]);
  expect(report.parts.at(-1)!.end).toBe(7200);
});

test('short review parts align with movie blacks while respecting their own maximum', () => {
  const report = alignWatchParts(parts(0, [600, 600, 600]), [{ start: 539, end: 541 }, { start: 1259, end: 1261 }], settings, 720);
  expect(report.parts.map(part => part.duration)).toEqual([540, 720, 540]);
  expect(report.cuts.every(cut => cut.method === 'movie_region_black')).toBe(true);
});

test('long review parts remain long instead of being capped at the default thirty minutes', () => {
  const report = alignWatchParts(parts(0, [3600, 3600]), [{ start: 3689, end: 3691 }], settings, 4200);
  expect(report.parts.map(part => part.duration)).toEqual([3690, 3510]);
  expect(report.parts.at(-1)!.end).toBe(7200);
});

test('alignment preserves an unequal editorial length pattern instead of balancing it away', () => {
  const spans = [610, 810, 2790, 2990].map(time => ({ start: time - .5, end: time + .5 }));
  const report = alignWatchParts(parts(0, [600, 2400, 600]), spans, settings, 2700);
  expect(report.parts.map(part => part.duration)).toEqual([610, 2380, 610]);
});
