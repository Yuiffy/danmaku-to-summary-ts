import { ConfigProvider } from '../../../../core/config/ConfigProvider';
import {
  MikufansSpeakerOnceRegistry,
  MikufansSummaryQueueManager,
  MikufansSummaryQueueWorker,
  MikufansSummaryQueueWorkerCallbacks,
  QueuedSummaryTask
} from './MikufansSummaryQueueWorker';
import { MikufansAsrResourceController } from './MikufansAsrResourceController';
import { ProcessingAlertService } from '../../../monitoring/ProcessingAlertService';

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
    jest.spyOn(ProcessingAlertService, 'notifySummaryTaskFailed').mockResolvedValue(undefined);
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
    expect(resources.stopPersistentWorker).toHaveBeenCalledWith('队列 worker 退出');
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

  it.each(['game', 'gpu'])('uses one CPU task while %s is busy with the reusable worker', async busy => {
    jest.spyOn(require('os'), 'freemem').mockReturnValue(32 * 1024 ** 3);
    (ConfigProvider.getConfig as jest.Mock).mockReturnValue({
      asr: { default_backend: 'paraformer', cpu_fallback: { enabled: true, min_available_memory_gb: 4 } },
      whisper: { gpuDetection: { checkIntervalSeconds: 0.001 } }
    });
    const queue = createQueue(jest.fn().mockReturnValueOnce(createTask()).mockReturnValue(null));
    const resources = createResources();
    if (busy === 'game') (resources.isGameRunning as jest.Mock).mockResolvedValue({ busy: true, reason: 'game', waitMs: 100 });
    else (resources.isLegacyGpuBusy as jest.Mock).mockResolvedValue({ busy: true, reason: 'gpu' });
    const worker = new MikufansSummaryQueueWorker(createCallbacks(), resources, queue, createSpeakerRegistry());
    const execute = jest.spyOn(worker as any, 'executeTask').mockResolvedValue(undefined);
    worker.ensureRunning();
    await settleWorker(worker);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }), true);
    expect(resources.ensurePersistentWorker).toHaveBeenCalledTimes(1);
    expect(worker.isRunning()).toBe(false);
  });

  it('keeps the queue and resident worker alive during the configured idle window', async () => {
    (ConfigProvider.getConfig as jest.Mock).mockReturnValue({
      asr: {
        paraformer: { persistent_worker: { idle_timeout_s: 0.05 } },
        default_backend: 'paraformer',
        cpu_fallback: { enabled: true, min_available_memory_gb: 4 }
      },
      whisper: { gpuDetection: { checkIntervalSeconds: 0.005 } },
      webhook: { timeouts: { processTimeout: 1000 } }
    });
    const task = createTask();
    const queue = createQueue(jest.fn()
      .mockReturnValueOnce(task)
      .mockReturnValue(null));
    const resources = createResources();
    const worker = new MikufansSummaryQueueWorker(createCallbacks(), resources, queue, createSpeakerRegistry());
    jest.spyOn(worker as any, 'executeTask').mockResolvedValue(undefined);

    worker.ensureRunning();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(worker.isRunning()).toBe(true);
    expect(resources.stopPersistentWorker).not.toHaveBeenCalled();

    await new Promise(resolve => setTimeout(resolve, 70));
    await settleWorker(worker);
    expect(worker.isRunning()).toBe(false);
    expect(resources.stopPersistentWorker).toHaveBeenCalledWith('队列 worker 退出');
  });

  it('wakes an idle loop when a new task is enqueued and keeps the same worker alive', async () => {
    (ConfigProvider.getConfig as jest.Mock).mockReturnValue({
      asr: {
        paraformer: { persistent_worker: { idle_timeout_s: 1 } },
        default_backend: 'paraformer',
        cpu_fallback: { enabled: true, min_available_memory_gb: 4 }
      },
      whisper: { gpuDetection: { checkIntervalSeconds: 30 } },
      webhook: { timeouts: { processTimeout: 1000 } }
    });
    let pending: QueuedSummaryTask | null = null;
    const queue = createQueue(jest.fn().mockImplementation(() => pending));
    (queue.addTask as jest.Mock).mockImplementation(() => pending);
    const resources = createResources();
    const worker = new MikufansSummaryQueueWorker(createCallbacks(), resources, queue, createSpeakerRegistry());
    const execute = jest.spyOn(worker as any, 'executeTask').mockImplementation(async () => {
      pending = null;
    });

    worker.ensureRunning();
    await new Promise(resolve => setImmediate(resolve));
    expect(worker.isRunning()).toBe(true);

    pending = createTask({ id: 'task-2' });
    worker.enqueueTask('recording-2.flv', 'room-1');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-2' }));
    expect(resources.stopPersistentWorker).not.toHaveBeenCalled();

    worker.requestStop();
    await settleWorker(worker);
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
