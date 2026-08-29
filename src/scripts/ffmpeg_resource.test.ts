const {
  applyFfmpegProcessPriority,
  waitForAsrAvailability,
  waitForCpuAvailability,
  parseGpuTelemetry
} = require('./ffmpeg_resource');
const os = require('os');


describe('topic clip CPU resource guard', () => {
  test('waits briefly for an active ASR lease, then resumes after it is released', async () => {
    const activeSamples = [true, true, false];
    const sleep = jest.fn().mockResolvedValue(undefined);
    const log = jest.fn();
    const result = await waitForAsrAvailability('ffmpeg test', {
      asrGuard: {
        enabled: true,
        staleMs: 15000,
        pollMs: 1000,
        maxWaitMs: 5000,
        overlapThreads: 1
      }
    }, {
      isActive: jest.fn(() => activeSamples.shift()),
      sleep,
      log
    });

    expect(result).toEqual({ waitedMs: 2000, asrActive: false });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain('ASR 正在使用资源');
    expect(log.mock.calls[1][0]).toContain('ASR 租约已释放');
  });

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

  test('parses GPU utilization and memory telemetry for multiple adapters', () => {
    expect(parseGpuTelemetry('42, 2048, 16384\n75, 1024, 8192\n')).toEqual({
      utilization: 75,
      memoryUsedMb: 3072,
      memoryTotalMb: 24576
    });
    expect(parseGpuTelemetry('')).toBeNull();
  });

  test('uses Node native priority updates without spawning PowerShell', () => {
    const setPriority = jest.spyOn(os, 'setPriority').mockImplementation(() => {});
    try {
      applyFfmpegProcessPriority(1234, 'belowNormal');
      if (process.platform === 'win32') {
        expect(setPriority).toHaveBeenCalledWith(
          1234,
          os.constants.priority.PRIORITY_BELOW_NORMAL
        );
      } else {
        expect(setPriority).not.toHaveBeenCalled();
      }
    } finally {
      setPriority.mockRestore();
    }
  });

  test('ignores invalid process IDs when applying priority', () => {
    const setPriority = jest.spyOn(os, 'setPriority').mockImplementation(() => {});
    try {
      applyFfmpegProcessPriority(0, 'belowNormal');
      applyFfmpegProcessPriority(1.5, 'belowNormal');
      expect(setPriority).not.toHaveBeenCalled();
    } finally {
      setPriority.mockRestore();
    }
  });
});
