import { ConfigProvider } from '../../../../core/config/ConfigProvider';
import {
  MikufansSpeakerOnceRegistry,
  MikufansSummaryQueueManager,
  MikufansSummaryQueueWorker,
  MikufansSummaryQueueWorkerCallbacks,
  QueuedSummaryTask
} from './MikufansSummaryQueueWorker';
import { MikufansAsrResourceController } from './MikufansAsrResourceController';

function createTask(overrides: Partial<QueuedSummaryTask> = {}): QueuedSummaryTask {
  return {
    id: 'task-1',
    mediaPath: 'missing-recording.flv',
    roomId: 'room-1',
    status: 'pending',
    ...overrides
  };
}

function createCallbacks(): MikufansSummaryQueueWorkerCallbacks {
  return {
    handleDelayedReplyReadyOutput: jest.fn().mockResolvedValue(undefined),
    checkAndTriggerDelayedReply: jest.fn().mockResolvedValue(undefined),
    findSessionByVideoPath: jest.fn().mockReturnValue(undefined),
    markSessionCompleted: jest.fn()
  };
}

function createResources(): MikufansAsrResourceController {
  return {
    getConnection: jest.fn().mockReturnValue({ port: null, token: null }),
    isLegacyGpuBusy: jest.fn().mockResolvedValue({ busy: false, reason: '' }),
    isGameRunning: jest.fn().mockResolvedValue({ busy: false, reason: '', waitMs: 100 }),
    isAdaptiveGpuProtectionEnabled: jest.fn().mockReturnValue(false),
    ensurePersistentWorker: jest.fn().mockResolvedValue(undefined),
    stopPersistentWorker: jest.fn().mockResolvedValue(undefined)
  } as unknown as MikufansAsrResourceController;
}

function createQueue(
  nextTask: jest.Mock<QueuedSummaryTask | null, [] | [{ reload: boolean }]> = jest.fn().mockReturnValue(null)
): MikufansSummaryQueueManager {
  return {
    recoverInterruptedTasks: jest.fn().mockReturnValue(0),
    loadQueue: jest.fn(),
    hasActiveProcessing: jest.fn().mockReturnValue(false),
    getNextPendingTask: nextTask as MikufansSummaryQueueManager['getNextPendingTask'],
    addTask: jest.fn(),
    setTaskSpeakerRecognition: jest.fn(),
    markFailed: jest.fn(),
    getTaskById: jest.fn().mockReturnValue(null),
    markCompleted: jest.fn(),
    requeueAfterWorkerFailure: jest.fn().mockReturnValue(false)
  };
}

function createSpeakerRegistry(): MikufansSpeakerOnceRegistry {
  return { consume: jest.fn().mockReturnValue(null) };
}

async function settleWorker(worker: MikufansSummaryQueueWorker): Promise<void> {
  for (let attempt = 0; attempt < 8 && worker.isRunning(); attempt += 1) {
    await Promise.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe('MikufansSummaryQueueWorker', () => {
  beforeEach(() => {
    jest.spyOn(ConfigProvider, 'getConfig').mockReturnValue({
      whisper: { gpuDetection: { checkIntervalSeconds: 0.001 } },
      webhook: { timeouts: { processTimeout: 1000 } },
      asr: { default_backend: 'whisper' }
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts at most one loop and exits cleanly when the queue is empty', async () => {
    const queue = createQueue();
    const resources = createResources();
    const worker = new MikufansSummaryQueueWorker(
      createCallbacks(),
      resources,
      queue,
      createSpeakerRegistry()
    );

    worker.ensureRunning();
    worker.ensureRunning();
    expect(worker.isRunning()).toBe(true);

    await settleWorker(worker);

    expect(worker.isRunning()).toBe(false);
    expect(queue.recoverInterruptedTasks).toHaveBeenCalledTimes(1);
    // The finalizer performs one last race check for a task added while the
    // worker was releasing its ASR resources.
    expect(queue.getNextPendingTask).toHaveBeenCalledTimes(2);
    expect(resources.stopPersistentWorker).toHaveBeenCalledWith('ASR 队列已清空');
  });

  it('owns durable queue insertion for callers outside the legacy queue module', () => {
    const queue = createQueue();
    const task = createTask({ mediaPath: 'recording.flv' });
    (queue.addTask as jest.Mock).mockReturnValue(task);
    const worker = new MikufansSummaryQueueWorker(
      createCallbacks(),
      createResources(),
      queue,
      createSpeakerRegistry()
    );

    const result = worker.enqueueTask('recording.flv', 'room-1', {
      xmlPath: 'recording.xml',
      trackOwnershipWhilePending: false
    });

    expect(result).toBe(task);
    expect(queue.addTask).toHaveBeenCalledWith('recording.flv', 'room-1', {
      xmlPath: 'recording.xml',
      trackOwnershipWhilePending: false
    });
  });

  it('honors requestStop and does not restart during cleanup', async () => {
    const queue = createQueue();
    const pendingTask = createTask();
    (queue.getNextPendingTask as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(pendingTask);
    const worker = new MikufansSummaryQueueWorker(
      createCallbacks(),
      createResources(),
      queue,
      createSpeakerRegistry()
    );

    worker.ensureRunning();
    worker.requestStop();
    await settleWorker(worker);

    expect(worker.isRunning()).toBe(false);
    expect(queue.getNextPendingTask).toHaveBeenCalledTimes(1);
  });

  it('marks a missing media task failed and continues to the next task', async () => {
    const task = createTask({ mediaPath: 'definitely-missing-recording.flv' });
    const queue = createQueue();
    (queue.getNextPendingTask as jest.Mock)
      .mockReturnValueOnce(task)
      .mockReturnValueOnce(null);
    const resources = createResources();
    const worker = new MikufansSummaryQueueWorker(
      createCallbacks(),
      resources,
      queue,
      createSpeakerRegistry()
    );

    worker.ensureRunning();
    await settleWorker(worker);

    expect(queue.markFailed).toHaveBeenCalledWith(task.id, expect.stringContaining('媒体文件不存在'));
    expect(resources.ensurePersistentWorker).toHaveBeenCalledTimes(1);
    expect(worker.isRunning()).toBe(false);
  });
});
