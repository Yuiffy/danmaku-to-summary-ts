import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import request from 'supertest';
import { AdminCampaignCandidates } from './AdminCampaignCandidates';
import { AdminCampaignFeedback } from './AdminCampaignFeedback';
import { AdminClipStore } from './AdminClipStore';
import { AdminFeedback } from './AdminFeedback';
import { AdminJobs, CommandRunner } from './AdminJobs';
import { atomicJson, readJson } from './AdminFiles';
import { AdminConfigStore } from './AdminConfigStore';
import { createAdminServer } from './AdminServer';
import { prepareCampaignCandidate } from '../../tools/clipping/promoteCampaignCandidate';
import { campaignCandidatePath } from '../../workflows/clipping/campaignCandidate';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-feedback-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const recordings = path.join(root, 'recordings'), directory = path.join(recordings, '100_主播', '2026_10_24');
  fs.mkdirSync(directory, { recursive: true });
  const media = path.join(directory, 'source.mp4'), srt = path.join(directory, 'source.srt');
  fs.writeFileSync(media, 'source media');
  fs.writeFileSync(srt, '1\n00:00:09,000 --> 00:00:11,000\n铺垫\n\n2\n00:00:12,000 --> 00:00:19,000\n翻车了\n\n3\n00:00:19,000 --> 00:00:21,000\n收尾\n');
  const topic = require('../../scripts/topic_clipper'), { buildSubtitleEvidence } = require('../../scripts/clipping/subtitle_evidence');
  const sourceSha256 = buildSubtitleEvidence(topic.parseTopicSrt(srt).segments).sourceSha256;
  const statePath = path.join(directory, 'own_stream_fun_clips/REVIEW_STATE.json');
  const metadata = { roomId: '100', streamerName: '主播甲', recordedAt: '2026-10-24 12:00:00', streamTitle: '玩芙娅之魂', source: { mediaPath: media, srtPath: srt },
    aiStatus: { ranking: { sourceSha256, skipped: [{ candidateIndex: 1, start: 10, end: 20, title: '翻车话题', reason: 'score' }, { candidateIndex: 2, start: 10, end: 20, title: '另一个话题' }] } } };
  atomicJson(statePath, { type: 'own_stream_review_state', metadata });
  const clips = new AdminClipStore(root, () => [recordings]), registryPath = path.join(root, 'data/runtime/clip_upload_registry.json');
  const candidates = new AdminCampaignCandidates(clips, () => [recordings], () => [{ requiredGames: ['芙娅之魂'], roomIds: ['100'], startsAt: '2026-10-22', endsAt: '2026-11-06' }]);
  const id = candidates.list({}).candidates[0].id, metadataPath = campaignCandidatePath(media, id);
  const run = jest.fn<ReturnType<CommandRunner>, Parameters<CommandRunner>>(async (command, output) => {
    output(command.action);
    const arg = (key: string) => command.args[command.args.indexOf(key) + 1];
    if (command.action === 'register-campaign-candidate') {
      prepareCampaignCandidate({ state: arg('--state'), id: arg('--id'), selectionDigest: arg('--selection-digest'), sourceDigest: arg('--source-digest') });
      return 0;
    }
    if (command.action === 'import-campaign-candidate') {
      const saved = readJson(metadataPath);
      atomicJson(registryPath, { clips: { '51': { id: 51, metadataPath, sourceMediaPath: media, srtPath: saved.output.srtPath, roomId: saved.roomId,
        streamerName: saved.streamerName, prefix: saved.upload.prefix, title: saved.copy.title, status: 'needs_review', reviewPending: true } } });
      return 0;
    }
    const saved = readJson(metadataPath), registry = readJson(registryPath), clip = registry.clips['51'];
    if (command.action === 'rebuild') {
      for (const [field, flag] of [['title', '--title'], ['description', '--description'], ['coverText', '--cover-text']]) {
        saved.copy[field] = arg(flag); if (field !== 'coverText') clip[field] = arg(flag);
      }
      delete saved.selectionRejection;
      clip.pendingRebuild = true;
    }
    if (command.action === 'cut') {
      saved.output.mediaPath = path.join(directory, 'rendered.mp4'); saved.output.coverPath = path.join(directory, 'cover.jpg');
      fs.writeFileSync(saved.output.mediaPath, 'render'); fs.writeFileSync(saved.output.coverPath, 'cover');
      Object.assign(clip, { mediaPath: saved.output.mediaPath, coverPath: saved.output.coverPath, reviewPending: false, pendingRebuild: false, status: 'review' });
    }
    if (command.action === 'enqueue') {
      clip.status = 'queued'; atomicJson(path.join(root, 'data/runtime/clip_upload_queue.json'), { jobs: [{ status: 'pending', clipIds: [51] }] });
    }
    atomicJson(metadataPath, saved); atomicJson(registryPath, registry); return 0;
  });
  const jobs = new AdminJobs(path.join(root, 'jobs'), run), planner = jest.fn(async () => JSON.stringify({ title: '模型标题', description: '翻车经过', coverText: '翻车', sourceKind: 'live_speech' }));
  const ordinary = new AdminFeedback(clips, jobs, run, planner);
  const feedback = new AdminCampaignFeedback(candidates, clips, jobs, run, ordinary);
  const token = 'a'.repeat(64), headers = { Authorization: `Bearer ${token}` };
  const app = createAdminServer({ clips, jobs, campaignCandidates: candidates, campaignFeedback: feedback, configs: new AdminConfigStore(root) }, token);
  const input = (extra = {}) => ({ revision: candidates.detail(id).revision, publishApproved: true, ...extra });
  return { clips, candidates, id, metadataPath, registryPath, statePath, metadata, srt, media, run, jobs, planner, feedback, app, headers, input };
}

it('registers only the selected recall and executes ordinary feedback in the same saved job, preserving a hand-written title', async () => {
  const f = fixture();
  const response = await request(f.app).post(`/campaign-candidates/${f.id}/actions`).set(f.headers).send(f.input({ title: '我手写的标题', note: '保留铺垫' })).expect(202);
  await f.jobs.flush();
  expect(f.jobs.list()).toHaveLength(1);
  expect(f.jobs.list()[0]).toMatchObject({ id: response.body.id, status: 'succeeded', edits: { title: '我手写的标题' }, plan: { clipId: '51', title: '我手写的标题' } });
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['register-campaign-candidate', 'import-campaign-candidate', 'rebuild', 'cut', 'enqueue']);
  expect(f.clips.record('51')).toMatchObject({ title: '我手写的标题', prefix: '【主播甲】', status: 'queued' });
  expect(Object.keys(f.clips.records())).toEqual(['51']); expect(f.candidates.list({}).total).toBe(2);
  expect(f.feedback.view(f.id).clip).toMatchObject({ id: 51, status: 'queued' });
  expect(() => f.feedback.submit(f.id, f.input({ title: '再次投稿' }))).toThrow('已投稿');
});
it('accepts title-only publication and retains the exact requested title over generated copy', async () => {
  const f = fixture(); f.feedback.submit(f.id, f.input({ title: '直接输入的标题' })); await f.jobs.flush();
  expect(f.jobs.list()[0]).toMatchObject({ note: '投', status: 'succeeded' });
  expect(f.clips.record('51').title).toBe('直接输入的标题');
});
it('deduplicates identical double submits and rejects conflicting concurrent opinions', async () => {
  const f = fixture(), body = f.input({ title: '标题' });
  const first = f.feedback.submit(f.id, body);
  expect(f.feedback.submit(f.id, body).id).toBe(first.id);
  expect(() => f.feedback.submit(f.id, { ...body, note: '另一意见' })).toThrow('正在处理');
  await f.jobs.flush(); expect(f.jobs.list()).toHaveLength(1);
});
it('retains failed intent across restart and reuses the registered ID without reimporting or overwriting', async () => {
  const f = fixture(), original = f.run.getMockImplementation()!;
  f.run.mockImplementation((command, output) => command.action === 'rebuild' ? Promise.resolve(1) : original(command, output));
  f.feedback.submit(f.id, f.input({ title: '失败也要保留', note: '从铺垫开始' })); await f.jobs.flush();
  expect(f.jobs.list()[0]).toMatchObject({ status: 'failed', plan: { clipId: '51' }, edits: { title: '失败也要保留' } });
  expect(f.run.mock.calls.some(([command]) => command.action === 'enqueue')).toBe(false);
  const restarted = new AdminJobs(path.join(root, 'jobs'), f.run);
  expect(restarted.latest('campaign-feedback-publish', f.id)?.edits?.title).toBe('失败也要保留');
  f.run.mockClear(); f.run.mockImplementation(original);
  f.feedback.submit(f.id, f.input({ title: '失败也要保留', note: '从铺垫开始' })); await f.jobs.flush();
  expect(f.jobs.latest('campaign-feedback-publish', f.id)?.status).toBe('succeeded');
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'cut', 'enqueue']);
  expect(Object.keys(f.clips.records())).toEqual(['51']);
});
it('rejects missing authorization, invalid titles, stale full-source revisions and unavailable media before any CLI runs', async () => {
  const f = fixture(), original = f.input();
  expect(() => f.feedback.submit(f.id, { ...original, publishApproved: false })).toThrow('授权');
  expect(() => f.feedback.submit(f.id, { ...original, title: 'x'.repeat(301) })).toThrow('标题');
  fs.appendFileSync(f.srt, '\n4\n00:10:01,000 --> 00:10:02,000\n窗外变化\n');
  expect(() => f.feedback.submit(f.id, original)).toThrow('已变化');
  fs.unlinkSync(f.media);
  expect(() => f.feedback.submit(f.id, f.input())).toThrow('原片');
  expect(f.run).not.toHaveBeenCalled();
});
it('prepares source-only metadata with clipped relative SRT and preserves an existing revision on retry', () => {
  const f = fixture();
  const uploadManifestPath = path.join(path.dirname(f.statePath), 'UPLOAD_MANIFEST.json');
  atomicJson(uploadManifestPath, { roomId: '100', upload: { prefix: '【主播甲】', tags: ['主播甲', '芙娅之魂', '活动标签'], tid: 17 } });
  atomicJson(f.statePath, { type: 'own_stream_review_state', metadata: { ...f.metadata, uploadManifestPath } });
  const registration = f.candidates.registration(f.id, f.input().revision);
  const input = { ...registration, id: f.id };
  expect(prepareCampaignCandidate(input)).toBe(f.metadataPath);
  const metadata = readJson(f.metadataPath);
  expect(metadata).toMatchObject({ status: 'selection_rejected', publicCopyPending: true, uploadReady: false, upload: { roomId: '100', prefix: '【主播甲】' }, output: { mediaPath: null, burnedSubtitles: false } });
  expect(metadata.upload).toMatchObject({ tags: ['主播甲', '芙娅之魂', '活动标签'], tid: 17 });
  const text = fs.readFileSync(metadata.output.srtPath, 'utf8');
  expect(text).toContain('00:00:00,000'); expect(text).toContain('00:00:10,000'); expect(text).not.toContain('00:00:21,000');
  metadata.copy.title = '已修改标题'; atomicJson(f.metadataPath, metadata);
  prepareCampaignCandidate(input); expect(readJson(f.metadataPath).copy.title).toBe('已修改标题');
});
it('refuses stale row identity and old ranking evidence without registering a candidate', async () => {
  const f = fixture(), registration = f.candidates.registration(f.id, f.input().revision);
  expect(() => prepareCampaignCandidate({ ...registration, id: f.id, selectionDigest: 'stale' })).toThrow('候选已变化');
  fs.appendFileSync(f.srt, '\n4\n00:01:01,000 --> 00:01:02,000\n原文变更\n');
  f.feedback.submit(f.id, f.input({ title: '标题' })); await f.jobs.flush();
  expect(f.jobs.list()[0].status).toBe('failed');
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['register-campaign-candidate']);
  expect(fs.existsSync(f.registryPath)).toBe(false);
});

it('imports prepared metadata through the actual locked Python CLI contract in an isolated runtime', () => {
  const f = fixture(), registration = f.candidates.registration(f.id, f.input().revision);
  const prepared = spawnSync(process.execPath, ['-r', 'ts-node/register', path.resolve(__dirname, '../../tools/clipping/promoteCampaignCandidate.ts'),
    '--state', registration.state, '--id', f.id, '--selection-digest', registration.selectionDigest, '--source-digest', registration.sourceDigest], {
    encoding: 'utf8', windowsHide: true
  });
  expect({ status: prepared.status, stderr: prepared.stderr }).toEqual({ status: 0, stderr: '' });
  expect(prepared.stdout).toContain('CAMPAIGN_CANDIDATE_RESULT:');
  const program = [
    'import sys', 'from pathlib import Path', 'from src.scripts import clip_upload_registry as registry',
    'registry.RUNTIME_DIR = Path(sys.argv[2])', 'registry.RUNTIME_DIR.mkdir(parents=True, exist_ok=True)',
    'registry.REGISTRY_PATH = registry.RUNTIME_DIR / "clip_upload_registry.json"',
    'registry.QUEUE_PATH = registry.RUNTIME_DIR / "clip_upload_queue.json"',
    'args = registry.build_parser().parse_args(["import-json", "--manifest", sys.argv[1], "--include-pending"])',
    'raise SystemExit(registry.import_json(args))'
  ].join('\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync('python', ['-c', program, f.metadataPath, path.join(root, 'data/runtime')], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toContain('REGISTRY_RESULT:');
  }
  expect(Object.keys(f.clips.records())).toEqual(['1']);
  expect(f.clips.record('1')).toMatchObject({ pendingCut: false, reviewPending: true, publicCopyPending: true,
    roomId: '100', streamerName: '主播甲', prefix: '【主播甲】', sourceMediaPath: f.media });
  expect(fs.existsSync(path.join(root, 'data/runtime/clip_upload_queue.json'))).toBe(false);
});
