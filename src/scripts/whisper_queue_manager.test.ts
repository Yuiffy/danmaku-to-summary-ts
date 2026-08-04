import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('WhisperQueueManager interrupted task recovery', () => {
  let tempDir: string;
  let queueFile: string;
  let lockFile: string;
  let WhisperQueueManager: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-queue-'));
    queueFile = path.join(tempDir, 'queue.json');
    lockFile = path.join(tempDir, 'lock.json');
    process.env.WHISPER_QUEUE_FILE = queueFile;
    process.env.WHISPER_LOCK_FILE = lockFile;
    jest.resetModules();
    ({ WhisperQueueManager } = require('./whisper_queue_manager.js'));
  });

  afterEach(() => {
    delete process.env.WHISPER_QUEUE_FILE;
    delete process.env.WHISPER_LOCK_FILE;
    jest.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeQueue(task: Record<string, unknown>): void {
    fs.writeFileSync(queueFile, JSON.stringify({ tasks: [task] }), 'utf8');
  }

  function createManager(config: Record<string, unknown> = {}): any {
    return new WhisperQueueManager({
      queueFile,
      lockFile,
      configLoader: {
        getConfig: () => ({
          webhook: {
            timeouts: { processTimeout: 30 * 60 * 1000 },
            queue: config
          }
        })
      },
      getSystemBootTimestamp: () => 2_000_000,
      isProcessAlive: () => false
    });
  }

  it('keeps stale processing tasks intact during load and explicitly recovers them', () => {
    const mediaPath = path.join(tempDir, 'stream.flv');
    fs.writeFileSync(mediaPath, 'video', 'utf8');
    writeQueue({
      id: 'task-1',
      mediaPath,
      addedTime: Date.now() - 60_000,
      startTime: Date.now() - 30_000,
      status: 'processing',
      ownerPid: 12345,
      ownerBootTime: 1_000_000
    });
    const manager = createManager({ maxRecoveryAttempts: 3 });

    expect(manager.getTaskById('task-1').status).toBe('processing');
    expect(manager.recoverInterruptedTasks()).toBe(1);
    expect(manager.getTaskById('task-1', { reload: true })).toEqual(expect.objectContaining({
      status: 'pending',
      recoveryCount: 1,
      lastRecoveryReason: 'owner_process_rebooted'
    }));
  });

  it('fails an interrupted task only after the bounded recovery count is exhausted', () => {
    const mediaPath = path.join(tempDir, 'stream.flv');
    fs.writeFileSync(mediaPath, 'video', 'utf8');
    writeQueue({
      id: 'task-2',
      mediaPath,
      addedTime: Date.now() - 60_000,
      status: 'processing',
      ownerPid: 12345,
      ownerBootTime: 1_000_000,
      recoveryCount: 3
    });
    const manager = createManager({ maxRecoveryAttempts: 3 });

    manager.recoverInterruptedTasks();

    expect(manager.getTaskById('task-2', { reload: true })).toEqual(expect.objectContaining({
      status: 'failed',
      recoveryCount: 4,
      error: 'interrupted_recovery_exhausted:owner_process_rebooted'
    }));
  });

  it('requeues nonzero worker exits and eventually marks the task failed', () => {
    const mediaPath = path.join(tempDir, 'stream.flv');
    fs.writeFileSync(mediaPath, 'video', 'utf8');
    writeQueue({
      id: 'task-3',
      mediaPath,
      addedTime: Date.now() - 60_000,
      status: 'processing'
    });
    const manager = createManager({ maxWorkerRetries: 2 });

    expect(manager.requeueAfterWorkerFailure('task-3', 'exit 1')).toBe(true);
    manager.markProcessing('task-3');
    expect(manager.requeueAfterWorkerFailure('task-3', 'exit 1')).toBe(true);
    manager.markProcessing('task-3');
    expect(manager.requeueAfterWorkerFailure('task-3', 'exit 1')).toBe(false);
    expect(manager.getTaskById('task-3', { reload: true })).toEqual(expect.objectContaining({
      status: 'failed',
      workerRetryCount: 3,
      error: 'worker_retry_exhausted:exit 1'
    }));
  });
});
