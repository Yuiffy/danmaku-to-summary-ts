import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as vm from 'vm';

const scriptPath = path.join(__dirname, 'enhanced_auto_summary.js');
const source = ts.createSourceFile(scriptPath, fs.readFileSync(scriptPath, 'utf8'), ts.ScriptTarget.Latest, true);
const acquireLock = source.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'acquireWhisperLock'
)!;

function runAdmission(cpu: boolean, options: { queueWait?: boolean; lockWait?: boolean } = {}) {
  let locked = Boolean(options.lockWait);
  const sleeps: number[] = [];
  const queue = {
    touchTask: jest.fn(),
    isTaskNext: jest.fn().mockReturnValue(true),
    getPendingPosition: jest.fn().mockReturnValue(2)
  };
  if (options.queueWait) queue.isTaskNext.mockReturnValueOnce(false);
  const open = jest.fn(() => {
    if (locked) throw Object.assign(new Error('held'), { code: 'EEXIST' });
    locked = true;
    return 7;
  });
  const gpu = jest.fn().mockResolvedValueOnce({ busy: true, reason: 'GPU 95%' })
    .mockResolvedValue({ busy: false, reason: 'idle' });
  const release = jest.fn(() => { locked = false; });
  const result: Promise<void> = vm.runInNewContext(
    `${acquireLock.getText(source)}; acquireWhisperLock('task-1')`, {
      process: { pid: 100, argv: ['node', 'script', 'fixture.wav'], env: cpu ? { ASR_CPU_FALLBACK: '1' } : {} },
      path, Date, console: { log: jest.fn(), warn: jest.fn() }, queueManager: queue,
      WHISPER_LOCK_FILE: 'in-memory-lock', WHISPER_MAX_RETRIES: 4,
      WHISPER_PROGRESS_LOG_INTERVAL: 30000, WHISPER_QUEUE_TURN_RETRY_INTERVAL: 5000,
      WHISPER_LOCK_RETRY_INTERVAL: 10000, getSystemBootTimestamp: () => 1,
      configLoader: { getConfig: () => ({ whisper: { gpuDetection: { checkIntervalSeconds: 30 } } }) },
      isGpuBusy: gpu, releaseWhisperLock: release, getInvalidLockReason: () => null,
      fs: { openSync: open, writeSync: jest.fn(), closeSync: jest.fn(),
        readFileSync: () => JSON.stringify({ pid: 99, timestamp: Date.now() }) },
      setTimeout: (callback: () => void, duration: number) => {
        sleeps.push(duration);
        if (options.lockWait) locked = false;
        callback();
      }
    });
  return { result, gpu, release, open, sleeps, queue, isLocked: () => locked };
}

describe('summary CLI CPU admission', () => {
  test('starts a CPU-admitted job without polling or waiting for a busy GPU', async () => {
    const admission = runAdmission(true);
    await admission.result;
    expect(admission.gpu).not.toHaveBeenCalled();
    expect(admission.release).not.toHaveBeenCalled();
    expect(admission.sleeps).toEqual([]);
    expect(admission.isLocked()).toBe(true);
  });

  test('retains GPU waiting for ordinary jobs', async () => {
    const admission = runAdmission(false);
    await admission.result;
    expect(admission.gpu).toHaveBeenCalledTimes(2);
    expect(admission.release).toHaveBeenCalledTimes(1);
    expect(admission.sleeps).toEqual([30000]);
    expect(admission.isLocked()).toBe(true);
  });

  test('CPU admission still waits for its queue turn', async () => {
    const admission = runAdmission(true, { queueWait: true });
    await admission.result;
    expect(admission.queue.isTaskNext).toHaveBeenCalledTimes(2);
    expect(admission.open).toHaveBeenCalledTimes(1);
    expect(admission.sleeps).toEqual([5000]);
    expect(admission.gpu).not.toHaveBeenCalled();
  });

  test('CPU admission still waits for another ASR owner to release the lock', async () => {
    const admission = runAdmission(true, { lockWait: true });
    await admission.result;
    expect(admission.open).toHaveBeenCalledTimes(2);
    expect(admission.sleeps).toEqual([10000]);
    expect(admission.gpu).not.toHaveBeenCalled();
    expect(admission.isLocked()).toBe(true);
  });
});
