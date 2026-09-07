import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BilibiliConfigHelper } from './BilibiliConfigHelper';
import { DelayedReplyService } from './DelayedReplyService';
import { DelayedReplyStore } from './DelayedReplyStore';
import { BilibiliDynamic, DelayedReplyTask, DynamicType } from './interfaces/types';

describe('delayed reply timing and late events', () => {
  const now = new Date('2026-09-07T03:39:27.000Z');
  let directory: string;
  let store: DelayedReplyStore;
  let service: any;
  let task: DelayedReplyTask;
  let publishComment: jest.Mock;
  let getDynamics: jest.Mock;
  let scheduleTask: jest.SpyInstance;

  function dynamic(ageMinutes: number, id = 'dynamic'): BilibiliDynamic {
    return {
      id, uid: 'anchor', type: DynamicType.WORD, content: 'Good night',
      publishTime: new Date(Date.now() - ageMinutes * 60_000),
      url: `https://www.bilibili.com/opus/${id}`
    };
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-timing-'));
    store = new DelayedReplyStore(path.join(directory, 'tasks.json'));
    await store.initialize();
    task = {
      taskId: 'task', roomId: '31368705', uid: 'anchor',
      goodnightTextPath: path.join(directory, 'goodnight.md'),
      comicImagePath: path.join(directory, 'comic.png'),
      createTime: new Date(now.getTime() - 22 * 60_000),
      liveEndTime: new Date(now.getTime() - 30 * 60_000),
      scheduledTime: now, status: 'pending', retryCount: 0, checkCount: 10
    };
    fs.writeFileSync(task.goodnightTextPath, 'Good night', 'utf8');
    await store.addTask(task);
    publishComment = jest.fn().mockResolvedValue({ replyId: 'main', replyTime: now.getTime() });
    getDynamics = jest.fn().mockResolvedValue([dynamic(9)]);
    service = new DelayedReplyService({ publishComment, getDynamics } as any, store);
    service.tasks.set(task.taskId, task);
    scheduleTask = jest.spyOn(service, 'scheduleTask').mockImplementation(() => undefined);
    jest.spyOn(service, 'getRoomLiveStatusSafely').mockResolvedValue(null);
    jest.spyOn(BilibiliConfigHelper, 'getSummaryDynamicSettings').mockReturnValue(null);
    jest.spyOn(BilibiliConfigHelper, 'getAnchorUid').mockReturnValue('anchor');
    jest.spyOn(BilibiliConfigHelper, 'getDelayedReplySettings').mockReturnValue({
      enabled: true, anchorEnabled: true, delayMinutes: 2
    } as any);
    jest.spyOn(BilibiliConfigHelper, 'getDelayedReplyConfig').mockReturnValue({
      enabled: true, delayMinutes: 2, maxRetries: 3, retryDelayMinutes: 5,
      maxTaskAgeHours: 24
    } as any);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function restoreService(): Promise<any> {
    const restoredStore = new DelayedReplyStore(path.join(directory, 'tasks.json'));
    await restoredStore.initialize();
    const restored: any = new DelayedReplyService({ publishComment, getDynamics } as any, restoredStore);
    jest.spyOn(restored, 'scheduleTask').mockImplementation(() => undefined);
    jest.spyOn(restored, 'getRoomLiveStatusSafely').mockResolvedValue(null);
    await restored.loadTasks();
    return restored;
  }

  it('waits beyond five checks on an old fallback dynamic, including after restart', async () => {
    getDynamics.mockResolvedValue([dynamic(530, '1245034366844796937')]);
    task.comicWaitCount = 5;
    await service.executeDelayedReply(task);
    expect(publishComment).not.toHaveBeenCalled();
    expect(task.status).toBe('pending');
    expect(task.comicWaitCount).toBe(6);

    const restored = await restoreService();
    const restoredTask = restored.getTasks()[0];
    fs.writeFileSync(task.comicImagePath!, 'image');
    jest.setSystemTime(task.scheduledTime);
    await restored.executeDelayedReply(restoredTask);
    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(publishComment).toHaveBeenCalledWith(expect.objectContaining({
      dynamicId: '1245034366844796937', images: [task.comicImagePath]
    }));
  });

  it('keeps waiting when success metadata appears before the image file', async () => {
    fs.writeFileSync(path.join(directory, 'comic_META.json'), JSON.stringify({ status: 'success' }));
    await service.executeDelayedReply(task);
    expect(publishComment).not.toHaveBeenCalled();
    expect(task.status).toBe('pending');
  });

  it('can switch from waiting on an old dynamic to a genuinely fresh dynamic', async () => {
    getDynamics.mockResolvedValueOnce([dynamic(530)]).mockResolvedValueOnce([dynamic(530)]);
    await service.executeDelayedReply(task);
    expect(publishComment).not.toHaveBeenCalled();
    getDynamics.mockResolvedValue([dynamic(1, 'new-dynamic')]);
    jest.setSystemTime(task.scheduledTime);
    await service.executeDelayedReply(task);
    expect(publishComment).toHaveBeenCalledWith(expect.objectContaining({
      dynamicId: 'new-dynamic', images: undefined
    }));
    expect(task.status).toBe('waiting_comic');
  });

  it('does not treat a future timestamp as a first-wave opportunity', () => {
    expect(service.policy.isWithinFirstReplyWave(dynamic(-10))).toBe(false);
  });

  it.each(['target', 'fallback'])('chooses the latest %s dynamic by publish time, not pinned feed order', async kind => {
    const old = dynamic(kind === 'target' ? 20 : 600, 'pinned');
    const latest = dynamic(kind === 'target' ? 1 : 530, 'latest');
    getDynamics.mockResolvedValue([old, latest]);
    const result = kind === 'target'
      ? await service.findTargetDynamic(task)
      : await service.getLatestDynamic(task.uid);
    expect(result.id).toBe('latest');
  });

  it('expires a task before active-live deferral can extend it indefinitely', async () => {
    task.liveEndTime = new Date(now.getTime() - 25 * 60 * 60_000);
    service.getRoomLiveStatusSafely.mockResolvedValue({ isLive: true, liveStatus: 1 });
    await service.executeDelayedReply(task);
    expect(publishComment).not.toHaveBeenCalled();
    expect(task.status).toBe('completed');
    expect(task.error).toContain('stale');
    expect(scheduleTask).not.toHaveBeenCalled();
  });

  it('merges a late comic path into a pending text task without resetting its clocks', async () => {
    const comicImagePath = task.comicImagePath;
    task.comicImagePath = '';
    const taskId = await service.addTask(task.roomId, task.goodnightTextPath, comicImagePath);
    expect(taskId).toBe(task.taskId);
    expect(task.comicImagePath).toBe(comicImagePath);
    expect(task.createTime.getTime()).toBe(now.getTime() - 22 * 60_000);
    expect(task.checkCount).toBe(10);
    expect(service.getTasks()).toHaveLength(1);
  });

  it('serializes concurrent text and comic ready events into one task with its image intent', async () => {
    service.tasks.clear();
    getDynamics.mockResolvedValue([]);
    const ids = await Promise.all([
      service.addTask(task.roomId, task.goodnightTextPath, ''),
      service.addTask(task.roomId, task.goodnightTextPath, task.comicImagePath)
    ]);
    expect(new Set(ids).size).toBe(1);
    expect(service.getTasks()).toHaveLength(1);
    expect(service.getTasks()[0].comicImagePath).toBe(task.comicImagePath);
  });

  it('does not send another comic after a combined reply and a late process-close event', async () => {
    fs.writeFileSync(task.comicImagePath!, 'image');
    await service.executeDelayedReply(task);
    const restored = await restoreService();
    const taskId = await restored.addTask(task.roomId, task.goodnightTextPath, task.comicImagePath);
    const restoredTask = restored.getTasks().find((candidate: DelayedReplyTask) => candidate.taskId === taskId);
    expect(restoredTask.status).toBe('completed');
    expect(restoredTask.mainReplyHasImage).toBe(true);
    await restored.executeDelayedReply(restoredTask);
    expect(publishComment).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a late text-only event after a combined reply', async () => {
    fs.writeFileSync(task.comicImagePath!, 'image');
    await service.executeDelayedReply(task);
    const taskId = await service.addTask(task.roomId, task.goodnightTextPath, '');
    expect(taskId).toBe(task.taskId);
    expect(service.getTasks()).toHaveLength(1);
  });

  it('preserves image readiness received while a text-only main reply is in flight', async () => {
    const comicImagePath = task.comicImagePath;
    task.comicImagePath = '';
    getDynamics.mockResolvedValue([dynamic(1)]);
    publishComment.mockImplementationOnce(async () => {
      fs.writeFileSync(comicImagePath!, 'image');
      await service.addTask(task.roomId, task.goodnightTextPath, comicImagePath);
      return { replyId: 'main', replyTime: Date.now() };
    });
    await service.executeDelayedReply(task);
    expect(task.comicImagePath).toBe(comicImagePath);
    expect(task.status).toBe('waiting_comic');
    expect(publishComment).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit delay even when a fresh dynamic already exists', async () => {
    service.tasks.clear();
    getDynamics.mockResolvedValue([dynamic(1)]);
    await service.addTask(task.roomId, task.goodnightTextPath, '', 3600);
    await jest.advanceTimersByTimeAsync(1);
    expect(publishComment).not.toHaveBeenCalled();
    expect(scheduleTask).toHaveBeenCalled();
    expect(service.getTasks()[0].scheduledTime.getTime()).toBe(now.getTime() + 3600_000);
  });

  it('publishes a deliberate text-only task without inventing an image dependency', async () => {
    task.comicImagePath = '';
    getDynamics.mockResolvedValue([dynamic(530)]);
    await service.executeDelayedReply(task);
    expect(task.status).toBe('completed');
    expect(task.mainReplyHasImage).toBe(false);
    expect(publishComment).toHaveBeenCalledTimes(1);
  });

  it('does not downgrade a successful main reply to a main retry when a follow-up fails', async () => {
    fs.writeFileSync(task.comicImagePath!, 'image');
    jest.spyOn(service, 'executeSummaryDynamicReply').mockRejectedValueOnce(new Error('follow-up unavailable'));
    await service.executeDelayedReply(task);
    expect(task.replyId).toBe('main');
    expect(task.status).not.toBe('pending');
    jest.setSystemTime(task.scheduledTime);
    await service.executeDelayedReply(task);
    expect(publishComment).toHaveBeenCalledTimes(1);
  });

  it('restores processing tasks interrupted before any publication was started', async () => {
    await store.updateTask(task.taskId, { status: 'processing', mainReplyState: 'ready' });
    const restored = await restoreService();
    expect(restored.getTasks()[0].status).toBe('pending');
    expect(restored.scheduleTask).toHaveBeenCalledTimes(1);
  });

  it('stops an uncertain main publication on restart instead of resending it', async () => {
    await store.updateTask(task.taskId, {
      status: 'processing', mainReplyState: 'publishing'
    });
    const restored = await restoreService();
    const restoredTask = restored.getTasks()[0];
    expect(restoredTask.status).toBe('failed');
    expect(restoredTask.error).toContain('outcome is unknown');
    expect(restored.scheduleTask).not.toHaveBeenCalled();
    expect(publishComment).not.toHaveBeenCalled();
    expect(await restored.addTask(task.roomId, task.goodnightTextPath, task.comicImagePath)).toBe(task.taskId);
    expect(restored.getTasks()).toHaveLength(1);
  });

  it('does not assume legacy processing tasks were interrupted before sending', async () => {
    await store.updateTask(task.taskId, { status: 'processing' });
    const restored = await restoreService();
    expect(restored.getTasks()[0].mainReplyState).toBe('unknown');
    expect(restored.scheduleTask).not.toHaveBeenCalled();
  });

  it('keeps a durable publishing marker when persisting the successful receipt fails', async () => {
    fs.writeFileSync(task.comicImagePath!, 'image');
    const update = store.updateTask.bind(store);
    jest.spyOn(store, 'updateTask').mockImplementation(async (id, changes) => {
      if (changes.replyId) throw new Error('disk unavailable');
      await update(id, changes);
    });
    publishComment.mockImplementationOnce(async () => {
      const saved = JSON.parse(fs.readFileSync(path.join(directory, 'tasks.json'), 'utf8'));
      expect(saved.tasks[0].mainReplyState).toBe('publishing');
      return { replyId: 'main', replyTime: Date.now() };
    });
    await expect(service.executeDelayedReply(task)).rejects.toThrow('disk unavailable');
    const restored = await restoreService();
    expect(restored.getTasks()[0].mainReplyState).toBe('unknown');
    expect(publishComment).toHaveBeenCalledTimes(1);
  });

  it('still retries a rejected main reply, without resetting image wait intent', async () => {
    fs.writeFileSync(task.comicImagePath!, 'image');
    publishComment.mockRejectedValueOnce(new Error('temporary rejection'));
    await service.executeDelayedReply(task);
    expect(task.status).toBe('pending');
    expect(task.mainReplyState).toBe('ready');
    jest.setSystemTime(task.scheduledTime);
    await service.executeDelayedReply(task);
    expect(task.mainReplyState).toBe('published');
    expect(publishComment).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite producer metadata when supplemental waiting times out', async () => {
    const metaPath = path.join(directory, 'comic_META.json');
    const meta = { status: 'pending', jobId: 'image-job' };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    Object.assign(task, { status: 'waiting_comic', replyId: 'main', repliedDynamicId: 'dynamic', comicWaitCount: 29 });
    await service.executeDelayedReply(task);
    expect(JSON.parse(fs.readFileSync(metaPath, 'utf8'))).toEqual(meta);
    expect(publishComment).not.toHaveBeenCalled();
  });

  it('does not randomly skip Miting comic generation in production', () => {
    const configPath = path.resolve(__dirname, '../../../config/production.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.ai.roomSettings['31368705'].comicGenerationProbability).toBe(1);
  });
});
