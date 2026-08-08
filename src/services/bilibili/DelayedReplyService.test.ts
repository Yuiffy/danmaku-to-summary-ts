import { DelayedReplyService } from './DelayedReplyService';
import { DelayedReplyTask } from './interfaces/types';
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
      const immersiveInfo = service.getComicGenerationNotificationInfo(immersiveImagePath);
      const controlInfo = service.getComicGenerationNotificationInfo(controlImagePath);

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
      const info = service.getTextGenerationNotificationInfo(goodnightTextPath, comicImagePath);
      expect(info).toContain('晚安文本: 模型: gpt-5.6-luna，服务: daiYu，输入缓存: 4608/5600 tokens，缓存写入: 1024 tokens');
      expect(info).toContain('漫画脚本文本: 模型: gpt-5.6-luna，服务: daiYu，状态: 成功，输入缓存: 5120/7200 tokens，缓存写入: 0 tokens');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
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
    return service.getAsrNotificationInfo(goodnightTextPath);
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
