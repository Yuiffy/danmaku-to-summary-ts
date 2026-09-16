import * as os from 'os';
import { applyFfmpegProcessPriority, withFfmpegResourceLimits } from './ffmpegResource';

jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return {
    ...actual,
    setPriority: jest.fn()
  };
});

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

  it('uses Node native priority updates on Windows', () => {
    const setPriority = os.setPriority as jest.MockedFunction<typeof os.setPriority>;
    setPriority.mockClear();
    applyFfmpegProcessPriority(1234, 'belowNormal');
    if (process.platform === 'win32') {
      expect(setPriority).toHaveBeenCalledWith(
        1234,
        os.constants.priority.PRIORITY_BELOW_NORMAL
      );
    } else {
      expect(setPriority).not.toHaveBeenCalled();
    }
  });
});
