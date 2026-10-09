import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const { renderActivityPart } = require('./stream_activity_media');

describe('activity render restart checkpoints', () => {
  let directory: string;
  let source: string;
  const part = { start: 10, end: 20, duration: 10, activityId: 'song-1' };
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-render-resume-'));
    source = path.join(directory, 'source.flv'); fs.writeFileSync(source, 'source');
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  test('restart retains finished Ps, rebuilds interrupted P and never adopts partial media', async () => {
    const outputs = [1, 2, 3].map(i => path.join(directory, `P${i}.mp4`));
    const encode = jest.fn(async (args: string[]) => { fs.writeFileSync(args.at(-1)!, 'complete'); });
    const hooks = { runFfmpeg: encode, probe: async () => 10 };
    await renderActivityPart(source, part, outputs[0], {}, {}, hooks);
    const interrupted = jest.fn(async (args: string[]) => {
      fs.writeFileSync(args.at(-1)!, 'interrupted'); throw new Error('process exited');
    });
    await expect(renderActivityPart(source, part, outputs[1], {}, {}, { ...hooks, runFfmpeg: interrupted })).rejects.toThrow();
    expect(fs.existsSync(`${outputs[1]}.render.json`)).toBe(false);
    for (const output of outputs) await renderActivityPart(source, part, output, {}, {}, hooks);
    expect(encode).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(outputs[1], 'utf8')).toBe('complete');
    // Simulate a surviving old FFmpeg. Its temporary output cannot clobber the resumed P.
    fs.writeFileSync(interrupted.mock.calls[0][0].at(-1)!, 'late orphan write');
    expect(fs.readFileSync(outputs[1], 'utf8')).toBe('complete');
  });

  test('changed source, intervals, settings or output invalidate a receipt', async () => {
    const output = path.join(directory, 'P1.mp4');
    const encode = jest.fn(async (args: string[]) => fs.writeFileSync(args.at(-1)!, 'complete'));
    const hooks = { runFfmpeg: encode, probe: async () => 10 };
    await renderActivityPart(source, part, output, {}, {}, hooks);
    fs.writeFileSync(output, 'tampered');
    await renderActivityPart(source, part, output, {}, {}, hooks);
    fs.writeFileSync(source, 'source changed');
    await renderActivityPart(source, part, output, {}, {}, hooks);
    const moved = { ...part, start: 20, end: 30 };
    await renderActivityPart(source, moved, output, {}, {}, hooks);
    await renderActivityPart(source, moved, output, { ownStreamClips: { subtitleVideoEncoder: 'h264_nvenc' } }, {}, hooks);
    expect(encode).toHaveBeenCalledTimes(5);
  });

  test.each([NaN, 4])('invalid duration %s never receives a completed receipt', async duration => {
    const output = path.join(directory, 'P1.mp4');
    await expect(renderActivityPart(source, part, output, {}, {}, {
      runFfmpeg: async (args: string[]) => fs.writeFileSync(args.at(-1)!, 'partial'), probe: async () => duration
    })).rejects.toThrow('duration mismatch');
    expect(fs.existsSync(`${output}.render.json`)).toBe(false);
  });
});
