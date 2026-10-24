import request from 'supertest';
import * as fs from 'fs';
import { AdminAsrStatus } from './AdminAsrStatus';
import * as os from 'os';
import * as path from 'path';
import { AdminConfigStore } from './AdminConfigStore';
import { AdminClipStore } from './AdminClipStore';
import { AdminJobs } from './AdminJobs';
import { createAdminServer } from './AdminServer';
import { atomicJson, HIDDEN, readJson } from './AdminFiles';
import { clipCommand } from './AdminCommandPolicy';
import { ReminderCommandInbox } from '../live-vote/reminders/ReminderCommands';
import { LiveReminderSession } from '../live-vote/reminders/LiveReminderSession';
import { initialReminderState } from '../live-vote/reminders/ReminderPolicy';
import { AdminQueries } from '../live-vote/question-lab/AdminQueries';
import { LabGate } from '../live-vote/question-lab/LabGate';
import { AdminSourceMedia } from './AdminSourceMedia';
import { AdminCoverPreview } from './AdminCoverPreview';

const token = 'a'.repeat(64), headers = { Authorization: `Bearer ${token}` };
const roots: string[] = [];
it('previews registered frames and dispatches cover edits without publication, including whole-package covers', async () => {
  const f = fixture(), selection = { time: 1.25, part: 1, text: '新的封面文字', crop: { x: .1, y: .2, width: .8, height: .6 } };
  const render = jest.fn(async (_exe: string, args: string[]) => { fs.writeFileSync(args[args.indexOf('--output') + 1], 'jpeg'); });
  const app = createAdminServer({ configs: f.configs, clips: f.clips, jobs: f.jobs, covers: new AdminCoverPreview(f.root, 'python', render) }, token);
  const detail = f.clips.detail('1');
  await request(app).post('/clips/1/cover-preview').set(headers).send({ revision: 'old', selection }).expect(409);
  await request(app).post('/clips/1/cover-preview').set(headers).send({ revision: detail.revision, selection: { ...selection, crop: { x: .5, y: 0, width: 1, height: 1 } } }).expect(400);
  expect(render).not.toHaveBeenCalled();
  const preview = await request(app).post('/clips/1/cover-preview').set(headers).send({ revision: detail.revision, selection }).expect(200);
  expect(preview.headers['content-type']).toContain('image/jpeg');
  expect(render.mock.calls[0][1]).toContain(path.join(f.assets, 'video.mp4'));
  await request(app).post('/clips/1/actions').set(headers).send({ action: 'cover', note: '确认封面', selection, revision: detail.revision }).expect(202);
  await f.jobs.flush();
  expect(f.run.mock.calls[0][0].args).toEqual(['src/scripts/clip_upload_registry.py', 'cover', '--id', '1', '--selection', JSON.stringify(selection), '--note', '确认封面']);
  expect(f.run.mock.calls[0][0].args).not.toContain('--enqueue');
  const metadataPath = path.join(f.assets, 'video.json');
  atomicJson(metadataPath, { type: 'stream_activity_submission', output: { parts: [{ mediaPath: path.join(f.assets, 'video.mp4'), title: 'P1' }] } });
  await request(app).post('/clips/1/actions').set(headers).send({ action: 'cover', note: '确认整包封面', selection, revision: f.clips.detail('1').revision }).expect(202);
  await f.jobs.flush(); expect(f.run.mock.calls[1][0].action).toBe('cover');
});
it('rejects stale queued cover jobs and previews that finish after the media changes', async () => {
  const f = fixture(), selection = { time: 0, part: 1, text: '封面' }, revision = f.clips.detail('1').revision;
  const covers = new AdminCoverPreview(f.root, 'python', async (_exe, args) => {
    fs.writeFileSync(args[args.indexOf('--output') + 1], 'jpeg'); fs.appendFileSync(f.srt, '外部修改');
  });
  const app = createAdminServer({ configs: f.configs, clips: f.clips, jobs: f.jobs, covers }, token);
  await request(app).post('/clips/1/cover-preview').set(headers).send({ selection, revision }).expect(409);
  await request(app).post('/clips/1/actions').set(headers).send({ action: 'cover', note: '确认', selection, revision }).expect(409);
  const registryPath = path.join(f.root, 'data/runtime/clip_upload_registry.json'), registry = readJson(registryPath);
  registry.clips['1'].status = 'queued'; atomicJson(registryPath, registry);
  await request(app).post('/clips/1/actions').set(headers).send({ action: 'cover', note: '确认', selection, revision: f.clips.detail('1').revision }).expect(409);
  expect(f.run).not.toHaveBeenCalled();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-workspace-')); roots.push(root);
  const assets = path.join(root, 'recordings'), statePath = path.join(root, 'reminders.json'); fs.mkdirSync(assets);
  const settings = { app: { name: 'test', version: '1', environment: 'test', logLevel: 'info' }, webhook: { port: 12523, host: 'localhost' },
    audio: {}, ai: { apiKey: 'never-expose', endpoint: 'https://example.test/?key=private' }, fusion: {}, storage: {}, bilibili: { enabled: false, polling: {}, anchors: [], cookie: 'private-cookie' } };
  atomicJson(path.join(root, 'config/production.json'), settings);
  atomicJson(path.join(root, 'data/runtime/live-vote.json'), { source: 'recorder', rooms: 'auto-record', reminders: { enabled: true, roomId: '100', statePath, notificationConfigPath: path.join(root, 'config/production.json') } });
  const media = path.join(assets, 'video.mp4'), srt = path.join(assets, 'video.srt'), metadata = path.join(assets, 'video.json');
  fs.writeFileSync(media, '0123456789'); fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\n原字幕\n');
  atomicJson(metadata, { output: { mediaPath: media, srtPath: srt }, aiReview: { status: 'needs_review', note: '核对来源' } });
  atomicJson(path.join(root, 'data/runtime/clip_upload_registry.json'), { clips: { '1': { id: 1, status: 'needs_review', roomId: '100', title: '测试片', mediaPath: media, srtPath: srt, metadataPath: metadata } } });
  const run = jest.fn(async (_command, output) => { output('执行完成'); return 0; });
  const configs = new AdminConfigStore(root), clips = new AdminClipStore(root, () => [assets]), jobs = new AdminJobs(path.join(root, 'jobs'), run);
  const app = createAdminServer({ configs, clips, jobs }, token);
  return { app, root, assets, configs, clips, jobs, run, srt, statePath };
}
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

it('authenticates and projects the full upload queue without writing state or starting commands', async () => {
  const f = fixture(), queuePath = path.join(f.root, 'data/runtime/clip_upload_queue.json');
  atomicJson(queuePath, { jobs: [{ id: 'waiting', status: 'pending', clipIds: [1] },
    ...Array.from({ length: 205 }, (_, i) => ({ id: String(i), status: 'done', clipIds: [] }))] });
  const before = fs.readFileSync(queuePath, 'utf8');
  await request(f.app).get('/queues/status').expect(403);
  const response = await request(f.app).get('/queues/status').set(headers).expect(200);
  expect(response.body).toMatchObject({ state: 'ready', queuedJobs: 1, queuedClips: 1 });
  expect(response.body.queue[0].clips[0]).toMatchObject({ id: 1, title: '测试片' });
  expect(fs.readFileSync(queuePath, 'utf8')).toBe(before); expect(f.run).not.toHaveBeenCalled();
});

it('authenticates the read-only subtitle queue, does not run commands, and preserves the queue file', async () => {
  const f = fixture(), file = path.join(f.root, 'src/scripts/.whisper_queue.json');
  atomicJson(file, { tasks: [{ id: 'queued', status: 'pending', roomId: '100', mediaPath: 'D:/100_主播/2026_10_24/录制-100-20261024-195854-591-游戏.flv', addedTime: Date.now() }] });
  const before = fs.readFileSync(file, 'utf8');
  const app = createAdminServer({ configs: f.configs, clips: f.clips, jobs: f.jobs, asr: new AdminAsrStatus(f.root) }, token);
  await request(app).get('/queues/asr').expect(403);
  await request(app).get('/queues/asr/history').expect(403);
  const history = await request(app).get('/queues/asr/history?page=1&pageSize=20').set(headers).expect(200);
  expect(history.body).toMatchObject({ total: 0, items: [] });
  await request(app).get('/queues/asr/history?pageSize=51').set(headers).expect(400);
  await request(app).post('/queues/asr/history').set(headers).send({}).expect(404);
  const result = await request(app).get('/queues/asr').set(headers).expect(200);
  expect(result.body).toMatchObject({ queuedJobs: 1, activeJobs: 0 });
  expect(result.body.queue[0]).toMatchObject({ streamerName: '主播', title: '游戏', position: 1 });
  await request(app).post('/queues/asr').set(headers).send({}).expect(404);
  expect(fs.readFileSync(file, 'utf8')).toBe(before); expect(f.run).not.toHaveBeenCalled();
  fs.writeFileSync(file, '{'); await request(app).get('/queues/asr').set(headers).expect(503);
});

it('shows an evidenced no-clip reason before technical errors on legacy candidates without changing their files', async () => {
  const f = fixture(), registryPath = path.join(f.root, 'data/runtime/clip_upload_registry.json');
  const registry = readJson(registryPath), record = registry.clips['1'];
  record.reviewIssues = ['selection_rejected:detail_generation_failed', 'publication_review_unavailable:Missing rendered cover'];
  atomicJson(registryPath, registry);
  fs.writeFileSync(f.srt, '1\n00:00:00,000 --> 00:00:02,000\n这段别切了\n');
  atomicJson(record.metadataPath, { source: { srtPath: f.srt }, window: { start: 0, end: 2 }, output: { srtPath: f.srt } });
  const before = fs.readFileSync(registryPath, 'utf8');
  const list = (await request(f.app).get('/clips').set(headers).expect(200)).body;
  expect(list.clips[0].issues[0]).toContain('ASR疑似识别到主播要求别切');
  expect(list.clips[0].issues).toContain('selection_rejected:detail_generation_failed');
  const detail = f.clips.detail('1');
  expect(detail.evidence.clipIntent).toMatchObject({ needsHumanReview: true });
  expect(fs.readFileSync(registryPath, 'utf8')).toBe(before);
  expect(f.run).not.toHaveBeenCalled();
});

it('authenticates every endpoint and keeps masked credentials while atomically saving a reviewed config revision', async () => {
  const f = fixture();
  await request(f.app).get('/configs').expect(403);
  await request(f.app).get('/configs').set('Authorization', 'Bearer wrong').expect(403);
  const doc = (await request(f.app).get('/configs/production').set(headers).expect(200)).body;
  expect(JSON.stringify(doc)).not.toContain('private-cookie'); expect(doc.value.ai.apiKey).toContain(HIDDEN);
  doc.value.app.logLevel = 'debug';
  const saved = await request(f.app).put('/configs/production').set(headers).send(doc).expect(200);
  expect(saved.body.revision).not.toBe(doc.revision);
  const raw = readJson(path.join(f.root, 'config/production.json'));
  expect(raw.bilibili.cookie).toBe('private-cookie'); expect(raw.ai.endpoint).toBe('https://example.test/?key=private');
  expect(fs.readdirSync(path.join(f.root, 'data/runtime/admin/config-backups'))).toHaveLength(1);
  await request(f.app).put('/configs/production').set(headers).send(doc).expect(409);
  await request(f.app).get('/configs/secret').set(headers).expect(404);
});

it('streams registered video ranges and holds operations when the subtitles changed after the browser loaded review', async () => {
  const f = fixture();
  const listing = await request(f.app).get('/clips').query({ search: '测试', status: 'needs_review' }).set(headers).expect(200);
  expect(listing.body.total).toBe(1);
  const detail = (await request(f.app).get('/clips/1').set(headers).expect(200)).body;
  expect(detail.subtitles).toContain('原字幕'); expect(detail.media).toBe(true);
  const range = await request(f.app).get('/clips/1/assets/media').set(headers).set('Range', 'bytes=2-5').expect(206);
  expect(range.headers['content-range']).toBe('bytes 2-5/10');
  fs.appendFileSync(f.srt, '\n外部修改');
  await request(f.app).post('/clips/1/actions').set(headers).send({ action: 'approve-review', revision: detail.revision, note: '已核对' }).expect(409);
  expect(f.run).not.toHaveBeenCalled();
  await request(f.app).get('/clips/1/assets/metadata').set(headers).expect(404);
});

it('requires explicit publication and passes exact subtitle replacement text through shell-free argument boundaries', async () => {
  const f = fixture(), detail = f.clips.detail('1');
  const replacement = "字词' $(not-a-command)";
  await request(f.app).post('/clips/1/actions').set(headers).send({ action: 'enqueue', revision: detail.revision, note: '已核对' }).expect(400);
  const response = await request(f.app).post('/clips/1/actions').set(headers).send({ action: 'correct', revision: detail.revision, from: '原字幕', to: replacement, note: '人工听音确认' }).expect(202);
  await f.jobs.flush();
  expect(f.run.mock.calls[0][0].args).toContain(replacement);
  expect(f.run.mock.calls[0][0].args).not.toContain('--enqueue');
  expect(f.jobs.list().find(job => job.id === response.body.id)?.status).toBe('succeeded');
  expect(() => clipCommand(1, { action: 'worker' })).toThrow('不支持');
});

it('applies web reminder edits in the bot without resetting receipts, and acknowledges rejected commands', async () => {
  const f = fixture(), state = initialReminderState();
  state.receipts.push({ day: '2026-10-10', id: 'medicine', at: Date.parse('2026-10-10T12:00:00Z'), text: '按医嘱吃药', status: 'sent', notified: true });
  atomicJson(f.statePath, state);
  const inbox = new ReminderCommandInbox(f.statePath);
  await request(f.app).post('/reminders').set(headers).send({ action: 'upsert', item: { ...state.items[0], enabled: false, templates: ['按医嘱吃药'] } }).expect(202);
  await request(f.app).post('/reminders').set(headers).send({ action: 'upsert', item: { ...state.items[0], templates: ['过长文案'.repeat(20)] } }).expect(400);
  expect(readJson(f.statePath).items[0].enabled).toBe(true);
  const bot = new LiveReminderSession({ enabled: true, roomId: '100', statePath: f.statePath, notificationConfigPath: 'unused' }, [], undefined, 40,
    jest.fn(async () => false), { load: () => readJson(f.statePath), save: next => atomicJson(f.statePath, next),
      commands: () => inbox.list(), completeCommand: (id, error) => inbox.complete(id, error),
      status: jest.fn(), notify: jest.fn(), onError: error => { throw error; } });
  bot.tick();
  const after = readJson(f.statePath); expect(after.items[0].enabled).toBe(false); expect(after.receipts).toEqual(state.receipts);
  bot.tick(); expect(readJson(f.statePath).appliedCommandIds).toHaveLength(1);
  await request(f.app).post('/reminders').set(headers).send({ action: 'pause' }).expect(202);
  bot.tick();
  const view = (await request(f.app).get('/reminders').set(headers)).body;
  expect(view.pending).toEqual([]); expect(view.results.some((result: any) => result.status === 'rejected')).toBe(true);
});

it('refuses asset paths outside recording roots and never retries interrupted operator jobs after restart', async () => {
  const f = fixture(), outside = path.join(f.root, 'secret.mp4'); fs.writeFileSync(outside, 'secret');
  const registry = readJson(path.join(f.root, 'data/runtime/clip_upload_registry.json')); registry.clips['1'].mediaPath = outside;
  atomicJson(path.join(f.root, 'data/runtime/clip_upload_registry.json'), registry);
  await request(f.app).get('/clips/1/assets/media').set(headers).expect(403);
  atomicJson(path.join(f.root, 'jobs/11111111-1111-1111-1111-111111111111.json'), { id: '11111111-1111-1111-1111-111111111111', status: 'running', output: '', createdAt: new Date().toISOString() });
  const jobs = new AdminJobs(path.join(f.root, 'jobs'), f.run);
  expect(jobs.list()[0].status).toBe('interrupted'); expect(f.run).not.toHaveBeenCalled();
});

it('retains each hidden credential when an operator reorders provider entries', () => {
  const f = fixture(), file = path.join(f.root, 'config/secret.json');
  atomicJson(file, { providers: [{ name: 'first', apiKey: 'key-one' }, { name: 'second', apiKey: 'key-two' }] });
  const doc = f.configs.get('secrets'); doc.value.providers.reverse(); f.configs.save('secrets', doc.revision, doc.value);
  expect(readJson(file).providers).toEqual([{ name: 'second', apiKey: 'key-two' }, { name: 'first', apiKey: 'key-one' }]);
});

it('requires current manual media review and dispatches full activity packages to their dedicated approval command', async () => {
  const f = fixture(), media = path.join(f.assets, 'video.mp4'), metadata = path.join(f.assets, 'video.json');
  atomicJson(path.join(f.root, 'data/runtime/manual_clip_queue.json'), { tasks: [{ id: 'mcq-00001', title: '手工片', status: 'pending_review', outputVideo: media }] });
  const manual = (await request(f.app).get('/manual/mcq-00001').set(headers).expect(200)).body;
  await request(f.app).post('/queues/actions').set(headers).send({ action: 'approve-manual', id: 'mcq-00001', revision: 'old', publishApproved: true }).expect(409);
  await request(f.app).post('/queues/actions').set(headers).send({ action: 'approve-manual', id: 'mcq-00001', revision: manual.revision, publishApproved: true }).expect(202);
  await f.jobs.flush(); expect(f.run.mock.calls[0][0].args).toEqual(['src/scripts/manual_clip_queue.js', 'approve', 'mcq-00001']);
  atomicJson(metadata, { type: 'stream_activity_submission', output: { parts: [{ title: '第一首', mediaPath: media }, { title: '第二首', mediaPath: media }] } });
  const detail = f.clips.detail('1'); expect(detail.parts).toHaveLength(2);
  await request(f.app).get('/clips/1/assets/media?part=2').set(headers).expect(200);
  await request(f.app).get('/clips/1/assets/media?part=3').set(headers).expect(400);
  await request(f.app).post('/clips/1/actions').set(headers).send({ action: 'approve-review', revision: detail.revision, note: '已检查所有歌曲的原音与边界' }).expect(202);
  await f.jobs.flush(); expect(f.run.mock.calls[1][0].args).toEqual(['src/scripts/stream_activity_clips.js', 'approve', '--metadata', metadata, '--note', '已检查所有歌曲的原音与边界']);
  expect(f.run.mock.calls[1][0].args).not.toContain('--enqueue');
});

it('uses bounded private evidence queries and blocks unconfigured rooms and arbitrary path fields', async () => {
  const f = fixture(), runtime = { questions: { enabled: true, providerConfigPath: 'unused', recordingRoots: { '100': [f.assets] } } };
  const search = jest.fn(async () => ({ hits: [{ excerpt: '原话', time: '00:00:01' }] } as any));
  const queries = new AdminQueries(async () => runtime, new LabGate(1000, 0), search);
  const app = createAdminServer({ configs: f.configs, clips: f.clips, jobs: f.jobs, queries }, token);
  const result = await request(app).post('/questions/search').set(headers).send({ roomId: '100', question: '聊了什么', terms: ['电脑'] }).expect(200);
  expect(result.body.result.hits[0].excerpt).toBe('原话'); expect(search).toHaveBeenCalledTimes(1);
  await request(app).post('/questions/search').set(headers).send({ roomId: '999', question: '测试问题' }).expect(400);
  await request(app).post('/questions/search').set(headers).send({ roomId: '100', question: '测试问题', path: 'private' }).expect(400);
  expect(search).toHaveBeenCalledTimes(1);
});

it('rechecks a queued review before executing and rejects edits made while another operation runs', async () => {
  const f = fixture();
  let release!: () => void;
  f.run.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return 0; });
  const revision = f.clips.detail('1').revision;
  await request(f.app).post('/clips/1/actions').set(headers).send({ action: 'preview', revision }).expect(202);
  await request(f.app).post('/clips/1/actions').set(headers).send({ action: 'approve-review', revision, note: '已核对原音' }).expect(202);
  fs.appendFileSync(f.srt, '\n新字幕'); release(); await f.jobs.flush();
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.jobs.list().find(job => job.action === 'approve-review')).toMatchObject({ status: 'failed', output: expect.stringContaining('已变化') });
});

it('follows the selected part and invalidates approval when any multipart subtitle changes', async () => {
  const f = fixture(), second = path.join(f.assets, 'second.srt');
  fs.writeFileSync(second, '1\n00:00:01,000 --> 00:00:03,000\n第二首字幕\n');
  atomicJson(path.join(f.assets, 'video.json'), { type: 'stream_activity_submission', kind: 'songs', output: { parts: [
    { title: '第一首', mediaPath: path.join(f.assets, 'video.mp4'), srtPath: f.srt },
    { title: '第二首', mediaPath: path.join(f.assets, 'video.mp4'), srtPath: second }
  ] } });
  const first = f.clips.detail('1'), next = (await request(f.app).get('/clips/1').query({ part: 2 }).set(headers).expect(200)).body;
  expect(next.partSubtitles).toContain('第二首字幕'); expect(next.revision).toBe(first.revision);
  fs.appendFileSync(second, '\n外部改词');
  await request(f.app).post('/clips/1/actions').set(headers).send({ action: 'approve-review', revision: first.revision, note: '所有 P 已核对' }).expect(409);
});

it('validates workflow source paths and uses the same registered source for activity repairs', async () => {
  const f = fixture(), media = path.join(f.assets, 'video.mp4'), metadata = path.join(f.assets, 'video.json');
  const outside = path.join(f.root, 'outside.mp4'); fs.writeFileSync(outside, 'outside');
  await request(f.app).post('/workflows/actions').set(headers).send({ workflow: 'activity', action: 'run', kind: 'songs', mediaPath: outside, srtPath: f.srt }).expect(403);
  await request(f.app).post('/workflows/actions').set(headers).send({ workflow: 'activity', action: 'run', kind: 'songs', mediaPath: media, srtPath: f.srt }).expect(202);
  await f.jobs.flush();
  expect(f.run.mock.calls[0][0]).toMatchObject({ reviewOnly: true, args: expect.arrayContaining(['--no-notify', '--reuse-summary-only']) });
  expect(f.run.mock.calls[0][0].args).not.toContain('--enqueue');
  atomicJson(metadata, { type: 'stream_activity_submission', kind: 'songs', source: { mediaPath: media, srtPath: f.srt }, output: { mediaPath: media, srtPath: f.srt } });
  await request(f.app).post('/clips/1/actions').set(headers).send({ action: 'retry-boundaries', revision: f.clips.detail('1').revision, note: '收尾需要重审', mediaPath: outside, reviseVerifier: true }).expect(202);
  await f.jobs.flush();
  expect(f.run.mock.calls[1][0]).toMatchObject({ reviewOnly: true, target: '1', args: expect.arrayContaining([media, '--retry-boundaries', '--kind', 'songs', '--revise-verifier']) });
  expect(f.run.mock.calls[1][0].args).not.toContain(outside);
});

it('shows untitled candidate evidence and seeks registered originals without preparing subtitles or mutating review state', async () => {
  const f = fixture(), registryFile = path.join(f.root, 'data/runtime/clip_upload_registry.json');
  const metadataFile = path.join(f.assets, 'video.json'), source = path.join(f.assets, 'video.mp4');
  fs.writeFileSync(f.srt, '8\n00:45:41,000 --> 00:45:44,000\n这段原话讲电脑\n\n9\n00:45:44,000 --> 00:45:46,000\n接着谈价格\n\n10\n00:50:00,000 --> 00:50:02,000\n范围外\n');
  atomicJson(metadataFile, { source: { mediaPath: source, srtPath: f.srt }, window: { start: 2742.139, end: 2746 },
    reviewPresentation: { title: '电脑价格的话题' }, copy: { title: '待复核候选 2' } });
  const registry = readJson(registryFile);
  Object.assign(registry.clips['1'], { title: '待复核候选 2', publicCopyPending: true, start: '00:45:42', duration: '00:00:04', srtPath: '', mediaPath: '' });
  atomicJson(registryFile, registry);
  const before = fs.readFileSync(registryFile, 'utf8'), metaBefore = fs.readFileSync(metadataFile, 'utf8');
  const run = jest.fn(), sourceMedia = new AdminSourceMedia(path.join(f.root, 'cache'), () => 'ffmpeg', run);
  const app = createAdminServer({ configs: f.configs, clips: f.clips, jobs: f.jobs, sourceMedia }, token);
  const list = (await request(app).get('/clips').set(headers).expect(200)).body;
  expect(list.clips[0]).toMatchObject({ title: '待复核候选 2', reviewTitle: '电脑价格的话题', subtitleExcerpt: '这段原话讲电脑 接着谈价格' });
  const detail = (await request(app).get('/clips/1').set(headers).expect(200)).body;
  expect(detail.title).toBe('待复核候选 2'); expect(detail.source.start).toBe(2742.139);
  expect(detail.source.subtitles).toContain('00:45:41,000'); expect(detail.source.subtitles).not.toContain('范围外');
  expect(detail.media).toBe(false); expect(detail.preview).toBe(false);
  const playback = (await request(app).get('/clips/1/source-playback').set(headers).expect(200)).body;
  expect(playback).toEqual({ start: 2742.139, end: 2746, origin: 0 });
  await request(app).get('/clips/1/assets/source-preview').set(headers).set('Range', 'bytes=2-5').expect(206);
  expect(fs.readFileSync(registryFile, 'utf8')).toBe(before); expect(fs.readFileSync(metadataFile, 'utf8')).toBe(metaBefore);
  expect(f.run).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  fs.appendFileSync(f.srt, '\n11\n00:45:45,000 --> 00:45:46,000\n新增原片字幕\n');
  expect(f.clips.detail('1').revision).not.toBe(detail.revision);
  const outside = path.join(f.root, 'outside.mp4'); fs.writeFileSync(outside, 'outside');
  atomicJson(metadataFile, { source: { mediaPath: outside }, window: { start: 1, end: 2 } });
  await request(app).get('/clips/1/source-playback').set(headers).expect(403);
});

it('reads one registry snapshot per page while retaining visible candidate evidence and filters', async () => {
  const f = fixture(), metadata = path.join(f.assets, 'video.json');
  atomicJson(metadata, { candidateSubtitles: { path: f.srt }, reviewPresentation: { title: '审核看点' } });
  const clips = Object.fromEntries(Array.from({ length: 85 }, (_, index) => {
    const id = index + 1;
    return [String(id), { id, title: '待复核候选 2', publicCopyPending: true, metadataPath: metadata,
      roomId: id === 85 ? '200' : '100', status: id === 84 ? 'uploaded' : 'needs_review' }];
  }));
  const records = jest.spyOn(f.clips, 'records').mockReturnValue(clips);
  const metadataRead = jest.spyOn(f.clips, 'metadata');
  const list = (await request(f.app).get('/clips').query({ status: 'needs_review', room: '100', page: 2 }).set(headers).expect(200)).body;
  expect(records).toHaveBeenCalledTimes(1);
  expect(metadataRead).toHaveBeenCalledTimes(40);
  expect(list).toMatchObject({ total: 83, page: 2, counts: { needs_review: 84, uploaded: 1 }, rooms: ['100', '200'] });
  expect(list.clips.map((clip: any) => clip.id)).toEqual(Array.from({ length: 40 }, (_, index) => 43 - index));
  expect(list.clips.every((clip: any) => clip.reviewTitle === '审核看点' && clip.subtitleExcerpt === '原字幕')).toBe(true);
});

it('returns review details while source playback is still loading in its independent request', async () => {
  const f = fixture(), source = path.join(f.assets, 'source.flv');
  fs.writeFileSync(source, 'source');
  atomicJson(path.join(f.assets, 'video.json'), { source: { mediaPath: source, srtPath: f.srt },
    window: { start: 0, end: 2 }, output: { mediaPath: path.join(f.assets, 'video.mp4'), srtPath: f.srt } });
  const sourceMedia = new AdminSourceMedia(path.join(f.root, 'cache'), () => 'ffmpeg');
  let started!: () => void, finish!: () => void;
  const loading = new Promise<void>(resolve => { started = resolve; });
  jest.spyOn(sourceMedia, 'prepare').mockImplementation(async () => {
    started();
    await new Promise<void>(resolve => { finish = resolve; });
    return { file: source, start: 0, end: 2, origin: 0, direct: false };
  });
  const app = createAdminServer({ configs: f.configs, clips: f.clips, jobs: f.jobs, sourceMedia }, token);
  const playback = request(app).get('/clips/1/source-playback').set(headers).timeout(2000).expect(200).then(response => response.body);
  try {
    await loading;
    const detail = (await request(app).get('/clips/1').set(headers).timeout(1000).expect(200)).body;
    expect(detail).toMatchObject({ title: '测试片', media: true, source: { available: true } });
    expect(detail.subtitles).toContain('原字幕');
    expect(f.run).not.toHaveBeenCalled();
  } finally { finish(); await playback; }
});
