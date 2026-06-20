import { withFfmpegResourceLimits } from './ffmpegResource';

describe('ffmpegResource', () => {
  it('adds thread limit before the output path', () => {
    const args = ['-y', '-i', 'input.mp4', '-c:v', 'libx264', 'output.mp4'];

    expect(withFfmpegResourceLimits(args, { threads: 2, priority: 'belowNormal' })).toEqual([
      '-y',
      '-i',
      'input.mp4',
      '-c:v',
      'libx264',
      '-threads',
      '2',
      'output.mp4'
    ]);
  });

  it('does not duplicate an explicit thread limit', () => {
    const args = ['-y', '-i', 'input.mp4', '-threads', '1', 'output.mp4'];

    expect(withFfmpegResourceLimits(args, { threads: 2, priority: 'belowNormal' })).toEqual(args);
  });
});
