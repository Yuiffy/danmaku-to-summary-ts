const { waitForCpuAvailability } = require('./ffmpeg_resource');


describe('topic clip CPU resource guard', () => {
  const resourceConfig = {
    threads: 1,
    priority: 'idle',
    cpuGuard: {
      enabled: true,
      busyPercentThreshold: 80,
      resumePercentThreshold: 60,
      sampleIntervalMs: 1,
      waitMs: 5000,
      maxWaitMs: 0,
      consecutiveBusySamples: 2,
      consecutiveIdleSamples: 2
    }
  };

  test('waits while CPU is busy and resumes after hysteresis samples', async () => {
    const samples = [85, 90, 70, 55, 50];
    const sleep = jest.fn().mockResolvedValue(undefined);
    const log = jest.fn();

    const result = await waitForCpuAvailability('ffmpeg test', resourceConfig, {
      sampleCpuPercent: jest.fn(async () => samples.shift()),
      sleep,
      log
    });

    expect(result).toEqual({ waitedMs: 10000, lastCpuPercent: 50 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain('CPU 繁忙');
    expect(log.mock.calls[1][0]).toContain('CPU 已恢复');
  });

  test('ignores a single transient CPU spike', async () => {
    const samples = [85, 70];
    const sleep = jest.fn().mockResolvedValue(undefined);

    const result = await waitForCpuAvailability('ffmpeg test', resourceConfig, {
      sampleCpuPercent: jest.fn(async () => samples.shift()),
      sleep,
      log: jest.fn()
    });

    expect(result).toEqual({ waitedMs: 0, lastCpuPercent: 70 });
    expect(sleep).not.toHaveBeenCalled();
  });

  test('does not sample CPU when the guard is disabled', async () => {
    const sampleCpuPercent = jest.fn();

    const result = await waitForCpuAvailability('ffmpeg test', {
      ...resourceConfig,
      cpuGuard: { enabled: false }
    }, { sampleCpuPercent });

    expect(result).toEqual({ waitedMs: 0, lastCpuPercent: null });
    expect(sampleCpuPercent).not.toHaveBeenCalled();
  });
});
