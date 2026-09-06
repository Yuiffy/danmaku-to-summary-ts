import { DelayedReplyService } from './DelayedReplyService';
import { BilibiliDynamic, DelayedReplyTask, DynamicType } from './interfaces/types';
import { BilibiliConfigHelper } from './BilibiliConfigHelper';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('DelayedReplyService duplicate reply detection', () => {
  function createService(): DelayedReplyService {
    return new DelayedReplyService(
      {} as any,
      {} as any
    );
  }

  function createTask(overrides: Partial<DelayedReplyTask>): DelayedReplyTask {
    return {
      taskId: 'task-1',
      roomId: '27628030',
      goodnightTextPath: 'goodnight.md',
      comicImagePath: 'comic.png',
      createTime: new Date(Date.now() - 60 * 1000),
      scheduledTime: new Date(),
      status: 'waiting_comic',
      retryCount: 0,
      repliedDynamicId: '1222379810217525253',
      replyId: '305238656897',
      completedAt: new Date(Date.now() - 30 * 1000),
      ...overrides
    };
  }

  it('treats waiting_comic tasks with a main reply as already replied', () => {
    const service = createService() as any;
    const repliedTask = createTask({});

    service.tasks.set(repliedTask.taskId, repliedTask);

    const duplicate = service.findRecentCompletedReply(
      '27628030',
      '1222379810217525253',
      'task-2'
    );

    expect(duplicate).toBe(repliedTask);
  });

  it('keeps a partial recording task deferred after the active-live limit', async () => {
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({} as any, store as any) as any;
    const scheduleTask = jest.spyOn(service, 'scheduleTask').mockImplementation(() => undefined);
    const task = createTask({
      taskId: 'partial-task',
      status: 'pending',
      replyId: undefined,
      deferredForActiveLive: true,
      activeLiveDeferCount: 60,
      liveContinuationWaitCount: 0
    });

    await service.deferTaskForActiveLive(task, {
      isLive: true,
      liveStatus: 1,
      liveStartTime: new Date()
    });

    expect(task.status).toBe('pending');
    expect(task.deferredForActiveLive).toBe(true);
    expect(task.activeLiveDeferCount).toBe(61);
    expect(task.liveContinuationWaitCount).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith(task.taskId, expect.objectContaining({
      status: 'pending',
      deferredForActiveLive: true,
      activeLiveDeferCount: 61,
      liveContinuationWaitCount: 1
    }));
    expect(scheduleTask).toHaveBeenCalledWith(task);
  });

  it('does not treat a later live as the historical task live', () => {
    const service = createService() as any;
    const task = createTask({
      createTime: new Date('2026-08-11T20:09:25.000+08:00'),
      liveStartTime: new Date('2026-08-11T15:03:07.000+08:00'),
      liveEndTime: new Date('2026-08-11T17:09:31.610+08:00')
    });

    const sameLive = service.policy.isSameActiveLiveForTask(task, {
      isLive: true,
      liveStatus: 1,
      liveStartTime: new Date('2026-08-11T20:05:20.000+08:00')
    });

    expect(sameLive).toBe(false);
  });

  it('does not suppress a newer final recording because an earlier partial task replied', () => {
    const service = createService() as any;
    const partialTask = createTask({
      taskId: 'partial-task',
      liveEndTime: new Date('2026-08-08T12:05:00.000Z')
    });
    const finalTask = createTask({
      taskId: 'final-task',
      liveEndTime: new Date('2026-08-08T17:32:00.000Z')
    });
    service.tasks.set(partialTask.taskId, partialTask);
    service.tasks.set(finalTask.taskId, finalTask);

    const duplicate = service.findRecentCompletedReply(
      finalTask.roomId,
      finalTask.repliedDynamicId,
      finalTask.taskId,
      finalTask
    );

    expect(duplicate).toBeNull();
  });

  it('reattaches a recovered comic to a completed text task without creating another reply task', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-reply-recovered-comic-'));
    const goodnightTextPath = path.join(outputDir, 'stream_晚安回复.md');
    const comicImagePath = path.join(outputDir, 'stream_COMIC_FACTORY.png');
    fs.writeFileSync(goodnightTextPath, '晚安正文', 'utf8');
    fs.writeFileSync(comicImagePath, 'image', 'utf8');

    const store = {
      updateTask: jest.fn().mockResolvedValue(undefined),
      addTask: jest.fn().mockResolvedValue(undefined)
    };
    const service = new DelayedReplyService({} as any, store as any) as any;
    const scheduleTask = jest.spyOn(service, 'scheduleTask').mockImplementation(() => undefined);
    const delayedReplySettingsSpy = jest.spyOn(BilibiliConfigHelper, 'getDelayedReplySettings').mockReturnValue({
      enabled: true,
      anchorEnabled: true,
      delayMinutes: 2
    } as any);
    const completedTask = createTask({
      taskId: 'completed-text-task',
      goodnightTextPath,
      comicImagePath: '',
      status: 'completed',
      comicWaitCount: 30,
      error: '补图等待达到上限'
    });
    service.tasks.set(completedTask.taskId, completedTask);

    try {
      const taskId = await service.addTask(completedTask.roomId, goodnightTextPath, comicImagePath);

      expect(taskId).toBe(completedTask.taskId);
      expect(completedTask.status).toBe('waiting_comic');
      expect(completedTask.comicImagePath).toBe(comicImagePath);
      expect(completedTask.comicWaitCount).toBe(0);
      expect(completedTask.error).toBeUndefined();
      expect(store.addTask).not.toHaveBeenCalled();
      expect(store.updateTask).toHaveBeenCalledWith(completedTask.taskId, expect.objectContaining({
        status: 'waiting_comic',
        comicImagePath,
        comicWaitCount: 0,
        error: undefined
      }));
      expect(scheduleTask).toHaveBeenCalledWith(completedTask);
    } finally {
      delayedReplySettingsSpy.mockRestore();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('recovers a persisted completed task by id and publishes only the supplemental comic reply', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-reply-recovered-by-id-'));
    const goodnightTextPath = path.join(outputDir, 'stream_晚安回复.md');
    const comicImagePath = path.join(outputDir, 'stream_COMIC_FACTORY.png');
    fs.writeFileSync(goodnightTextPath, '晚安正文', 'utf8');
    fs.writeFileSync(comicImagePath, 'image', 'utf8');

    const completedTask = createTask({
      taskId: 'persisted-completed-task',
      goodnightTextPath,
      comicImagePath: '',
      status: 'completed',
      summaryReplyId: 'existing-summary-reply',
      summaryCompletedAt: new Date()
    });
    const publishComment = jest.fn().mockResolvedValue({
      replyId: 'supplemental-reply',
      replyTime: Date.now(),
      imageUrl: 'https://example.com/image.png'
    });
    const store = {
      getTask: jest.fn().mockResolvedValue(completedTask),
      updateTask: jest.fn().mockResolvedValue(undefined)
    };
    const service = new DelayedReplyService({ publishComment } as any, store as any);
    const summarySettingsSpy = jest.spyOn(BilibiliConfigHelper, 'getSummaryDynamicSettings').mockReturnValue({
      enabled: true,
      dynamicId: 'summary-dynamic'
    });

    try {
      const result = await service.recoverComicForTask(completedTask.taskId, comicImagePath);

      expect(result.taskId).toBe(completedTask.taskId);
      expect(result.status).toBe('completed');
      expect(result.supplementalReplyId).toBe('supplemental-reply');
      expect(publishComment).toHaveBeenCalledTimes(1);
      expect(publishComment).toHaveBeenCalledWith({
        dynamicId: completedTask.repliedDynamicId,
        content: '（补图）晚安正文',
        images: [comicImagePath]
      });
      expect(store.updateTask).toHaveBeenCalledWith(completedTask.taskId, expect.objectContaining({
        status: 'waiting_comic',
        comicImagePath,
        comicWaitCount: 0
      }));
      expect(store.updateTask).toHaveBeenCalledWith(completedTask.taskId, expect.objectContaining({
        status: 'waiting_summary',
        supplementalReplyId: 'supplemental-reply'
      }));
    } finally {
      summarySettingsSpy.mockRestore();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('notifies WeChat Work with persisted async image failure details once', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-reply-comic-failure-'));
    const comicImagePath = path.join(outputDir, 'stream_COMIC_FACTORY.png');
    const metaPath = path.join(outputDir, 'stream_COMIC_FACTORY_META.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      status: 'failure',
      provider: 'tuzi',
      model: 'gemini-async',
      endpoint: 'gemini_async',
      reason: '异步任务返回 safety_block',
      attempts: [{ provider: 'tuzi', model: 'gemini-async', endpoint: 'gemini_async', status: 'failure', reason: 'safety_block' }]
    }), 'utf8');

    const notifier = { notifyProcessError: jest.fn().mockResolvedValue(true) };
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({} as any, store as any, notifier as any) as any;
    const task = createTask({ comicImagePath, comicGenerationFailureNotifiedAt: undefined });
    const anchorConfigSpy = jest.spyOn(BilibiliConfigHelper, 'getAnchorConfig').mockReturnValue(undefined);
    const summarySettingsSpy = jest.spyOn(BilibiliConfigHelper, 'getSummaryDynamicSettings').mockReturnValue(null);

    try {
      await service.executeSupplementalComicReply(task);
      await service.executeSupplementalComicReply(task);

      expect(notifier.notifyProcessError).toHaveBeenCalledTimes(1);
      expect(notifier.notifyProcessError.mock.calls[0][1]).toBe('异步漫画生图');
      expect(notifier.notifyProcessError.mock.calls[0][4].imageGenerationInfo).toContain('异步任务返回 safety_block');
      expect(task.status).toBe('completed');
      expect(task.error).toBe('漫画图片生成已失败，补图停止');
      expect(store.updateTask).toHaveBeenCalledWith(task.taskId, expect.objectContaining({
        comicGenerationFailureNotifiedAt: expect.any(Date)
      }));
    } finally {
      summarySettingsSpy.mockRestore();
      anchorConfigSpy.mockRestore();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('reports the final immersive or control comic mode from generation metadata', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-reply-comic-mode-'));
    const service = createService() as any;
    const immersiveImagePath = path.join(outputDir, 'immersive_COMIC_FACTORY.png');
    const controlImagePath = path.join(outputDir, 'control_COMIC_FACTORY.png');
    fs.writeFileSync(immersiveImagePath, 'image', 'utf8');
    fs.writeFileSync(controlImagePath, 'image', 'utf8');
    fs.writeFileSync(path.join(outputDir, 'immersive_COMIC_FACTORY_META.json'), JSON.stringify({
      status: 'success',
      storytellingVariant: 'immersive_v1',
      storytellingAssignmentReason: 'stable-rollout',
      storytellingImmersivePercent: 30,
      storytellingBucket: 419,
      usage: {
        input_tokens: 3200,
        input_tokens_details: { image_tokens: 2700, text_tokens: 500 },
        output_tokens: 4096
      }
    }), 'utf8');
    fs.writeFileSync(path.join(outputDir, 'control_COMIC_FACTORY_META.json'), JSON.stringify({
      status: 'success',
      storytellingVariant: 'control',
      storytellingAssignmentReason: 'forced',
      storytellingImmersivePercent: 30,
      storytellingBucket: 8100
    }), 'utf8');

    try {
      const immersiveInfo = service.diagnostics.getComicGenerationInfo(immersiveImagePath);
      const controlInfo = service.diagnostics.getComicGenerationInfo(controlImagePath);

      expect(immersiveInfo).toContain('漫画模式: 新版沉浸式（灰度组 immersive_v1）');
      expect(immersiveInfo).toContain('分配: 稳定灰度');
      expect(immersiveInfo).toContain('新版比例: 30%');
      expect(immersiveInfo).toContain('桶: 4.19');
      expect(immersiveInfo).toContain('用量: 输入 3200，图片 2700，文字 500，输出 4096 tokens');
      expect(controlInfo).toContain('漫画模式: 旧版对照组（control）');
      expect(controlInfo).toContain('分配: 强制指定');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('reports provider prompt-cache token usage for both text requests', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-reply-text-cache-'));
    const service = createService() as any;
    const goodnightTextPath = path.join(outputDir, 'stream_晚安回复.md');
    const comicImagePath = path.join(outputDir, 'stream_COMIC_FACTORY.png');
    fs.writeFileSync(goodnightTextPath, [
      '---',
      'provider: "daiYu"',
      'model: "gpt-5.6-luna"',
      'fallback: false',
      'attempts:',
      '  - status: "success"',
      '    promptTokens: 5600',
      '    cachedTokens: 4608',
      '    cacheWriteTokens: 1024',
      '---',
      '晚安正文'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(outputDir, 'stream_COMIC_SCRIPT_META.json'), JSON.stringify({
      status: 'success',
      provider: 'daiYu',
      model: 'gpt-5.6-luna',
      attempts: [{ status: 'success', promptTokens: 7200, cachedTokens: 5120, cacheWriteTokens: 0 }]
    }), 'utf8');

    try {
      const info = service.diagnostics.getTextGenerationInfo(goodnightTextPath, comicImagePath);
      expect(info).toContain('晚安文本: 模型: gpt-5.6-luna，服务: daiYu，输入缓存: 4608/5600 tokens，缓存写入: 1024 tokens');
      expect(info).toContain('漫画脚本文本: 模型: gpt-5.6-luna，服务: daiYu，状态: 成功，输入缓存: 5120/7200 tokens，缓存写入: 0 tokens');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe('DelayedReplyService first-wave comic policy', () => {
  const now = new Date('2026-08-10T01:42:00.000+08:00');
  let summarySettingsSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    summarySettingsSpy = jest.spyOn(BilibiliConfigHelper, 'getSummaryDynamicSettings').mockReturnValue(null);
  });

  afterEach(() => {
    summarySettingsSpy.mockRestore();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function createTask(overrides: Partial<DelayedReplyTask> = {}): DelayedReplyTask {
    return {
      taskId: 'first-wave-task',
      roomId: '27628030',
      uid: 'anchor-uid',
      goodnightTextPath: 'goodnight.md',
      comicImagePath: 'comic.png',
      createTime: new Date(now.getTime() - 60 * 1000),
      scheduledTime: new Date(now),
      status: 'pending',
      retryCount: 0,
      checkCount: 0,
      ...overrides
    };
  }

  function createDynamic(ageMs: number): BilibiliDynamic {
    return {
      id: 'dynamic-1',
      uid: 'anchor-uid',
      type: DynamicType.WORD,
      content: '晚安',
      publishTime: new Date(now.getTime() - ageMs),
      url: 'https://www.bilibili.com/opus/dynamic-1'
    };
  }

  function createHarness(dynamic: BilibiliDynamic, options: {
    imageExists?: boolean;
    terminalFailure?: boolean;
  } = {}) {
    const publishComment = jest.fn().mockResolvedValue({
      replyId: 'reply-1',
      replyTime: now.getTime()
    });
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({ publishComment } as any, store as any) as any;
    const scheduleTask = jest.spyOn(service, 'scheduleTask').mockImplementation(() => undefined);

    jest.spyOn(service, 'getRoomLiveStatusSafely').mockResolvedValue(null);
    jest.spyOn(service, 'deferTaskWaitingForReplacement').mockResolvedValue(false);
    jest.spyOn(service.policy, 'isDelayedReplyTaskExpired').mockReturnValue(false);
    jest.spyOn(service.artifactResolver, 'resolve').mockImplementation(
      (_roomId: string, goodnightTextPath: string, comicImagePath?: string) => ({
        goodnightTextPath,
        comicImagePath
      })
    );
    jest.spyOn(service, 'findTargetDynamic').mockResolvedValue(dynamic);
    jest.spyOn(service.replyContent, 'readReplyText').mockResolvedValue('晚安正文');
    jest.spyOn(service, 'checkFileExists').mockResolvedValue(options.imageExists ?? false);
    jest.spyOn(service.artifactResolver, 'isComicGenerationTerminalFailure').mockReturnValue(options.terminalFailure ?? false);
    jest.spyOn(service, 'notifyComicGenerationFailure').mockResolvedValue(undefined);
    if (options.terminalFailure) {
      jest.spyOn(service.artifactResolver, 'shouldWaitForComicImage').mockReturnValue(false);
    }

    return { service, store, publishComment, scheduleTask };
  }

  it('treats exactly five minutes as part of the first reply wave', () => {
    const dynamic = createDynamic(5 * 60 * 1000);
    const { service } = createHarness(dynamic);

    expect(service.policy.isWithinFirstReplyWave(dynamic, now.getTime())).toBe(true);

    dynamic.publishTime = new Date(dynamic.publishTime.getTime() - 1);
    expect(service.policy.isWithinFirstReplyWave(dynamic, now.getTime())).toBe(false);
  });

  it('publishes text immediately inside the first reply wave and waits to supplement the comic', async () => {
    const task = createTask();
    const { service, publishComment, scheduleTask } = createHarness(createDynamic(4 * 60 * 1000));

    await service.executeDelayedReplyLocked(task);

    expect(publishComment).toHaveBeenCalledWith({
      dynamicId: 'dynamic-1',
      content: '晚安正文',
      images: undefined
    });
    expect(task.status).toBe('waiting_comic');
    expect(task.comicWaitCount).toBe(0);
    expect(task.replyId).toBe('reply-1');
    expect(scheduleTask).toHaveBeenCalledWith(task);
  });

  it('waits for the comic when the target dynamic is older than five minutes', async () => {
    const task = createTask();
    const { service, store, publishComment, scheduleTask } = createHarness(createDynamic(9 * 60 * 1000));

    await service.executeDelayedReplyLocked(task);

    expect(publishComment).not.toHaveBeenCalled();
    expect(task.status).toBe('pending');
    expect(task.comicWaitCount).toBe(1);
    expect(task.scheduledTime.getTime()).toBe(now.getTime() + 60 * 1000);
    expect(store.updateTask).toHaveBeenCalledWith(task.taskId, expect.objectContaining({
      status: 'pending',
      comicWaitCount: 1
    }));
    expect(scheduleTask).toHaveBeenCalledWith(task);
  });

  it('publishes one combined reply when the comic appears during the extra wait', async () => {
    const task = createTask({ comicWaitCount: 3 });
    const { service, publishComment, scheduleTask } = createHarness(
      createDynamic(12 * 60 * 1000),
      { imageExists: true }
    );

    await service.executeDelayedReplyLocked(task);

    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(publishComment).toHaveBeenCalledWith({
      dynamicId: 'dynamic-1',
      content: '晚安正文',
      images: ['comic.png']
    });
    expect(task.status).toBe('completed');
    expect(scheduleTask).not.toHaveBeenCalled();
  });

  it('falls back to text first after five extra wait checks', async () => {
    const task = createTask({ comicWaitCount: 5 });
    const { service, publishComment, scheduleTask } = createHarness(createDynamic(14 * 60 * 1000));

    await service.executeDelayedReplyLocked(task);

    expect(publishComment).toHaveBeenCalledWith({
      dynamicId: 'dynamic-1',
      content: '晚安正文',
      images: undefined
    });
    expect(task.status).toBe('waiting_comic');
    expect(task.comicWaitCount).toBe(0);
    expect(scheduleTask).toHaveBeenCalledWith(task);
  });

  it('publishes text without waiting or supplementing after terminal comic failure', async () => {
    const task = createTask();
    const { service, publishComment, scheduleTask } = createHarness(
      createDynamic(9 * 60 * 1000),
      { terminalFailure: true }
    );

    await service.executeDelayedReplyLocked(task);

    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(task.status).toBe('completed');
    expect(scheduleTask).not.toHaveBeenCalled();
    expect(service.notifyComicGenerationFailure).toHaveBeenCalledWith(task);
  });
});

describe('DelayedReplyService summary dynamic reply', () => {
  let outputDir: string;
  let summarySettingsSpy: jest.SpyInstance;
  let anchorConfigSpy: jest.SpyInstance;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-reply-summary-'));
    summarySettingsSpy = jest.spyOn(BilibiliConfigHelper, 'getSummaryDynamicSettings').mockReturnValue({
      enabled: true,
      dynamicId: '1230474195813531666'
    });
    anchorConfigSpy = jest.spyOn(BilibiliConfigHelper, 'getAnchorConfig').mockReturnValue({
      uid: '1',
      name: '测试主播',
      roomId: '27628030',
      enabled: true,
      delayedReplyEnabled: true
    });
  });

  afterEach(() => {
    summarySettingsSpy.mockRestore();
    anchorConfigSpy.mockRestore();
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  function createSummaryTask(overrides: Partial<DelayedReplyTask> = {}): DelayedReplyTask {
    const goodnightTextPath = path.join(outputDir, '27628030-20260729-200000-001_晚安回复.md');
    fs.writeFileSync(goodnightTextPath, '晚安正文', 'utf8');
    return {
      taskId: 'summary-task',
      roomId: '27628030',
      goodnightTextPath,
      createTime: new Date('2026-07-29T16:00:00.000Z'),
      scheduledTime: new Date(),
      status: 'waiting_summary',
      retryCount: 0,
      liveStartTime: new Date('2026-07-29T12:00:00.000Z'),
      liveEndTime: new Date('2026-07-29T15:00:00.000Z'),
      repliedDynamicId: 'owner-dynamic',
      replyId: 'owner-reply',
      ...overrides
    };
  }

  it('publishes one combined text and image reply with the requested prefix', async () => {
    const comicImagePath = path.join(outputDir, 'stream_COMIC_FACTORY.png');
    fs.writeFileSync(comicImagePath, 'image', 'utf8');
    const publishComment = jest.fn().mockResolvedValue({
      replyId: 'summary-reply',
      replyTime: Date.now(),
      imageUrl: 'https://example.com/image.png'
    });
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({ publishComment } as any, store as any) as any;
    const task = createSummaryTask({ comicImagePath });

    await service.executeSummaryDynamicReply(task, '晚安正文', comicImagePath);

    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(publishComment).toHaveBeenCalledWith({
      dynamicId: '1230474195813531666',
      content: 'to 测试主播 7月29日20点~23点的直播。\n晚安正文',
      images: [comicImagePath]
    });
    expect(task.status).toBe('completed');
    expect(task.summaryReplyId).toBe('summary-reply');
    expect(store.updateTask).toHaveBeenCalledWith(task.taskId, expect.objectContaining({
      status: 'completed',
      summaryReplyId: 'summary-reply',
      summaryCompletedAt: expect.any(Date)
    }));
  });

  it('uses Beijing time when deriving the start from a recording filename', () => {
    const service = new DelayedReplyService({} as any, {} as any) as any;
    const task = createSummaryTask({
      liveStartTime: undefined,
      goodnightTextPath: path.join(outputDir, '27628030-20260729-041422-001_晚安回复.md')
    });

    const times = service.liveContentSummaryComposer.getSummaryLiveTimes(task);

    expect(times.startTime).toEqual(new Date('2026-07-29T04:14:22+08:00'));
  });

  it('publishes text only after image generation declares terminal failure', async () => {
    const comicImagePath = path.join(outputDir, 'stream_COMIC_FACTORY.png');
    const metaPath = path.join(outputDir, 'stream_COMIC_FACTORY_META.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      status: 'failure',
      reason: 'image provider failed'
    }), 'utf8');
    const publishComment = jest.fn().mockResolvedValue({
      replyId: 'summary-text-reply',
      replyTime: Date.now()
    });
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({ publishComment } as any, store as any) as any;
    const task = createSummaryTask({
      status: 'waiting_comic',
      comicImagePath,
      comicWaitCount: 0
    });

    await service.executeSupplementalComicReply(task);

    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(publishComment).toHaveBeenCalledWith({
      dynamicId: '1230474195813531666',
      content: 'to 测试主播 7月29日20点~23点的直播。\n晚安正文',
      images: undefined
    });
    expect(task.status).toBe('completed');
    expect(task.summaryReplyId).toBe('summary-text-reply');
    expect(task.supplementalReplyId).toBeUndefined();
  });

  it('retries only the summary reply without returning to the owner dynamic flow', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-07-29T16:30:00.000Z').getTime()
    );
    const publishComment = jest.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce({
        replyId: 'summary-retry-reply',
        replyTime: Date.now()
      });
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({ publishComment } as any, store as any) as any;
    jest.spyOn(service, 'scheduleTask').mockImplementation(() => undefined);
    const delayedReplyConfigSpy = jest.spyOn(BilibiliConfigHelper, 'getDelayedReplyConfig').mockReturnValue({
      enabled: true,
      delayMinutes: 2,
      maxRetries: 3,
      retryDelayMinutes: 5,
      maxTaskAgeHours: 24
    });
    const task = createSummaryTask();

    try {
      await service.executeSummaryDynamicReply(task, '晚安正文');

      expect(task.status).toBe('waiting_summary');
      expect(task.summaryRetryCount).toBe(1);

      await service.executeDelayedReplyLocked(task);

      expect(publishComment).toHaveBeenCalledTimes(2);
      expect(publishComment.mock.calls.every(
        ([request]) => request.dynamicId === '1230474195813531666'
      )).toBe(true);
      expect(task.status).toBe('completed');
      expect(task.summaryReplyId).toBe('summary-retry-reply');
    } finally {
      nowSpy.mockRestore();
      delayedReplyConfigSpy.mockRestore();
    }
  });

  it('backfills a completed task through the persisted task store', async () => {
    const publishComment = jest.fn().mockResolvedValue({
      replyId: 'summary-backfill-reply',
      replyTime: Date.now()
    });
    const task = createSummaryTask({ status: 'completed' });
    const store = {
      getTask: jest.fn().mockResolvedValue(task),
      updateTask: jest.fn().mockResolvedValue(undefined)
    };
    const service = new DelayedReplyService({ publishComment } as any, store as any);

    const result = await service.publishSummaryForTask(task.taskId);

    expect(result.summaryReplyId).toBe('summary-backfill-reply');
    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(store.updateTask).toHaveBeenCalledWith(task.taskId, expect.objectContaining({
      status: 'waiting_summary'
    }));
    expect(store.updateTask).toHaveBeenCalledWith(task.taskId, expect.objectContaining({
      status: 'completed',
      summaryReplyId: 'summary-backfill-reply'
    }));
  });
});

describe('DelayedReplyService live content summary delivery', () => {
  const now = new Date('2026-08-11T02:00:00.000+08:00');
  let outputDir: string;
  let summarySettingsSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-reply-live-content-'));
    summarySettingsSpy = jest.spyOn(BilibiliConfigHelper, 'getSummaryDynamicSettings').mockReturnValue(null);
  });

  afterEach(() => {
    summarySettingsSpy.mockRestore();
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  function writeSummary(status: 'success' | 'failed' = 'success'): string {
    const summaryPath = path.join(outputDir, 'stream_LIVE_CONTENT.json');
    fs.writeFileSync(summaryPath, JSON.stringify(status === 'success' ? {
      status: 'success',
      content: {
        overview: '杂谈、唱歌',
        activityTypes: ['chat', 'singing'],
        songs: ['夜航星'],
        games: ['星露谷物语'],
        topics: ['妈妈做火烧云', '最喜欢的前辈']
      }
    } : {
      status: 'failed',
      error: 'model request failed'
    }), 'utf8');
    return summaryPath;
  }

  function createTask(overrides: Partial<DelayedReplyTask> = {}): DelayedReplyTask {
    return {
      taskId: 'live-content-task',
      roomId: '26966466',
      uid: 'anchor-uid',
      goodnightTextPath: path.join(outputDir, 'stream_晚安回复.md'),
      createTime: new Date(now.getTime() - 60 * 1000),
      scheduledTime: new Date(now),
      status: 'pending',
      retryCount: 0,
      checkCount: 0,
      liveContentSummaryDeliveryMode: 'attach_if_ready',
      liveContentSummaryState: 'ready',
      ...overrides
    };
  }

  function createInitialReplyHarness(task: DelayedReplyTask, replyText = '晚安正文') {
    fs.writeFileSync(task.goodnightTextPath, replyText, 'utf8');
    let replyIndex = 0;
    const publishComment = jest.fn().mockImplementation(async () => ({
      replyId: `reply-${++replyIndex}`,
      replyTime: now.getTime()
    }));
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({ publishComment } as any, store as any) as any;
    jest.spyOn(service, 'scheduleTask').mockImplementation(() => undefined);
    jest.spyOn(service, 'getRoomLiveStatusSafely').mockResolvedValue(null);
    jest.spyOn(service, 'deferTaskWaitingForReplacement').mockResolvedValue(false);
    jest.spyOn(service.policy, 'isDelayedReplyTaskExpired').mockReturnValue(false);
    jest.spyOn(service.artifactResolver, 'resolve').mockImplementation(
      (_roomId: string, goodnightTextPath: string, comicImagePath?: string) => ({
        goodnightTextPath,
        comicImagePath
      })
    );
    jest.spyOn(service, 'findTargetDynamic').mockResolvedValue({
      id: 'owner-dynamic',
      uid: 'anchor-uid',
      type: DynamicType.WORD,
      content: '晚安',
      publishTime: new Date(now.getTime() - 60 * 1000),
      url: 'https://www.bilibili.com/opus/owner-dynamic'
    });
    return { service, store, publishComment };
  }

  it('always publishes Sui live content as a separate comment', async () => {
    const task = createTask({
      roomId: '25788785',
      liveContentSummaryPath: writeSummary(),
      liveContentSummaryDeliveryMode: 'separate'
    });
    const { service, publishComment } = createInitialReplyHarness(task);

    await service.executeDelayedReplyLocked(task);

    expect(publishComment).toHaveBeenCalledTimes(2);
    expect(publishComment.mock.calls[0][0]).toEqual({
      dynamicId: 'owner-dynamic',
      content: '晚安正文',
      images: undefined
    });
    expect(publishComment.mock.calls[1][0]).toEqual({
      dynamicId: 'owner-dynamic',
      content: '本场直播内容：杂谈、唱歌；歌曲：夜航星；游戏：星露谷物语；话题：妈妈做火烧云、最喜欢的前辈'
    });
    expect(task.liveContentSummaryState).toBe('published_separate');
    expect(task.liveContentSummaryReplyId).toBe('reply-2');
    expect(task.status).toBe('completed');
  });

  it('bounds a large standalone live-content summary to the Bilibili comment limit', async () => {
    const summaryPath = path.join(outputDir, 'large_LIVE_CONTENT.json');
    const overview = '整场以唱歌和杂谈为主';
    fs.writeFileSync(summaryPath, JSON.stringify({
      status: 'success',
      content: {
        overview,
        activityTypes: ['chat', 'singing'],
        songs: Array.from(
          { length: 400 },
          (_, index) => `第${index + 1}首特别特别长的测试歌曲名称`
        ),
        games: [],
        topics: []
      }
    }), 'utf8');
    const task = createTask({
      roomId: '25788785',
      status: 'waiting_live_content',
      liveContentSummaryPath: summaryPath,
      liveContentSummaryDeliveryMode: 'separate',
      repliedDynamicId: 'owner-dynamic',
      replyId: 'main-reply'
    });
    const publishComment = jest.fn().mockResolvedValue({
      replyId: 'summary-reply',
      replyTime: now.getTime()
    });
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({ publishComment } as any, store as any) as any;

    await service.executeLiveContentSummaryReply(task);

    const publishedText = publishComment.mock.calls[0][0].content as string;
    expect(publishedText.length).toBeLessThanOrEqual(1000);
    expect(publishedText).toContain(overview);
    expect(publishedText).toMatch(/(?:等|共)\d+项/u);
  });

  it('deduplicates a ready event while the existing task waits to publish live content', async () => {
    const summaryPath = writeSummary();
    const task = createTask({
      status: 'waiting_live_content',
      liveContentSummaryPath: summaryPath,
      repliedDynamicId: 'owner-dynamic',
      replyId: 'main-reply'
    });
    fs.writeFileSync(task.goodnightTextPath, '晚安正文', 'utf8');
    const store = {
      updateTask: jest.fn().mockResolvedValue(undefined),
      addTask: jest.fn().mockResolvedValue(undefined)
    };
    const service = new DelayedReplyService({} as any, store as any) as any;
    service.tasks.set(task.taskId, task);
    jest.spyOn(service, 'scheduleTask').mockImplementation(() => undefined);
    const delayedReplySettingsSpy = jest.spyOn(BilibiliConfigHelper, 'getDelayedReplySettings').mockReturnValue({
      enabled: true,
      anchorEnabled: true,
      delayMinutes: 2
    } as any);

    try {
      const taskId = await service.addTask(
        task.roomId,
        task.goodnightTextPath,
        undefined,
        undefined,
        undefined,
        undefined,
        summaryPath,
        'attach_if_ready'
      );

      expect(taskId).toBe(task.taskId);
      expect(service.tasks.size).toBe(1);
      expect(store.addTask).not.toHaveBeenCalled();
    } finally {
      delayedReplySettingsSpy.mockRestore();
    }
  });

  it('attaches Shiori live content to the initial reply when ready', async () => {
    const task = createTask({ liveContentSummaryPath: writeSummary() });
    const { service, publishComment } = createInitialReplyHarness(task);

    await service.executeDelayedReplyLocked(task);

    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(publishComment.mock.calls[0][0].content).toBe(
      '晚安正文\n\n本场直播内容：杂谈、唱歌；歌曲：夜航星；游戏：星露谷物语；话题：妈妈做火烧云、最喜欢的前辈'
    );
    expect(task.liveContentSummaryState).toBe('attached_main');
    expect(task.liveContentSummaryAttachedTo).toBe('main');
  });

  it('attaches Shiori live content to the supplemental comic reply when it becomes ready later', async () => {
    const summaryPath = writeSummary();
    const comicImagePath = path.join(outputDir, 'stream_COMIC_FACTORY.png');
    const goodnightTextPath = path.join(outputDir, 'stream_晚安回复.md');
    fs.writeFileSync(comicImagePath, 'image', 'utf8');
    fs.writeFileSync(goodnightTextPath, '晚安正文', 'utf8');
    const task = createTask({
      status: 'waiting_comic',
      goodnightTextPath,
      comicImagePath,
      repliedDynamicId: 'owner-dynamic',
      replyId: 'main-reply',
      completedAt: new Date(),
      liveContentSummaryPath: summaryPath
    });
    const publishComment = jest.fn().mockResolvedValue({
      replyId: 'supplemental-reply',
      replyTime: now.getTime()
    });
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({ publishComment } as any, store as any) as any;

    await service.executeSupplementalComicReply(task);

    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(publishComment).toHaveBeenCalledWith({
      dynamicId: 'owner-dynamic',
      content: '（补图）晚安正文\n\n本场直播内容：杂谈、唱歌；歌曲：夜航星；游戏：星露谷物语；话题：妈妈做火烧云、最喜欢的前辈',
      images: [comicImagePath]
    });
    expect(task.liveContentSummaryState).toBe('attached_supplemental');
    expect(task.liveContentSummaryReplyId).toBe('supplemental-reply');
  });

  it('publishes Shiori live content separately after both reply opportunities have passed', async () => {
    const task = createTask({
      status: 'waiting_live_content',
      liveContentSummaryPath: writeSummary(),
      repliedDynamicId: 'owner-dynamic',
      replyId: 'main-reply',
      supplementalReplyId: 'supplemental-reply'
    });
    const publishComment = jest.fn().mockResolvedValue({
      replyId: 'summary-reply',
      replyTime: now.getTime()
    });
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({ publishComment } as any, store as any) as any;

    await service.executeLiveContentSummaryReply(task);

    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(task.liveContentSummaryState).toBe('published_separate');
    expect(task.liveContentSummaryReplyId).toBe('summary-reply');
    expect(task.status).toBe('completed');
  });

  it('keeps polling when the live content sidecar appears after the main reply', async () => {
    const summaryPath = path.join(outputDir, 'stream_LIVE_CONTENT.json');
    const task = createTask({
      liveContentSummaryPath: summaryPath,
      liveContentSummaryState: 'waiting'
    });
    const { service, publishComment } = createInitialReplyHarness(task);
    const scheduleTask = jest.spyOn(service, 'scheduleTask');

    await service.executeDelayedReplyLocked(task);

    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(task.status).toBe('waiting_live_content');
    expect(task.liveContentSummaryState).toBe('waiting');
    expect(scheduleTask).toHaveBeenCalledWith(task);

    writeSummary();
    await service.executeLiveContentSummaryReply(task);

    expect(publishComment).toHaveBeenCalledTimes(2);
    expect(publishComment.mock.calls[1][0].content).toMatch(/^本场直播内容：/u);
    expect(task.liveContentSummaryState).toBe('published_separate');
    expect(task.status).toBe('completed');
  });

  it('splits a ready summary into a separate comment when the combined text exceeds 1000 characters', async () => {
    const task = createTask({ liveContentSummaryPath: writeSummary() });
    const longReply = '晚'.repeat(960);
    const { service, publishComment } = createInitialReplyHarness(task, longReply);

    await service.executeDelayedReplyLocked(task);

    expect(publishComment).toHaveBeenCalledTimes(2);
    expect(publishComment.mock.calls[0][0].content).toBe(longReply);
    expect(publishComment.mock.calls[1][0].content).toMatch(/^本场直播内容：/u);
    expect(task.liveContentSummaryForceSeparate).toBe(true);
    expect(task.liveContentSummaryState).toBe('published_separate');
  });

  it('does not block the main reply when live content generation failed', async () => {
    const task = createTask({ liveContentSummaryPath: writeSummary('failed') });
    const { service, publishComment } = createInitialReplyHarness(task);

    await service.executeDelayedReplyLocked(task);

    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(publishComment.mock.calls[0][0].content).toBe('晚安正文');
    expect(task.liveContentSummaryState).toBe('failed');
    expect(task.liveContentSummaryError).toBe('model request failed');
    expect(task.status).toBe('completed');
  });

  it('does not republish a live content summary after its reply id is persisted', async () => {
    const task = createTask({
      liveContentSummaryPath: writeSummary(),
      repliedDynamicId: 'owner-dynamic',
      replyId: 'main-reply'
    });
    const publishComment = jest.fn().mockResolvedValue({
      replyId: 'summary-reply',
      replyTime: now.getTime()
    });
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const notifier = { sendMarkdown: jest.fn().mockResolvedValue(true) };
    const anchorConfigSpy = jest.spyOn(BilibiliConfigHelper, 'getAnchorConfig').mockReturnValue({
      name: '岁己SUI'
    } as any);
    const service = new DelayedReplyService(
      { publishComment } as any,
      store as any,
      notifier as any
    ) as any;

    await service.tryPublishLiveContentSummarySeparately(task);
    await service.tryPublishLiveContentSummarySeparately(task);

    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(notifier.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(notifier.sendMarkdown.mock.calls[0][0]).toContain('✅ 直播梗概已发送');
    expect(notifier.sendMarkdown.mock.calls[0][0]).toContain('主播: 岁己SUI');
    expect(notifier.sendMarkdown.mock.calls[0][0]).toContain(
      '梗概内容:\n本场直播内容：杂谈、唱歌；歌曲：夜航星；游戏：星露谷物语；话题：妈妈做火烧云、最喜欢的前辈'
    );
    expect(notifier.sendMarkdown.mock.calls[0][0]).toContain(
      '[查看梗概回复](https://www.bilibili.com/opus/owner-dynamic#replysummary-reply)'
    );
    expect(task.liveContentSummaryReplyId).toBe('summary-reply');
    anchorConfigSpy.mockRestore();
  });

  it('keeps a published live content summary completed when its WeChat Work notification throws', async () => {
    const task = createTask({
      liveContentSummaryPath: writeSummary(),
      repliedDynamicId: 'owner-dynamic',
      replyId: 'main-reply'
    });
    const publishComment = jest.fn().mockResolvedValue({
      replyId: 'summary-reply',
      replyTime: now.getTime()
    });
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const notifier = { sendMarkdown: jest.fn().mockRejectedValue(new Error('wecom unavailable')) };
    jest.spyOn(BilibiliConfigHelper, 'getAnchorConfig').mockReturnValue(undefined);
    const service = new DelayedReplyService(
      { publishComment } as any,
      store as any,
      notifier as any
    ) as any;

    const outcome = await service.tryPublishLiveContentSummarySeparately(task);

    expect(outcome).toBe('done');
    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(notifier.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(task.liveContentSummaryState).toBe('published_separate');
    expect(task.liveContentSummaryReplyId).toBe('summary-reply');
  });

  it('reuses a persisted completed task when the ready event is replayed after restart', async () => {
    const summaryPath = writeSummary();
    const task = createTask({
      status: 'completed',
      repliedDynamicId: 'owner-dynamic',
      replyId: 'main-reply',
      liveContentSummaryPath: undefined,
      liveContentSummaryState: undefined
    });
    const store = {
      getAllTasks: jest.fn().mockResolvedValue([task]),
      updateTask: jest.fn().mockResolvedValue(undefined)
    };
    const service = new DelayedReplyService({} as any, store as any) as any;
    const scheduleTask = jest.spyOn(service, 'scheduleTask').mockImplementation(() => undefined);

    const registered = await service.registerLiveContentSummary(
      task.roomId,
      task.goodnightTextPath,
      summaryPath,
      'attach_if_ready'
    );

    expect(registered).toBe(task);
    expect(task.status).toBe('waiting_live_content');
    expect(task.liveContentSummaryState).toBe('ready');
    expect(scheduleTask).toHaveBeenCalledWith(task);
  });

  it('does not blindly repeat a publishing request restored after a crash', async () => {
    const task = createTask({
      status: 'waiting_live_content',
      liveContentSummaryPath: writeSummary(),
      liveContentSummaryState: 'publishing',
      liveContentSummaryPublishingAt: new Date(),
      repliedDynamicId: 'owner-dynamic',
      replyId: 'main-reply'
    });
    const publishComment = jest.fn();
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({ publishComment } as any, store as any) as any;

    await service.executeLiveContentSummaryReply(task);

    expect(publishComment).not.toHaveBeenCalled();
    expect(task.liveContentSummaryState).toBe('failed');
    expect(task.liveContentSummaryError).toContain('避免重启后重复评论');
    expect(task.status).toBe('completed');
  });
});

describe('DelayedReplyService ASR speaker notification info', () => {
  let outputDir: string;
  let service: any;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-reply-asr-meta-'));
    service = new DelayedReplyService({} as any, {} as any) as any;
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  function getNotificationInfo(meta: Record<string, unknown>): string | undefined {
    const goodnightTextPath = path.join(outputDir, 'recording_晚安回复.md');
    const asrMetaPath = path.join(outputDir, 'recording.asr_meta.json');
    fs.writeFileSync(asrMetaPath, JSON.stringify(meta), 'utf8');
    return service.diagnostics.getAsrInfo(goodnightTextPath);
  }

  it('keeps legacy ASR metadata output unchanged', () => {
    expect(getNotificationInfo({
      backend: 'funasr',
      modelProfile: 'default',
      model: 'paraformer-zh',
      elapsedSeconds: 20,
      mediaDurationSeconds: 100,
      realtimeFactor: 0.2
    })).toBe('ASR: funasr / 原版(paraformer-zh)，耗时: 20.0s，速度: 5.00x，RTF: 0.200');
  });

  it('shows full speaker processing details and compact timings', () => {
    const info = getNotificationInfo({
      backend: 'sensevoice',
      modelProfile: 'default',
      model: 'SenseVoiceSmall',
      speakerProcessing: {
        mode: 'auto',
        status: 'completed',
        decision: 'multiple_speakers',
        reason: 'probe detected multiple speakers',
        fullRun: true,
        sampledChunks: 6,
        validChunks: 5,
        detectedClusters: 3,
        supportedClusters: 2,
        sampledSpeechSeconds: 42.25,
        fullClusteringStrategy: 'probe_centroid_assignment',
        timings: {
          modelLoad: 99,
          probeEmbedding: 1.2,
          probeClustering: 0.3,
          fullEmbedding: 8.4,
          fullClustering: 0.6,
          reference: 0.4,
          matching: 0.2,
          total: 11.1
        }
      }
    });

    expect(info).toContain('说话人: 已完整处理');
    expect(info).toContain('模式: auto');
    expect(info).toContain('判定: multiple_speakers');
    expect(info).toContain('原因: probe detected multiple speakers');
    expect(info).toContain('策略: 探测簇中心分配');
    expect(info).toContain('抽样: 6段/5段有效/3个检测簇/2个支持簇/42.3s语音');
    expect(info).toContain('说话人耗时: 探测 1.5s / 全量 8.4s / 聚类 0.6s / 参考 0.4s / 匹配 0.2s / 总计 11.1s');
    expect(info).not.toContain('99.0s');
  });

  it('shows the explicit skipped message for snake-case full_run metadata', () => {
    const info = getNotificationInfo({
      speakerProcessing: {
        mode: 'auto',
        status: 'skipped',
        decision: 'single_speaker',
        full_run: false,
        sampledChunks: [1, 2, 3],
        validChunks: 3,
        timings: {
          probeEmbedding: 0.8,
          probeClustering: 0.2,
          total: 1.4
        }
      }
    });

    expect(info).toContain('说话人: 抽样判定单人，已跳过全量');
    expect(info).toContain('抽样: 3段/3段有效');
    expect(info).toContain('说话人耗时: 探测 1.0s / 总计 1.4s');
  });

  it('shows speaker failure without implying ASR failure', () => {
    const info = getNotificationInfo({
      speakerProcessing: {
        status: 'failed',
        reason: 'clustering crashed',
        fullRun: true,
        timings: { total: 2.5 }
      }
    });

    expect(info).toContain('说话人: 处理失败（ASR 已保留）');
    expect(info).toContain('原因: clustering crashed');
    expect(info).toContain('说话人耗时: 总计 2.5s');
  });
});
