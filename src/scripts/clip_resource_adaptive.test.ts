const {
  ClipResourceAdaptiveScheduler,
  detectBusySignals,
  parseGpuProcessMonitor,
  parseGpuSummary,
  resolveClipResourceAdaptiveConfig
} = require('./clip_resource_adaptive');

const BASE_CONFIG = {
  enabled: true,
  idleConcurrency: 2,
  busyConcurrency: 1,
  idleFfmpegThreads: 2,
  busyFfmpegThreads: 1,
  pollIntervalMs: 1000,
  busyCpuPercentThreshold: 70,
  busyGpuUtilizationThreshold: 35,
  foregroundGpuUtilizationThreshold: 20,
  externalGpuActivityThreshold: 25,
  busySamples: 2,
  idleSamples: 3,
  gameProcessNames: ['GameClient.exe'],
  ignoredGpuProcessNames: ['Chrome.exe']
};

function makeEnvironment(overrides = {}) {
  return {
    cpuPercent: 15,
    foreground: { pid: 100, name: 'chrome.exe', title: 'Browser' },
    processNames: ['chrome.exe'],
    gpu: {
      utilization: 5,
      processes: [{ pid: 100, name: 'chrome.exe', sm: 2, mem: 1, enc: 0, dec: 0 }]
    },
    ...overrides
  };
}

describe('clip_resource_adaptive', () => {
  test('keeps ordinary desktop activity in idle mode', () => {
    const signals = detectBusySignals(makeEnvironment(), BASE_CONFIG, new Set());

    expect(signals.busy).toBe(false);
    expect(signals.reasons).toEqual([]);
  });

  test('detects a configured game process without requiring it to be foreground', () => {
    const signals = detectBusySignals(makeEnvironment({
      processNames: ['chrome.exe', 'GameClient.exe'],
      foreground: { pid: 100, name: 'chrome.exe', title: 'Browser' }
    }), BASE_CONFIG, new Set());

    expect(signals.busy).toBe(true);
    expect(signals.configuredGameRunning).toBe(true);
    expect(signals.reasons[0]).toContain('游戏进程运行');
  });

  test('detects an active foreground GPU application', () => {
    const signals = detectBusySignals(makeEnvironment({
      foreground: { pid: 200, name: 'GameClient.exe', title: 'Game' },
      processNames: ['GameClient.exe'],
      gpu: {
        utilization: 28,
        processes: [{ pid: 200, name: 'GameClient.exe', sm: 5, mem: 3, enc: 0, dec: 0 }]
      }
    }), BASE_CONFIG, new Set());

    expect(signals.busy).toBe(true);
    expect(signals.foregroundGpuActive).toBe(true);
    expect(signals.reasons).toContain('前台 GPU 进程: GameClient.exe');
  });

  test('detects high CPU pressure even when GPU telemetry is unavailable', () => {
    const signals = detectBusySignals(makeEnvironment({
      cpuPercent: 82,
      gpu: { utilization: null, processes: [] }
    }), BASE_CONFIG, new Set());

    expect(signals.busy).toBe(true);
    expect(signals.cpuBusy).toBe(true);
    expect(signals.totalGpuBusy).toBe(false);
  });

  test('ignores the clipper FFmpeg process when looking for external GPU pressure', () => {
    const signals = detectBusySignals(makeEnvironment({
      foreground: { pid: 300, name: 'ffmpeg.exe', title: '' },
      gpu: {
        utilization: 80,
        processes: [{ pid: 300, name: 'ffmpeg.exe', sm: 80, mem: 70, enc: 90, dec: 0 }]
      }
    }), BASE_CONFIG, new Set());

    expect(signals.busy).toBe(false);
    expect(signals.externalGpuProcessCount).toBe(0);
  });

  test('switches to busy after consecutive busy samples and returns to idle after consecutive idle samples', async () => {
    let now = 0;
    const busy = makeEnvironment({
      processNames: ['GameClient.exe'],
      foreground: { pid: 200, name: 'GameClient.exe', title: 'Game' }
    });
    const idle = makeEnvironment();
    const samples = [busy, busy, idle, idle, idle];
    const scheduler = new ClipResourceAdaptiveScheduler({
      config: BASE_CONFIG,
      dependencies: {
        now: () => now,
        sampleEnvironment: async () => samples.shift(),
        sleep: async () => {}
      },
      log: () => {}
    });

    await scheduler.refresh(true);
    expect(scheduler.getProfile()).toMatchObject({ mode: 'idle', concurrency: 2, ffmpegThreads: 2 });

    now += 1000;
    await scheduler.refresh(true);
    expect(scheduler.getProfile()).toMatchObject({ mode: 'busy', concurrency: 1, ffmpegThreads: 1 });

    now += 1000;
    await scheduler.refresh(true);
    now += 1000;
    await scheduler.refresh(true);
    expect(scheduler.getProfile().mode).toBe('busy');

    now += 1000;
    await scheduler.refresh(true);
    expect(scheduler.getProfile()).toMatchObject({ mode: 'idle', concurrency: 2, ffmpegThreads: 2 });
  });

  test('inherits the configured game list from the ASR resource guard', () => {
    const config = resolveClipResourceAdaptiveConfig({
      clipConcurrency: 2,
      clipFfmpegThreads: 2,
      clipResourceAdaptive: { enabled: true }
    }, {
      asr: {
        paraformer: {
          resource_guard: { game_process_names: ['GameClient.exe'] }
        }
      }
    });

    expect(config.gameProcessNames).toEqual(['GameClient.exe']);
    expect(config.idleConcurrency).toBe(2);
    expect(config.idleFfmpegThreads).toBe(2);
  });

  test('fails open to idle when a resource sample fails', async () => {
    const logs = [];
    const scheduler = new ClipResourceAdaptiveScheduler({
      config: BASE_CONFIG,
      dependencies: {
        sampleEnvironment: async () => {
          throw new Error('telemetry unavailable');
        }
      },
      log: message => logs.push(message)
    });

    const profile = await scheduler.refresh(true);

    expect(profile).toMatchObject({ mode: 'idle', concurrency: 2, ffmpegThreads: 2 });
    expect(logs).toEqual(['[resource] 自动切片资源探测失败，按空闲档继续: telemetry unavailable']);
  });

  test('parses nvidia-smi summary and process-monitor output', () => {
    expect(parseGpuSummary('42, 2048, 16384\r\n')).toEqual({
      utilization: 42,
      memoryUsedMb: 2048,
      memoryTotalMb: 16384
    });
    expect(parseGpuProcessMonitor([
      '# gpu        pid  type    sm   mem   enc   dec   jpg   ofa    fb   cc',
      '    0       1234     C    31     4     0     0     0     0  512   0  ffmpeg.exe'
    ].join('\n'))).toEqual([
      expect.objectContaining({ pid: 1234, sm: 31, mem: 4, name: 'ffmpeg.exe' })
    ]);
  });
});
