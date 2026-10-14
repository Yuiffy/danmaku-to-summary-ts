import { inferMovieCadence, movieCadenceSettings, trackMovieCadence } from './watchMovieCadence';
const settings = movieCadenceSettings();
const black = (time: number) => ({ start: time - .5, end: time + .5 });

test('a consistent triple outranks an incidental fade pair, while two anchors stay tentative', () => {
  const cadence = inferMovieCadence([black(400), black(600), black(1200), black(1800)], settings);
  expect(cadence).toMatchObject({ period: 600, anchor: 1800, matches: [600, 1200, 1800] });
  expect(inferMovieCadence([black(600)], settings)).toBeNull();
});

test('predicted points need local black evidence and a pause shifts the anchor without corrupting the period', async () => {
  const observed = [black(600), black(1200), black(1850), black(2450)];
  const scan = jest.fn(async window => observed.filter(span => span.start > window.start && span.end < window.end));
  const report = await trackMovieCadence({ start: 0, end: 3000 }, observed.slice(0, 2), settings, scan);
  expect(report).toMatchObject({ status: 'locally_verified', cadence: { period: 600 }, finalAnchor: 2450 });
  expect(report.predictions).toEqual([
    { predicted: 1800, actual: 1850, deviation: 50, recovered: true, status: 'black_verified' },
    { predicted: 2450, actual: 2450, deviation: 0, recovered: false, status: 'black_verified' }]);
  expect(scan).toHaveBeenCalledTimes(3);
});

test('missing/uneven parts never create extrapolated cuts and eventually abandon the rule', async () => {
  const report = await trackMovieCadence({ start: 0, end: 4000 }, [black(600), black(1200)], settings, async () => []);
  expect(report.status).toBe('lost_pattern'); expect(report.spans).toEqual([]);
  expect(report.predictions.map(row => row.predicted)).toEqual([1800, 2400, 3000]);
});

test('reviewed seeds must still match detected movie black frames', () => {
  const seeded = movieCadenceSettings({ seeds: [600, 1200] });
  expect(inferMovieCadence([black(600), black(1200)], seeded)?.origin).toBe('reviewed_seeds');
  expect(() => inferMovieCadence([black(600)], seeded)).toThrow('local black-frame evidence');
  expect(() => movieCadenceSettings({ seeds: [NaN, 1200] })).toThrow('seeds');
});

test('short movie parts keep their base period even when several transitions were missed', () => {
  const cadence = inferMovieCadence([black(180), black(360), black(540), black(720), black(930),
    black(1080), black(1620), black(1800), black(1980)], settings);
  expect(cadence).toMatchObject({ period: 180, anchor: 1980, matches: [180, 360, 540, 720, 1080, 1620, 1800, 1980] });
});
