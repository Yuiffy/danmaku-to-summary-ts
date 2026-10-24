import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AdminCampaignCandidates } from './AdminCampaignCandidates';
import { AdminClipStore } from './AdminClipStore';
import { AdminConfigStore } from './AdminConfigStore';
import { AdminJobs } from './AdminJobs';
import { AdminSourceMedia } from './AdminSourceMedia';
import { createAdminServer } from './AdminServer';
import { atomicJson } from './AdminFiles';

let root: string;
const campaign = { id: 'fuya', requiredGames: ['芙娅之魂'], roomIds: ['100', '200'], startsAt: '2026-10-22T00:00:00+08:00', endsAt: '2026-11-06T00:00:00+08:00' };
const token = 'x'.repeat(64), headers = { Authorization: `Bearer ${token}` };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-preview-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const recordings = path.join(root, 'recordings'); fs.mkdirSync(recordings);
  const clips = new AdminClipStore(root, () => [recordings]);
  const candidates = new AdminCampaignCandidates(clips, () => [recordings], () => [campaign]);
  const run = jest.fn(async () => 0), jobs = new AdminJobs(path.join(root, 'jobs'), run);
  const remux = jest.fn(async () => '');
  const app = createAdminServer({ clips, campaignCandidates: candidates, jobs, configs: new AdminConfigStore(root),
    sourceMedia: new AdminSourceMedia(path.join(root, 'previews'), () => 'ffmpeg', remux) }, token);
  function session(room: string, day: string, early = false) {
    const directory = path.join(recordings, `${room}_主播${room}`, day, ...(early ? ['campaign_early', 'batch'] : []));
    fs.mkdirSync(directory, { recursive: true });
    const media = path.join(directory, 'source.mp4'), srt = path.join(directory, 'source.srt');
    fs.writeFileSync(media, '0123456789');
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:02,000\n窗外\n\n2\n00:00:11,000 --> 00:00:12,000\n候选原话\n\n3\n00:00:31,000 --> 00:00:32,000\n窗外结尾\n');
    const statePath = path.join(directory, 'own_stream_fun_clips/REVIEW_STATE.json');
    const metadata = { roomId: room, streamerName: `主播${room}`, recordedAt: `${day.replace(/_/gu, '-')} 12:00:00`, streamTitle: '玩芙娅之魂',
      source: { mediaPath: media, srtPath: srt },
      aiStatus: { ranking: { sourceSha256: 'srt-evidence', skipped: [10, 2, 1].map(candidateIndex => ({ candidateIndex, title: `话题${candidateIndex}`, start: 10, end: 20, score: 80, reason: '备选原因' })) } } };
    atomicJson(statePath, { type: 'own_stream_review_state', metadata });
    return { media, srt, statePath, metadata };
  }
  return { candidates, clips, session, app, run, remux };
}
it('discovers zero-ID sessions and early batches, isolates repeated R labels and filters before paginating', () => {
  const f = fixture();
  f.session('100', '2026_10_23'); f.session('200', '2026_10_24', true);
  f.session('999', '2026_10_24'); f.session('100', '2026_10_01');
  const all = f.candidates.list({});
  expect(all.total).toBe(6);
  expect(all.candidates.map(row => row.label)).toEqual(['R1', 'R2', 'R10', 'R1', 'R2', 'R10']);
  expect(new Set(all.candidates.map(row => row.id)).size).toBe(6);
  expect(all.rooms.map(row => row.name).sort()).toEqual(['主播100', '主播200']);
  expect(f.candidates.list({ room: '100' }).total).toBe(3);
  expect(f.candidates.list({ session: all.candidates[0].session }).total).toBe(3);
  expect(f.candidates.list({ search: 'r2' }).total).toBe(2);
  expect(f.clips.list({}).total).toBe(0);
  expect(fs.existsSync(path.join(root, 'data/runtime/clip_upload_registry.json'))).toBe(false);
});
it('merges saved selection history without duplicating the same candidate across review revisions', () => {
  const f = fixture(), s = f.session('100', '2026_10_23');
  const history = { phase: 'ranking', label: 'R20', selectionKey: 'historic:20', sourceMediaPath: s.media, sourceSrtPath: s.srt, title: '保留旧备选', start: 10, end: 20 };
  atomicJson(s.statePath, { type: 'own_stream_review_state', metadata: { ...s.metadata, deferredSelectionHistory: { rows: [history] },
    publication: { policy: { mode: 'enforce' }, decisions: [{ index: 4, selected: false, title: '发布备选', start: 10, end: 20 }] } } });
  atomicJson(s.statePath.replace('REVIEW_STATE', 'REVIEW_OLD_STATE'), { type: 'own_stream_review_state', metadata: s.metadata });
  const rows = f.candidates.list({}).candidates;
  expect(rows.map(row => row.label)).toEqual(['P4', 'R1', 'R2', 'R10', 'R20']);
  expect(rows.find(row => row.label === 'R20')?.title).toBe('保留旧备选');
});
it('sorts by score or natural candidate number across sessions with stable ties and unscored candidates last', () => {
  const f = fixture(), older = f.session('100', '2026_10_23'), newer = f.session('200', '2026_10_24');
  for (const [session, scores] of [[older, [undefined, 0, 99]], [newer, [20, 99, 80]]] as const) {
    atomicJson(session.statePath, { type: 'own_stream_review_state', metadata: { ...session.metadata,
      aiStatus: { ranking: { ...session.metadata.aiStatus.ranking,
        skipped: session.metadata.aiStatus.ranking.skipped.map((row, index) => ({ ...row, score: scores[index] })) } } } });
  }
  const identities = (sort?: string) => f.candidates.list({ sort }).candidates.map(row => `${row.roomId}:${row.label}`);
  expect(identities('score-desc')).toEqual(['200:R2', '100:R1', '200:R1', '200:R10', '100:R2', '100:R10']);
  expect(identities('score-asc')).toEqual(['100:R2', '200:R10', '200:R1', '200:R2', '100:R1', '100:R10']);
  expect(identities('number-asc')).toEqual(['200:R1', '100:R1', '200:R2', '100:R2', '200:R10', '100:R10']);
  expect(identities('number-desc')).toEqual(['200:R10', '100:R10', '200:R2', '100:R2', '200:R1', '100:R1']);
  expect(identities('invalid-sort')).toEqual(identities());
  expect(f.candidates.list({ sort: 'invalid-sort' }).sort).toBe('session');
  const selectedSession = f.candidates.list({ room: '100' }).candidates[0].session;
  expect(f.candidates.list({ room: '100', session: selectedSession, search: '话题', sort: 'score-asc' }).candidates.map(row => row.label)).toEqual(['R2', 'R1', 'R10']);
});
it('forwards sorting through the API and sorts all matching candidates before pagination', async () => {
  const f = fixture(), s = f.session('100', '2026_10_23');
  atomicJson(s.statePath, { type: 'own_stream_review_state', metadata: { ...s.metadata,
    aiStatus: { ranking: { ...s.metadata.aiStatus.ranking, skipped: Array.from({ length: 85 }, (_, index) => ({
      candidateIndex: index + 1, title: `话题${index + 1}`, start: 10, end: 20, score: index
    })) } } } });
  const get = async (sort: string, page: number) => (await request(f.app).get(`/campaign-candidates?room=100&sort=${sort}&page=${page}`).set(headers).expect(200)).body;
  const pages = await Promise.all([1, 2, 3].map(page => get('score-desc', page)));
  expect(pages.map(page => page.candidates.length)).toEqual([40, 40, 5]);
  expect(pages.every(page => page.total === 85 && page.sort === 'score-desc')).toBe(true);
  expect(pages.flatMap(page => page.candidates.map((row: any) => row.score))).toEqual(Array.from({ length: 85 }, (_, index) => 84 - index));
  expect(new Set(pages.flatMap(page => page.candidates.map((row: any) => row.id))).size).toBe(85);
  expect((await get('number-asc', 1)).candidates.slice(0, 3).map((row: any) => row.label)).toEqual(['R1', 'R2', 'R3']);
  expect((await get('number-desc', 1)).candidates[0].label).toBe('R85');
  expect((await get('score-asc', 1)).candidates[0].score).toBe(0);
});
it('ignores unrelated streams and malformed states while admitting explicitly bound campaign plans', () => {
  const f = fixture(), s = f.session('100', '2026_10_23'), other = f.session('200', '2026_10_24');
  s.metadata.streamTitle = '唱歌'; atomicJson(s.statePath, { type: 'own_stream_review_state', metadata: s.metadata });
  const planPath = path.join(path.dirname(other.statePath), 'PLAN.json');
  atomicJson(planPath, { config: { campaignContentGate: { id: 'fuya' } } });
  atomicJson(other.statePath, { type: 'own_stream_review_state', metadata: { ...other.metadata, streamTitle: '我魂测试', planPath } });
  fs.writeFileSync(s.statePath.replace('REVIEW_STATE', 'REVIEW_CORRUPT_STATE'), '{broken');
  expect(f.candidates.list({}).candidates.map(row => row.roomId)).toEqual(['200', '200', '200']);
});
it('returns only window subtitles, streams byte ranges and leaves all workflow files untouched', async () => {
  const f = fixture(), s = f.session('100', '2026_10_23'), before = fs.readFileSync(s.statePath, 'utf8');
  await request(f.app).get('/campaign-candidates').expect(403);
  const list = (await request(f.app).get('/campaign-candidates?search=R1').set(headers).expect(200)).body;
  const id = list.candidates[0].id;
  const detail = (await request(f.app).get(`/campaign-candidates/${id}`).set(headers).expect(200)).body;
  expect(detail.subtitles).toContain('候选原话'); expect(detail.subtitles).not.toContain('窗外');
  expect(JSON.stringify(list)).not.toContain(root); expect(JSON.stringify(detail)).not.toContain(root);
  expect((await request(f.app).get(`/campaign-candidates/${id}/source-playback`).set(headers).expect(200)).body).toEqual({ origin: 0, start: 10, end: 20 });
  const media = await request(f.app).get(`/campaign-candidates/${id}/assets/source-preview`).set(headers).set('Range', 'bytes=0-3').expect(206);
  expect(media.headers['content-range']).toBe('bytes 0-3/10');
  expect(fs.readFileSync(s.statePath, 'utf8')).toBe(before);
  expect(f.run).not.toHaveBeenCalled(); expect(f.remux).not.toHaveBeenCalled();
});
it('revalidates media and rejects arbitrary or unavailable candidates without exposing paths', async () => {
  const f = fixture(), s = f.session('100', '2026_10_23');
  const id = f.candidates.list({}).candidates[0].id;
  fs.unlinkSync(s.media);
  expect(f.candidates.detail(id).candidate.previewAvailable).toBe(false);
  await request(f.app).get(`/campaign-candidates/${id}/source-playback`).set(headers).expect(404);
  await request(f.app).get('/campaign-candidates/invalid').set(headers).expect(400);
  await request(f.app).get(`/campaign-candidates/${'a'.repeat(64)}`).set(headers).expect(404);
  const outside = path.join(root, 'private.mp4'); fs.writeFileSync(outside, 'private');
  atomicJson(s.statePath, { type: 'own_stream_review_state', metadata: { ...s.metadata, source: { mediaPath: outside, srtPath: s.srt } } });
  const fresh = new AdminCampaignCandidates(f.clips, () => [path.join(root, 'recordings')], () => [campaign]);
  expect(fresh.detail(fresh.list({}).candidates[0].id).candidate.previewAvailable).toBe(false);
});
