import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { ConfigProvider } from '../../../../core/config/ConfigProvider';
import { terminateProcessTree } from '../../../../utils/processCleanup';
import { ProcessingAlertService } from '../../../monitoring/ProcessingAlertService';
import { MikufansAsrResourceController } from './MikufansAsrResourceController';
import { MikufansSummaryQueueManager, MikufansSummaryQueueWorker, QueuedSummaryTask } from './MikufansSummaryQueueWorker';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawn: jest.fn() }));
jest.mock('../../../../utils/ffmpegResource', () => ({
  applyFfmpegProcessPriority: jest.fn(), getFfmpegResourceConfig: () => ({ threads: 1, priority: 'idle' })
}));
jest.mock('../../../../utils/processCleanup', () => ({
  terminateProcessTree: jest.fn().mockResolvedValue(undefined), listRelevantProcesses: jest.fn().mockResolvedValue([])
}));

describe('summary worker terminal failure notifications', () => {
  let task: QueuedSummaryTask;
  let queue: MikufansSummaryQueueManager;
  let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number };
  let worker: MikufansSummaryQueueWorker;
  let notify: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    task = { id: 'same-task', roomId: '25788785', status: 'processing', mediaPath: 'failure-fixture.flv', recoveryHistory: [{}] };
    child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 12345 });
    (spawn as jest.Mock).mockReset().mockReturnValue(child);
    (terminateProcessTree as jest.Mock).mockResolvedValue(undefined);
    jest.spyOn(ConfigProvider, 'getConfig').mockReturnValue({ webhook: { timeouts: { processTimeout: 1000 } } } as any);
    const exists = fs.existsSync;
    jest.spyOn(require('fs') as typeof fs, 'existsSync').mockImplementation(file => String(file).startsWith('failure-fixture.')
      ? String(file).endsWith('.flv') : exists(file));
    const stat = fs.statSync;
    jest.spyOn(require('fs') as typeof fs, 'statSync').mockImplementation(((file: fs.PathLike) => String(file) === task.mediaPath
      ? { isFile: () => true } : stat(file)) as typeof fs.statSync);
    notify = jest.spyOn(ProcessingAlertService, 'notifySummaryTaskFailed').mockResolvedValue(undefined);
    jest.spyOn(ProcessingAlertService, 'notifyIfSlowStage').mockResolvedValue(undefined);
    queue = {
      recoverInterruptedTasks: jest.fn(), loadQueue: jest.fn(), hasActiveProcessing: jest.fn(),
      getNextPendingTask: jest.fn(), addTask: jest.fn(), setTaskSpeakerRecognition: jest.fn(),
      markFailed: jest.fn(() => { task.status = 'failed'; }),
      getTaskById: jest.fn(() => ({ ...task })), markCompleted: jest.fn(),
      requeueAfterWorkerFailure: jest.fn(() => { task.status = 'failed'; task.workerRetryCount = 3; return false; })
    };
    worker = new MikufansSummaryQueueWorker({
      handleDelayedReplyReadyOutput: jest.fn().mockResolvedValue(undefined),
      checkAndTriggerDelayedReply: jest.fn().mockResolvedValue(undefined),
      findSessionByVideoPath: jest.fn(), markSessionCompleted: jest.fn()
    }, { getConnection: () => ({ port: null, token: null }) } as unknown as MikufansAsrResourceController,
    queue, { consume: () => null });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const execute = () => (worker as any).executeTask(task) as Promise<void>;

  it('reports a missing input without spawning or requeueing', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    await execute();
    expect(spawn).not.toHaveBeenCalled();
    expect(queue.requeueAfterWorkerFailure).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ stage: 'prepare', reason: expect.stringContaining('媒体文件不存在') }));
  });

  it('reports a synchronous spawn failure', async () => {
    (spawn as jest.Mock).mockImplementationOnce(() => { throw new Error('invalid spawn configuration'); });
    await execute();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('invalid spawn configuration') }));
  });

  it('reports a spawn error once and prevents the following close from requeueing it', async () => {
    const running = execute();
    child.emit('error', new Error('spawn node ENOENT'));
    child.emit('close', -4058);
    await running;
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ recoveryEpisode: 1, reason: expect.stringContaining('ENOENT') }));
    expect(queue.requeueAfterWorkerFailure).not.toHaveBeenCalled();
    expect(queue.markCompleted).not.toHaveBeenCalled();
  });

  it('retains split stderr root causes on exhaustion and carries duration and recovery identity', async () => {
    const running = execute();
    child.stdout.write('-> [ASR] Generating Subtitles\n-> 283:49,726\n');
    child.stderr.write('Traceback:\nValueError: Aligned audio ended ');
    child.stderr.write('early; checkpoint not advanced\n');
    child.emit('close', 1);
    await running;
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'same-task', recoveryEpisode: 1, retryCount: 3, stage: 'asr', durationSeconds: 17029.726,
      reason: expect.stringContaining('ValueError: Aligned audio ended early; checkpoint not advanced')
    }));
    expect(queue.requeueAfterWorkerFailure).toHaveBeenCalledWith('same-task', expect.stringContaining('checkpoint not advanced'));
  });

  it('does not notify during an ordinary automatic retry', async () => {
    (queue.requeueAfterWorkerFailure as jest.Mock).mockImplementation(() => { task.status = 'pending'; return true; });
    const running = execute();
    child.emit('close', 1);
    await running;
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(['completed', 'completed_with_cleanup_crash'])('does not mistake %s for exhausted retries', async status => {
    (queue.requeueAfterWorkerFailure as jest.Mock).mockImplementation(() => { task.status = status; return false; });
    const running = execute();
    child.emit('close', 1);
    await running;
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not notify on success', async () => {
    const running = execute();
    child.emit('close', 0);
    await running;
    expect(queue.markCompleted).toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports postprocess failures after releasing the ASR slot', async () => {
    const running = execute();
    child.stdout.write('[[ASR_PHASE_DONE]] taskId=same-task\n');
    await running;
    expect(notify).not.toHaveBeenCalled();
    child.emit('close', 1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ stage: 'postprocess' }));
  });

  it('handles close during timeout cleanup without requeueing or marking successful', async () => {
    (terminateProcessTree as jest.Mock).mockImplementationOnce(async () => { child.emit('close', 0); });
    const running = execute();
    await jest.advanceTimersByTimeAsync(1000);
    await running;
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('超过 1 秒') }));
    expect(queue.markCompleted).not.toHaveBeenCalled();
    expect(queue.requeueAfterWorkerFailure).not.toHaveBeenCalled();
  });

  it('does not let notification failure block the worker or requeue a terminal task', async () => {
    notify.mockRejectedValue(new Error('WeCom unavailable'));
    const running = execute();
    child.emit('close', 1);
    await running;
    expect(queue.requeueAfterWorkerFailure).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
