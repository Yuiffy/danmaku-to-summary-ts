import express, { ErrorRequestHandler, Express } from 'express';
import * as fs from 'fs';
import { timingSafeEqual } from 'crypto';
import { AdminConfigStore } from './AdminConfigStore';
import { AdminClipStore, AssetKind } from './AdminClipStore';
import { AdminJobs } from './AdminJobs';
import { AdminError, readJson } from './AdminFiles';
import { clipCommand, queueCommand, manualCommand, bundleCommand } from './AdminCommandPolicy';
import { initialReminderState, validateReminderState } from '../live-vote/reminders/ReminderPolicy';
import { ReminderCommandInbox } from '../live-vote/reminders/ReminderCommands';
import { AdminQueries } from '../live-vote/question-lab/AdminQueries';
import { LabBusy } from '../live-vote/question-lab/LabGate';
import { activityRepairCommand, workflowCommand, workflowInputs } from './AdminWorkflowPolicy';

export interface AdminAdapters {
  configs: AdminConfigStore;
  clips: AdminClipStore;
  jobs: AdminJobs;
  queries?: AdminQueries;
}
export function createAdminServer(adapters: AdminAdapters, token: string): Express {
  if (token.length < 32) throw new Error('管理服务需要至少 32 字符的访问令牌');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /u, '') || ''), expected = Buffer.from(token);
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '') ||
      supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.status(403).json({ error: '管理服务访问被拒绝' }); return; }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/questions/rooms', async (_req, res) => {
    try { res.json({ rooms: await adapters.queries?.rooms() || [] }); }
    catch { res.status(503).json({ error: '录播问答未配置或配置无效，请检查直播机器人配置' }); }
  });
  app.post('/questions/:mode', async (req, res) => {
    const mode = req.params.mode;
    if (!['ask', 'search'].includes(mode) || !adapters.queries) { res.status(404).json({ error: '问答入口不存在' }); return; }
    if (Buffer.byteLength(JSON.stringify(req.body)) > 8192) { res.status(400).json({ error: '问题内容过长' }); return; }
    const controller = new AbortController(), started = Date.now();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    try { res.json({ result: await adapters.queries.query(mode as 'ask' | 'search', req.body, controller.signal), elapsedMs: Date.now() - started }); }
    catch (error) {
      if (!res.destroyed) res.status(error instanceof LabBusy ? 429 : 400).json({ error: error instanceof LabBusy ? '另一个问题正在查询，请稍后再试' : '查询失败，请检查问题、房间和检索条件，或稍后重试' });
    } finally { res.off('close', disconnect); }
  });
  app.get('/configs', (_req, res) => res.json({ names: adapters.configs.list() }));
  app.get('/configs/:name', (req, res) => res.json(adapters.configs.get(req.params.name)));
  app.put('/configs/:name', (req, res) => res.json(adapters.configs.save(req.params.name, req.body.revision, req.body.value)));
  app.get('/clips', (req, res) => res.json(adapters.clips.list({ search: String(req.query.search || ''), status: String(req.query.status || ''), room: String(req.query.room || ''), page: String(req.query.page || '1') })));
  app.get('/clips/:id', (req, res) => res.json(adapters.clips.detail(req.params.id, Number(req.query.part || 1))));
  app.post('/clips/:id/actions', (req, res) => {
    const id = req.params.id, revision = req.body.revision;
    const validate = () => { if (adapters.clips.detail(id).revision !== revision) throw new AdminError('视频或审核内容已变化，请刷新后再操作', 409); };
    validate();
    const detail = adapters.clips.detail(id);
    const metadata = adapters.clips.metadata(adapters.clips.record(id));
    const input = detail.category === 'activity' && ['retry-boundaries', 'repair-timing'].includes(req.body.action)
      ? { ...req.body, mediaPath: metadata.source?.mediaPath, srtPath: metadata.source?.srtPath, xmlPath: metadata.source?.xmlPath, kind: metadata.kind } : req.body;
    for (const [key, extensions] of workflowInputs) if (input[key]) adapters.clips.checkedInput(input[key], extensions);
    const command = detail.category === 'clip' ? clipCommand(id, input)
      : ['retry-boundaries', 'repair-timing'].includes(input.action) && detail.category === 'activity' ? activityRepairCommand(id, input)
      : bundleCommand(id, input, detail.category, adapters.clips.checkedInput(adapters.clips.record(id).metadataPath, ['.json']));
    res.status(202).json(adapters.jobs.submit(command, validate));
  });
  app.get('/clips/:id/assets/:kind', (req, res) => {
    const kind = req.params.kind as AssetKind;
    if (!['media', 'preview', 'cover', 'subtitles', 'preview-subtitles', 'media-subtitles'].includes(kind)) throw new AdminError('素材类型不存在', 404);
    const file = adapters.clips.asset(req.params.id, kind, Number(req.query.part || 1));
    if (!file) throw new AdminError('素材不存在', 404);
    if (kind.includes('subtitles')) {
      // SRT remains evidence; the web adapter converts only the display format to VTT.
      res.type('text/plain').send(fs.readFileSync(file, 'utf8')); return;
    }
    res.sendFile(file); // Express supports byte-range playback and avoids buffering recordings.
  });
  app.get('/jobs', (_req, res) => res.json({ jobs: adapters.jobs.list() }));
  app.post('/workflows/actions', (req, res) => {
    const command = workflowCommand(req.body);
    const validate = () => { for (const [key, extensions] of workflowInputs) if (req.body[key]) adapters.clips.checkedInput(req.body[key], extensions); };
    validate();
    res.status(202).json(adapters.jobs.submit(command, validate));
  });
  app.get('/manual/:id', (req, res) => res.json(adapters.clips.manualDetail(req.params.id)));
  app.get('/manual/:id/assets/:kind', (req, res) => {
    if (!['media', 'cover'].includes(req.params.kind)) throw new AdminError('素材类型无效', 404);
    const file = adapters.clips.manualAsset(req.params.id, req.params.kind);
    if (!file) throw new AdminError('素材不存在', 404);
    res.sendFile(file);
  });
  app.post('/manual/actions', (req, res) => {
    const command = manualCommand(req.body);
    if (command.action === 'add-manual') {
      adapters.clips.checkedInput(req.body.mediaPath, ['.flv', '.mp4', '.mkv', '.ts', '.webm']);
      adapters.clips.checkedInput(req.body.srtPath, ['.srt']);
    }
    const validate = () => { if (command.action === 'add-manual') {
      adapters.clips.checkedInput(req.body.mediaPath, ['.flv', '.mp4', '.mkv', '.ts', '.webm']);
      adapters.clips.checkedInput(req.body.srtPath, ['.srt']);
    } };
    res.status(202).json(adapters.jobs.submit(command, validate));
  });
  app.get('/queues', (_req, res) => res.json(adapters.clips.queues()));
  app.post('/queues/actions', (req, res) => {
    const queues = adapters.clips.queues(), list = req.body.action === 'cancel-upload' ? queues.uploads : queues.manual;
    if (!list.some((job: any) => job.id === req.body.id)) throw new AdminError('队列任务不存在', 404);
    const validate = req.body.action === 'approve-manual' ? () => {
      if (adapters.clips.manualDetail(req.body.id).revision !== req.body.revision) throw new AdminError('手工视频已变化，请重新审核', 409);
    } : () => {};
    validate();
    res.status(202).json(adapters.jobs.submit(queueCommand(req.body), validate));
  });
  app.get('/reminders', (_req, res) => {
    const config = adapters.configs.rawVote(), policy = config.reminders;
    if (!policy) { res.json({ configured: false, runningEnabled: false, pending: [] }); return; }
    const state = readJson(policy.statePath, initialReminderState());
    validateReminderState(state, config.maxMessageChars || 40);
    res.json({ configured: true, runningEnabled: !!policy.enabled, roomId: policy.roomId, policy, state,
      pending: new ReminderCommandInbox(policy.statePath).list().map(command => ({ id: command.id, createdAt: command.createdAt, action: command.edit.action })),
      results: new ReminderCommandInbox(policy.statePath).results() });
  });
  app.post('/reminders', (req, res) => {
    const config = adapters.configs.rawVote();
    if (!config.reminders?.enabled) throw new AdminError('请先配置并启用直播提醒');
    let command;
    try { command = new ReminderCommandInbox(config.reminders.statePath).enqueue(req.body, config.maxMessageChars || 40); }
    catch (error) { throw new AdminError(error instanceof Error ? error.message : '提醒修改无效'); }
    res.status(202).json({ id: command.id, status: 'pending', message: '管理指令已保存，等待直播机器人接收' });
  });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    void _next;
    const status = error instanceof AdminError ? error.status : error.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ error: error instanceof AdminError ? error.message : status === 400 ? '请求 JSON 无效' : '管理操作失败，请检查服务日志' });
  };
  app.use(errorHandler);
  return app;
}
