import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DelayedReplyHandler } from '../../src/services/webhook/handlers/DelayedReplyHandler';
import { DelayedReplyService } from '../../src/services/bilibili/DelayedReplyService';
import { BilibiliConfigHelper } from '../../src/services/bilibili/BilibiliConfigHelper';
import { DelayedReplyTask, DynamicType } from '../../src/services/bilibili/interfaces/types';
import { LiveSessionManager } from '../../src/services/webhook/LiveSessionManager';
import { MikufansDelayedReplyCoordinator } from '../../src/services/webhook/handlers/mikufans/MikufansDelayedReplyCoordinator';

describe('goodnight workflow across service boundaries', () => {
  let directory: string;
  let textPath: string;
  let service: DelayedReplyService;
  let coordinator: MikufansDelayedReplyCoordinator;
  let app: express.Express;
  let stored: Map<string, DelayedReplyTask>;
  let api: { getDynamics: jest.Mock; publishComment: jest.Mock; getRoomLiveStatus: jest.Mock };

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goodnight-workflow-'));
    textPath = path.join(directory, 'recording_晚安回复.md');
    fs.writeFileSync(textPath, '---\nmodel: fixture\n---\n**晚安正文**', 'utf8');
    stored = new Map();
    api = {
      getDynamics: jest.fn().mockResolvedValue([]),
      publishComment: jest.fn().mockResolvedValue({ replyId: 'reply-fixture', replyTime: Date.now() }),
      getRoomLiveStatus: jest.fn().mockResolvedValue({ isLive: false })
    };
    jest.spyOn(BilibiliConfigHelper, 'getDelayedReplySettings').mockReturnValue({
      enabled: true, anchorEnabled: true, delayMinutes: 60
    } as any);
    jest.spyOn(BilibiliConfigHelper, 'getDelayedReplyConfig').mockReturnValue({ maxTaskAgeHours: 24 } as any);
    jest.spyOn(BilibiliConfigHelper, 'getAnchorConfig').mockReturnValue({ uid: 'fixture-uid', name: 'Fixture' } as any);
    jest.spyOn(BilibiliConfigHelper, 'getSummaryDynamicSettings').mockReturnValue(null);
    service = new DelayedReplyService(api as any, {
      initialize: async () => {},
      getAllTasks: async () => [...stored.values()],
      getPendingTasks: async () => [...stored.values()].filter(task => task.status === 'pending'),
      getTask: async (id: string) => stored.get(id) || null,
      cleanupOldTasks: async () => {},
      addTask: async (task: DelayedReplyTask) => { stored.set(task.taskId, { ...task }); },
      updateTask: async (id: string, changes: Partial<DelayedReplyTask>) => {
        stored.set(id, { ...stored.get(id)!, ...changes });
      },
      removeTask: async (id: string) => { stored.delete(id); }
    });
    await service.start();
    coordinator = new MikufansDelayedReplyCoordinator(new LiveSessionManager(), new Map());
    coordinator.setService(service);
    app = express();
    app.use(express.json());
    new DelayedReplyHandler(service).registerRoutes(app);
  });

  afterEach(async () => {
    coordinator.stop();
    await service.stop();
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('accepts a generated-file sentinel once, reads real Markdown, and persists one reply', async () => {
    const payload = JSON.stringify({ roomId: 'fixture-room', goodnightTextPath: textPath });
    const output = `[[DELAYED_REPLY_READY]] ${payload}`;
    await coordinator.handleReadyOutput(output, path.join(directory, 'recording.flv'));
    await coordinator.handleReadyOutput(output, path.join(directory, 'recording.flv'));
    const response = await request(app).get('/api/delayed-reply/tasks').expect(200);
    expect(response.body.tasks).toHaveLength(1);
    expect(stored.size).toBe(1);
    const task = service.getTasks()[0];
    api.getDynamics.mockResolvedValue([{
      id: 'dynamic-fixture', uid: 'fixture-uid', type: DynamicType.WORD,
      content: 'goodnight', publishTime: new Date(), url: 'https://example.invalid/dynamic'
    }]);
    // Drive the scheduler's execution boundary without sleeping or publishing remotely.
    await (service as any).executeDelayedReply(task);
    await (service as any).executeDelayedReply(task);
    expect(api.publishComment).toHaveBeenCalledTimes(1);
    expect(api.publishComment.mock.calls[0][0]).toMatchObject({ content: '晚安正文' });
    expect(stored.get(task.taskId)).toMatchObject({ status: 'completed', replyId: 'reply-fixture' });
  });

  test('creates, lists, and cancels a task through the service-owned HTTP API', async () => {
    const created = await request(app).post('/api/delayed-reply').send({
      roomId: 'fixture-room', goodnightTextPath: textPath, delaySeconds: 3600
    }).expect(200);
    const id = created.body.taskId;
    expect((await request(app).get('/api/delayed-reply/tasks').expect(200)).body.tasks[0].taskId).toBe(id);
    await request(app).delete(`/api/delayed-reply/tasks/${id}`).expect(200);
    expect(stored.size).toBe(0);
    expect(service.getTasks()).toHaveLength(0);
    expect(api.publishComment).not.toHaveBeenCalled();
    await request(app).delete(`/api/delayed-reply/tasks/${id}`).expect(404);
  });

  test('does not cancel a task while it is publishing', async () => {
    const id = await service.addTask('fixture-room', textPath, undefined, 3600);
    service.getTasks()[0].status = 'processing';
    await request(app).delete(`/api/delayed-reply/tasks/${id}`).expect(409);
    expect(stored.has(id)).toBe(true);
  });

  test('reports missing service and rejects invalid recording timestamps', async () => {
    const offline = express();
    new DelayedReplyHandler().registerRoutes(offline);
    await request(offline).get('/api/delayed-reply/tasks').expect(503);
    await request(app).post('/api/delayed-reply').send({
      roomId: 'fixture-room', goodnightTextPath: textPath, liveEndTime: 'invalid'
    }).expect(400);
    expect(stored.size).toBe(0);
  });

  test('rejects cancellation during the live-status check before the processing status is set', async () => {
    const id = await service.addTask('fixture-room', textPath, undefined, 3600);
    let release!: (status: { isLive: boolean }) => void;
    api.getRoomLiveStatus.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const execution = (service as any).executeDelayedReply(service.getTasks()[0]);
    try {
      await request(app).delete(`/api/delayed-reply/tasks/${id}`).expect(409);
      expect(stored.has(id)).toBe(true);
    } finally {
      release({ isLive: false });
      await execution;
    }
  });

  test('cancels a queued immediate callback before it can publish', async () => {
    api.getDynamics.mockResolvedValue([{
      id: 'dynamic-fixture', uid: 'fixture-uid', type: DynamicType.WORD,
      content: 'goodnight', publishTime: new Date(), url: 'https://example.invalid/dynamic'
    }]);
    const id = await service.addTask('fixture-room', textPath);
    await service.removeTask(id);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(api.publishComment).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });
});
