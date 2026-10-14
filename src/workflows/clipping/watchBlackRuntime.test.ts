import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { blackSettings } from './watchBlackPolicy';
import { blackFilter, detectBlackWindow, scanWatchBlack } from './watchBlackRuntime';

const settings = blackSettings({ enabled: true, region: '.27,.25,.58,.55', cadence: { enabled: false } });
test('crops the reviewed movie ROI and falls back from CUDA without changing thresholds/timestamps', async () => {
  const run = jest.fn().mockRejectedValueOnce(new Error('CUDA unavailable'))
    .mockResolvedValue({ stderr: 'black_start:20 black_end:21 black_duration:1' });
  const result = await detectBlackWindow({ start: 1000, end: 1100 }, { settings, mediaPath: 'movie.flv', run });
  expect(result).toMatchObject({ decoder: 'software', fallbackReason: 'CUDA unavailable', spans: [{ start: 1020, end: 1021 }] });
  expect(run.mock.calls[0][0]).toContain('cuda');
  expect(run.mock.calls[1][0]).not.toContain('cuda');
  expect(run.mock.calls[0][0]).toContain(blackFilter(settings));
  expect(blackFilter(settings)).toContain('crop=iw*0.58:ih*0.55:iw*0.27:ih*0.25');
  expect(blackFilter(settings)).not.toContain('fps='); // Detect even brief transitions at source frame rate.
});

test('source/settings/boundary bound evidence resumes without decoding and detects tampering', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-black-'));
  const run = jest.fn(async () => ({ stderr: 'black_start:351 black_end:352 black_duration:1' }));
  const options = { directory, mediaPath: 'movie.flv', source: { bytes: 123 }, settings, run, maximum: 1800,
    parts: [{ activityId: 'film', start: 100, end: 1600, duration: 1500 },
      { activityId: 'film', start: 1600, end: 3100, duration: 1500 }] };
  try {
    const first = await scanWatchBlack(options);
    expect(first.parts[0].end).toBe(1650.5); expect(first.scannedSeconds).toBe(602);
    const resumed = await scanWatchBlack(options);
    expect(resumed.reused).toBe(true); expect(run).toHaveBeenCalledTimes(1);
    await scanWatchBlack({ ...options, source: { bytes: 124 } }); expect(run).toHaveBeenCalledTimes(2);
    const cached = JSON.parse(fs.readFileSync(first.evidencePath, 'utf8')); cached.parts[0].end = 0;
    fs.writeFileSync(first.evidencePath, JSON.stringify(cached));
    await expect(scanWatchBlack(options)).rejects.toThrow('cache changed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a failed decoder never becomes a successful empty-black result', async () => {
  const run = jest.fn(async () => { throw new Error('unreadable media'); });
  await expect(detectBlackWindow({ start: 100, end: 200 }, { settings, mediaPath: 'broken.flv', run }))
    .rejects.toThrow('unreadable media');
});
