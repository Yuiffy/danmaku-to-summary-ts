import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { ClipDetail } from '../../core/admin/contracts';
import { AdminTitles } from './AdminTitles';
import { AdminJobs } from './AdminJobs';
import { parseTitleOptions, titlePrompt } from './AdminTitlePolicy';
import { AdminClipStore } from './AdminClipStore';
import { AdminConfigStore } from './AdminConfigStore';
import { AdminFeedback } from './AdminFeedback';
import { createAdminServer } from './AdminServer';
import { atomicJson } from './AdminFiles';

const roots: string[] = [];
const raw = JSON.stringify([
  { strategy: 'natural', title: '我觉得自己算中高手，你们觉得呢？', evidence: '我觉得自己算中高手' },
  { strategy: 'quote', title: '“我觉得自己算中高手”', evidence: '我觉得自己算中高手' },
  { strategy: 'community', title: '游戏高手自评：先问问你们', evidence: '我觉得自己算中高手', cardId: 'game' }
]);
function fixture(generate: (prompt: string) => Promise<string> = async () => raw) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'title-choices-')); roots.push(root);
  const detail = { clip: { id: 1, roomId: '25788785', streamerName: '岁己', status: 'needs_review' }, title: '原先人工确认的标题',
    revision: 'r1', subtitles: '1\n00:00:00,000 --> 00:00:02,000\n我觉得自己算中高手\n', source: { start: 0, end: 2, subtitles: '' },
    category: 'clip', evidence: {} } as ClipDetail;
  const clips = { detail: jest.fn(() => structuredClone(detail)), hasActiveUpload: jest.fn(() => false) };
  const run = jest.fn(async () => 0), jobs = new AdminJobs(path.join(root, 'jobs'), run), model = jest.fn(generate);
  const directory = path.join(root, 'titles'), titles = new AdminTitles(directory, clips, jobs, model);
  const ref = () => { const view = titles.view('1'); return { setId: view.id, revision: view.revision }; };
  const expose = () => { const view = titles.view('1'); titles.expose('1', { setId: view.id, optionIds: view.options.map(option => option.id) }); };
  const row = (strategy: string) => titles.stats().rows.find(row => row.strategy === strategy)!;
  return { root, directory, detail, clips, run, jobs, model, titles, ref, expose, row };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('does not recycle an unverified person from the original title into a new AI alternative', () => {
  const f = fixture();
  f.detail.title = '灰泽满追问：我觉得自己算中高手';
  f.detail.evidence.speakerCues = [{ text: '我觉得自己算中高手', speakerEvidence: {
    status: 'row_supported', label: '灰泽满Hazel', identityVerified: false } }];
  expect(titlePrompt(f.detail)).toContain('原标题也是待核草稿');
  expect(parseTitleOptions(JSON.stringify([{ strategy: 'quote', title: '灰泽满：我觉得自己算中高手',
    evidence: '我觉得自己算中高手' }]), f.detail)).toEqual([]);
  expect(parseTitleOptions(JSON.stringify([{ strategy: 'quote', title: '“我觉得自己算中高手”',
    evidence: '我觉得自己算中高手' }]), f.detail)).toHaveLength(1);
});

it('keeps default untouched, measures passive retention separately, and deduplicates exposure/reload', async () => {
  const f = fixture();
  expect(f.titles.view('1').selection).toBeNull();
  expect(f.titles.stats().sets).toBe(0);
  f.expose(); f.expose();
  expect(f.row('default')).toMatchObject({ shown: 1, selected: 0 });
  expect(f.titles.stats().passiveDefault).toBe(1);
  f.titles.start('1', f.ref()); await f.jobs.flush(); f.expose(); f.expose();
  expect(f.titles.view('1').options).toHaveLength(4);
  expect(f.detail.title).toBe('原先人工确认的标题');
  expect(f.titles.view('1').selection).toBeNull();
  expect(f.row('natural').shown).toBe(1);
  expect(f.run).not.toHaveBeenCalled();
  const restarted = new AdminTitles(f.directory, f.clips, f.jobs, f.model);
  expect(restarted.stats()).toEqual(f.titles.stats());
  expect(restarted.view('1')).toEqual(f.titles.view('1'));
});

it('persists explicit default, alternative, custom and reset history without duplicate clicks', async () => {
  const f = fixture(); f.titles.start('1', f.ref()); await f.jobs.flush(); f.expose();
  f.titles.select('1', { ...f.ref(), optionId: 'default' });
  f.titles.select('1', { ...f.ref(), optionId: 'default' });
  expect(f.row('default')).toMatchObject({ selected: 1, changes: 1 });
  expect(f.titles.stats().passiveDefault).toBe(0);
  f.titles.select('1', { ...f.ref(), optionId: 'natural', title: '伪造覆盖' });
  expect(f.titles.view('1').selection?.title).toBe('我觉得自己算中高手，你们觉得呢？');
  expect(f.row('default').selected).toBe(0);
  expect(f.row('natural').selected).toBe(1);
  f.titles.select('1', { ...f.ref(), title: '我手写的标题' });
  expect(new AdminTitles(f.directory, f.clips, f.jobs, f.model).view('1').selection?.strategy).toBe('custom');
  f.titles.select('1', { ...f.ref(), reset: true });
  expect(f.row('custom')).toMatchObject({ selected: 0, changes: 1 });
  expect(f.titles.stats().passiveDefault).toBe(1);
});

it('rejects stale selections, unknown options, invalid IDs, and titles on uploaded/queued clips', () => {
  const f = fixture(), stale = f.ref();
  expect(() => f.titles.select('1', { ...f.ref(), optionId: 'forged' })).toThrow('不存在');
  expect(() => f.titles.expose('1', { setId: stale.setId, optionIds: ['forged'] })).toThrow('无效');
  expect(() => f.titles.select('1', { ...f.ref(), title: 'bad\nline' })).toThrow('单行');
  expect(() => f.titles.view('../2')).toThrow('ID 无效');
  f.titles.select('1', { ...stale, title: '新的手写标题' });
  expect(() => f.titles.select('1', { ...stale, optionId: 'default' })).toThrow('已变化');
  f.detail.subtitles += '片内证据变化';
  expect(() => f.titles.select('1', { ...stale, optionId: 'default' })).toThrow('已变化');
  expect(f.titles.view('1').selection).toBeNull();
  for (const status of ['uploaded', 'queued', 'excluded']) {
    f.detail.clip.status = status;
    expect(() => f.titles.select('1', { ...f.ref(), optionId: 'default' })).toThrow('未入队');
  }
});

it('deduplicates async generation and rejects evidence changes during model work', async () => {
  let resolve!: (value: string) => void;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const first = f.titles.start('1', f.ref());
  expect(f.titles.start('1', f.ref()).id).toBe(first.id);
  await Promise.resolve();
  f.detail.title = '外部新标题'; resolve(raw); await f.jobs.flush();
  expect(f.jobs.list()[0].status).toBe('failed');
  expect(f.titles.view('1').options).toHaveLength(1);
  expect(f.model).toHaveBeenCalledTimes(1);
});

it('keeps a choice made during generation, and generation failure leaves the default usable', async () => {
  let resolve!: (value: string) => void;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  f.titles.start('1', f.ref()); await Promise.resolve();
  f.titles.select('1', { ...f.ref(), title: '生成期间人工确认' });
  resolve(raw); await f.jobs.flush();
  expect(f.titles.view('1').selection?.title).toBe('生成期间人工确认');
  const fail = fixture(async () => { throw new Error('secret provider error'); });
  fail.titles.start('1', fail.ref()); await fail.jobs.flush();
  expect(fail.titles.view('1').options[0].title).toBe(fail.detail.title);
  expect(fail.titles.view('1').job?.output).not.toContain('secret');
});

it('requires literal clip evidence and eligible room cards, without inventing recent trends', () => {
  const f = fixture();
  expect(parseTitleOptions(raw, f.detail)).toHaveLength(3);
  f.detail.clip.roomId = 'other-room';
  expect(parseTitleOptions(raw, f.detail).map(option => option.strategy)).toEqual(['natural', 'quote']);
  const invalid = JSON.stringify([{ strategy: 'natural', title: '捏造标题', evidence: '并不存在的原话' },
    { strategy: 'trend', title: '热梗', evidence: '我觉得自己算中高手' }]);
  expect(parseTitleOptions(invalid, f.detail)).toEqual([]);
  expect(titlePrompt(f.detail)).not.toContain('别急，我是游戏高手');
});

it('binds the selected title to existing commands, prevents raw enqueue bypass and rejects stale tabs', async () => {
  const f = fixture(); f.titles.start('1', f.ref()); await f.jobs.flush();
  const chosen = f.titles.select('1', { ...f.ref(), optionId: 'natural' });
  const body = { action: 'feedback-publish', titleSetId: chosen.id, titleRevision: chosen.revision };
  const prepared = f.titles.prepare('1', body);
  expect(prepared.body.title).toBe(chosen.selection!.title);
  expect(prepared.decision).toMatchObject({ strategy: 'natural', mode: 'explicit' });
  expect(() => f.titles.prepare('1', { ...body, action: 'enqueue' })).toThrow('尚未应用');
  expect(() => f.titles.prepare('1', { ...body, action: 'correct', enqueue: true })).toThrow('尚未应用');
  expect(() => f.titles.prepare('1', { action: 'feedback-publish' })).toThrow('刷新');
  f.titles.select('1', { ...f.ref(), optionId: 'default' });
  expect(() => f.titles.prepare('1', body)).toThrow('已变化');
});

it('counts accepted operation intent separately from failure and never changes the default strategy', async () => {
  const f = fixture(); f.expose();
  const decision = f.titles.prepare('1', { action: 'feedback-publish' }).decision;
  expect(decision).toMatchObject({ strategy: 'default', mode: 'retained' });
  f.jobs.submitOperation('feedback-publish', '1', { titleChoice: decision }, async () => 1);
  await f.jobs.flush();
  expect(f.row('default')).toMatchObject({ selected: 0, submitted: 1, succeeded: 0, failed: 1 });
  f.jobs.submitOperation('feedback-publish', '1', { titleChoice: decision }, async () => 0);
  await f.jobs.flush();
  expect(f.row('default')).toMatchObject({ submitted: 1, succeeded: 1, failed: 0 });
  const jobs = new AdminJobs(path.join(f.root, 'jobs'), f.run);
  expect(new AdminTitles(f.directory, f.clips, jobs, f.model).stats()).toEqual(f.titles.stats());
  expect(f.titles.view('1').selection).toBeNull();
});

it('restores only the latest failed feedback title for unchanged evidence after restart', async () => {
  const f = fixture();
  f.jobs.submitOperation('feedback-publish', '1', { revision: 'r1', edits: { title: '失败时已保存的标题' } }, async () => 1);
  await f.jobs.flush();
  const jobs = new AdminJobs(path.join(f.root, 'jobs'), f.run);
  const titles = new AdminTitles(f.directory, f.clips, jobs, f.model);
  expect(titles.prepare('1', { action: 'feedback-publish', note: '投' }).body.title).toBe('失败时已保存的标题');
  expect(titles.prepare('1', { action: 'feedback-publish', note: '换个标题，写成反向工商' }).body.title).toBeUndefined();
  expect(titles.prepare('1', { action: 'feedback-publish', note: '投', title: '新提交的标题' }).body.title).toBe('新提交的标题');
  expect(titles.prepare('1', { action: 'cut' }).body.title).toBeUndefined();
  f.detail.revision = 'r2';
  expect(titles.prepare('1', { action: 'feedback-publish', note: '投' }).body.title).toBeUndefined();
  f.detail.revision = 'r1';
  jobs.submitOperation('feedback-publish', '1', { revision: 'r1', edits: {} }, async () => 1); await jobs.flush();
  expect(titles.prepare('1', { action: 'feedback-publish', note: '投' }).body.title).toBeUndefined();
});

it('honors an explicit current choice, default selection and reset over a failed title', async () => {
  const f = fixture();
  f.jobs.submitOperation('feedback-publish', '1', { revision: 'r1', edits: { title: '失败旧标题' } }, async () => 1); await f.jobs.flush();
  for (const selection of [{ title: '现在的手写标题' }, { optionId: 'default' }, { reset: true }]) {
    const view = f.titles.select('1', { ...f.ref(), ...selection });
    const result = f.titles.prepare('1', { action: 'feedback-publish', note: '投', titleSetId: view.id, titleRevision: view.revision });
    expect(result.body.title).toBe(view.selection?.title);
    expect(result.decision?.title).toBe(view.selection?.title || f.detail.title);
  }
});

it('routes authenticated choices into a real saved feedback job without touching registry/media or enqueueing', async () => {
  const f = fixture(), assets = path.join(f.root, 'assets'); fs.mkdirSync(assets);
  const srtPath = path.join(assets, 'clip.srt'); fs.writeFileSync(srtPath, f.detail.subtitles);
  const metadataPath = path.join(assets, 'clip.json'); atomicJson(metadataPath, { output: { srtPath } });
  const registryPath = path.join(f.root, 'data/runtime/clip_upload_registry.json');
  atomicJson(registryPath, { clips: { '1': { id: 1, status: 'needs_review', roomId: '25788785', title: f.detail.title, metadataPath, srtPath } } });
  const before = fs.readFileSync(registryPath, 'utf8');
  const clips = new AdminClipStore(f.root, () => [assets]);
  const titles = new AdminTitles(f.directory, clips, f.jobs, f.model);
  const feedback = new AdminFeedback(clips, f.jobs, f.run, async () => { throw new Error('isolated test: no publication'); });
  const token = 't'.repeat(40), headers = { Authorization: `Bearer ${token}` };
  const app = createAdminServer({ clips, titles, jobs: f.jobs, feedback, configs: new AdminConfigStore(f.root) }, token);
  await request(app).get('/title-stats').expect(403);
  const view = (await request(app).get('/clips/1/titles').set(headers).expect(200)).body;
  const saved = (await request(app).post('/clips/1/titles/selection').set(headers).send({ setId: view.id, revision: view.revision, title: '明确选定的手写标题' }).expect(200)).body;
  const input = { action: 'feedback-publish', note: '按选定标题修改', revision: clips.detail('1').revision, publishApproved: true, titleSetId: saved.id, titleRevision: saved.revision };
  await request(app).post('/clips/1/actions').set(headers).send({ ...input, publishApproved: false }).expect(400);
  expect(titles.stats().rows.find(row => row.strategy === 'custom')?.submitted).toBe(0);
  const response = await request(app).post('/clips/1/actions').set(headers).send(input).expect(202);
  expect(response.body.edits.title).toBe('明确选定的手写标题');
  expect(response.body.titleChoice.strategy).toBe('custom');
  await f.jobs.flush();
  expect(titles.stats().rows.find(row => row.strategy === 'custom')).toMatchObject({ submitted: 1, succeeded: 0, failed: 1 });
  expect(fs.readFileSync(registryPath, 'utf8')).toBe(before);
  expect(f.run).not.toHaveBeenCalled();
});
