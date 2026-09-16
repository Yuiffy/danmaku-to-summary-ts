import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DelayedReplyStore } from '../DelayedReplyStore';
import { DelayedReplyTask } from '../interfaces/types';
import { BilibiliConfigHelper } from '../BilibiliConfigHelper';
import { DelayedReplyPolicy } from './DelayedReplyPolicy';
import { ReplyContentReader } from './ReplyContentReader';
import { DelayedReplyArtifactResolver } from './DelayedReplyArtifactResolver';
import { DelayedReplyDiagnostics } from './DelayedReplyDiagnostics';
import { LiveContentSummaryComposer } from './LiveContentSummaryComposer';
import { SupplementaryReplyPorts, SupplementaryReplyWorkflow } from './SupplementaryReplyWorkflow';

describe('supplementary publication persistence', () => {
  let directory: string;
  let storagePath: string;
  let store: DelayedReplyStore;
  let task: DelayedReplyTask;
  let ports: SupplementaryReplyPorts;
  let publish: jest.Mock;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'supplementary-workflow-'));
    storagePath = path.join(directory, 'tasks.json');
    store = new DelayedReplyStore(storagePath);
    await store.initialize();
    task = {
      taskId: 'task', roomId: '123', createTime: new Date(), scheduledTime: new Date(),
      goodnightTextPath: path.join(directory, 'goodnight.md'),
      comicImagePath: path.join(directory, 'comic.png'),
      status: 'waiting_comic', retryCount: 0, replyId: 'main', repliedDynamicId: 'dynamic'
    };
    fs.writeFileSync(task.goodnightTextPath, 'Good night');
    fs.writeFileSync(task.comicImagePath!, 'image');
    await store.addTask(task);
    publish = jest.fn().mockResolvedValue({ replyId: 'follow-up', replyTime: Date.now() });
    ports = {
      bilibiliAPI: { publishComment: publish }, store,
      policy: new DelayedReplyPolicy(), replyContent: new ReplyContentReader(),
      artifactResolver: new DelayedReplyArtifactResolver(), diagnostics: new DelayedReplyDiagnostics(),
      liveContentSummaryComposer: new LiveContentSummaryComposer(),
      scheduleTask: jest.fn(), checkFileExists: async file => fs.existsSync(file),
      notifyComicGenerationFailure: jest.fn(),
      notifier: { sendImage: jest.fn().mockRejectedValue(new Error('notification unavailable')),
        sendMarkdown: jest.fn().mockRejectedValue(new Error('notification unavailable')) }
    };
    jest.spyOn(BilibiliConfigHelper, 'getSummaryDynamicSettings').mockReturnValue(null);
    jest.spyOn(BilibiliConfigHelper, 'getAnchorConfig').mockReturnValue(null);
    jest.spyOn(BilibiliConfigHelper, 'getDelayedReplyConfig').mockReturnValue({
      enabled: true, delayMinutes: 1, checkInterval: 1000, maxRetries: 3, retryDelayMinutes: 1
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function restart(): Promise<{ workflow: SupplementaryReplyWorkflow; restored: DelayedReplyTask }> {
    const restoredStore = new DelayedReplyStore(storagePath);
    await restoredStore.initialize();
    const restored = (await restoredStore.getTask(task.taskId))!;
    return { workflow: new SupplementaryReplyWorkflow({ ...ports, store: restoredStore }), restored };
  }

  it('persists intent before sending, and does not repeat a completed comic after restart or notification failure', async () => {
    publish.mockImplementation(async () => {
      const { restored } = await restart();
      expect(restored.supplementalPublishingAt).toBeInstanceOf(Date);
      expect(restored.supplementalReplyId).toBeUndefined();
      return { replyId: 'follow-up', replyTime: Date.now() };
    });
    await new SupplementaryReplyWorkflow(ports).executeSupplementalComicReply(task);
    expect(ports.notifier!.sendImage).toHaveBeenCalledTimes(1);
    expect(ports.notifier!.sendMarkdown).toHaveBeenCalledTimes(1);
    const { workflow, restored } = await restart();
    expect(restored.supplementalReplyId).toBe('follow-up');
    expect(restored.supplementalPublishingAt).toBeUndefined();
    await workflow.executeSupplementalComicReply(restored);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(['comic', 'summary'] as const)('does not resend an uncertain %s request restored from disk', async kind => {
    if (kind === 'comic') task.supplementalPublishingAt = new Date();
    else {
      task.summaryPublishingAt = new Date();
      jest.spyOn(BilibiliConfigHelper, 'getSummaryDynamicSettings').mockReturnValue({ enabled: true, dynamicId: 'summary' });
    }
    await store.updateTask(task.taskId, task);
    const { workflow, restored } = await restart();
    if (kind === 'comic') await workflow.executeSupplementalComicReply(restored);
    else await workflow.executeSummaryDynamicReply(restored);
    expect(publish).not.toHaveBeenCalled();
    expect(restored.status).toBe('completed');
    expect(restored.error).toContain('outcome is unknown');
  });

  it('retries a rejected comic request independently without repeating the main reply', async () => {
    publish.mockRejectedValueOnce(new Error('temporary rejection'));
    await new SupplementaryReplyWorkflow(ports).executeSupplementalComicReply(task);
    const { workflow, restored } = await restart();
    expect(restored.supplementalPublishingAt).toBeUndefined();
    expect(restored.status).toBe('waiting_comic');
    expect(restored.retryCount).toBe(1);
    await workflow.executeSupplementalComicReply(restored);
    expect(restored.replyId).toBe('main');
    expect(restored.supplementalReplyId).toBe('follow-up');
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('retains the publishing marker when saving a successful comic result fails', async () => {
    ports.store = { updateTask: async (id, updates) => {
      if (updates.supplementalReplyId) throw new Error('disk unavailable after publication');
      await store.updateTask(id, updates);
    } };
    await new SupplementaryReplyWorkflow(ports).executeSupplementalComicReply(task);
    const { workflow, restored } = await restart();
    expect(restored.supplementalPublishingAt).toBeInstanceOf(Date);
    expect(restored.supplementalReplyId).toBeUndefined();
    await workflow.executeSupplementalComicReply(restored);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('does not change a successful separate summary into a retry when persistence fails', async () => {
    task.liveContentSummaryPath = 'summary.json';
    jest.spyOn(ports.liveContentSummaryComposer, 'read').mockReturnValue({ kind: 'success', text: 'Live summary' });
    ports.store = { updateTask: async (id, updates) => {
      if (updates.liveContentSummaryReplyId) throw new Error('disk unavailable after publication');
      await store.updateTask(id, updates);
    } };
    const workflow = new SupplementaryReplyWorkflow(ports);
    expect(await workflow.tryPublishLiveContentSummarySeparately(task)).toBe('done');
    expect(await workflow.tryPublishLiveContentSummarySeparately(task)).toBe('done');
    const reloaded = await restart();
    expect(reloaded.restored.liveContentSummaryState).toBe('publishing');
    await reloaded.workflow.tryPublishLiveContentSummarySeparately(reloaded.restored);
    await reloaded.workflow.completeOrWaitForLiveContentSummary(reloaded.restored);
    await reloaded.workflow.tryPublishLiveContentSummarySeparately(reloaded.restored);
    reloaded.restored.liveContentSummaryDeliveryMode = 'attach_if_ready';
    expect(ports.liveContentSummaryComposer.compose(reloaded.restored, 'reply', 'supplemental').attached).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('persists the parent before publishing and never repeats the child after restart', async () => {
    task.liveContentSummaryPath = 'summary.json';
    task.replyId = '12345678901234567890';
    task.supplementalReplyId = 'unrelated-image-comment';
    jest.spyOn(ports.liveContentSummaryComposer, 'read').mockReturnValue({ kind: 'success', text: 'Live summary' });
    publish.mockImplementation(async request => {
      const { restored } = await restart();
      expect(restored.liveContentSummaryState).toBe('publishing');
      expect(restored.liveContentSummaryParentReplyId).toBe(task.replyId);
      expect(request).toEqual({ dynamicId: 'dynamic', content: 'Live summary', replyToId: task.replyId });
      return { replyId: 'child-comment', replyTime: Date.now() };
    });
    expect(await new SupplementaryReplyWorkflow(ports).tryPublishLiveContentSummarySeparately(task)).toBe('done');
    const { workflow, restored } = await restart();
    expect(restored.liveContentSummaryState).toBe('published_thread');
    expect(restored.liveContentSummaryAttachedTo).toBe('main_reply');
    expect(restored.liveContentSummaryReplyId).toBe('child-comment');
    await workflow.tryPublishLiveContentSummarySeparately(restored);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(['replyId', 'repliedDynamicId'] as const)('waits without falling back to a top-level comment when %s is absent', async field => {
    task.liveContentSummaryPath = 'summary.json';
    task[field] = undefined;
    expect(await new SupplementaryReplyWorkflow(ports).tryPublishLiveContentSummarySeparately(task)).toBe('waiting');
    expect(publish).not.toHaveBeenCalled();
  });

  it('retries a failed child using the same parent without publishing another main comment', async () => {
    task.liveContentSummaryPath = 'summary.json';
    jest.spyOn(ports.liveContentSummaryComposer, 'read').mockReturnValue({ kind: 'success', text: 'Live summary' });
    publish.mockRejectedValueOnce(new Error('temporary rejection'));
    expect(await new SupplementaryReplyWorkflow(ports).tryPublishLiveContentSummarySeparately(task)).toBe('retry');
    const { workflow, restored } = await restart();
    expect(restored.liveContentSummaryParentReplyId).toBe('main');
    expect(await workflow.tryPublishLiveContentSummarySeparately(restored)).toBe('done');
    expect(publish).toHaveBeenCalledTimes(2);
    for (const [request] of publish.mock.calls) expect(request.replyToId).toBe('main');
  });

  it('leaves a historical top-level summary delivered rather than reposting it as a child', async () => {
    task.liveContentSummaryPath = 'summary.json';
    task.liveContentSummaryState = 'published_separate';
    task.liveContentSummaryReplyId = 'historical-comment';
    expect(await new SupplementaryReplyWorkflow(ports).tryPublishLiveContentSummarySeparately(task)).toBe('done');
    expect(publish).not.toHaveBeenCalled();
    expect(task.liveContentSummaryState).toBe('published_separate');
  });
});
