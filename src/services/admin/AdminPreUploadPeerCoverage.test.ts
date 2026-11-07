import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdminClipStore } from './AdminClipStore';
import { atomicJson } from './AdminFiles';
import { AdminPreUploadPeerCoverage } from './AdminPreUploadPeerCoverage';

const roots: string[] = [];
function fixture(api: any, now: number | (() => number) = 1_800_000_000_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-upload-peer-')); roots.push(root);
  const assets = path.join(root, 'recordings'); fs.mkdirSync(assets);
  const media = path.join(assets, 'source.mp4'), srt = path.join(assets, 'source.srt'), metadataPath = path.join(assets, 'clip.json');
  fs.writeFileSync(media, 'media');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\n起因突然出现\n\n2\n00:00:01,000 --> 00:00:02,000\n事情继续发展\n\n3\n00:00:02,000 --> 00:00:03,000\n结果完成收尾\n');
  atomicJson(metadataPath, { source: { mediaPath: media, srtPath: srt }, window: { start: 0, end: 3 }, output: { mediaPath: media, srtPath: srt } });
  atomicJson(path.join(root, 'data/runtime/clip_upload_registry.json'), { clips: {
    '3354': { id: 3354, title: '小岁起因发展结果', description: '完整事件', status: 'review', roomId: '25788785', streamerName: '小岁',
      mediaPath: media, sourceMediaPath: media, sourceSrtPath: srt, metadataPath, reviewPending: false }
  } });
  const clips = new AdminClipStore(root, () => [assets]);
  const config = { clipCuration: { enabled: true, maxSearchResults: 5, maxSearchQueries: 4, supportActions: ['like', 'favorite', 'repost'], maxSupportPerDay: 10, supportIntervalSeconds: 30 },
    bilibili: { cookie: 'SESSDATA=x; bili_jct=y; DedeUserID=99' } };
  const gate = new AdminPreUploadPeerCoverage(root, clips, () => config, async () => JSON.stringify({}), { apiFactory: () => api, now: typeof now === 'function' ? now : () => now });
  return { root, clips, gate, detail: clips.detail('3354') };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function apiWithSearch(result: any[] = []) {
  return { accountId: jest.fn(async () => '99'), search: jest.fn(async () => result), read: jest.fn(), has: jest.fn(async () => false),
    act: jest.fn(async () => ({ ok: true })), defaultFolder: jest.fn(async () => '1') };
}

it('uses the persistent original cache without searching again', async () => {
  const api = apiWithSearch();
  const f = fixture(api);
  const first = await f.gate.check('3354', f.detail, jest.fn(), jest.fn());
  const second = await f.gate.check('3354', f.detail, jest.fn(), jest.fn());
  expect(first.status).toBe('original');
  expect(second).toMatchObject({ status: 'original', cached: true });
  expect(api.search).toHaveBeenCalledTimes(1);
  expect(f.clips.detail('3354').evidence.preUploadPeerCoverage.status).toBe('original');
});

it('reuses one fresh recent index across different clips', async () => {
  const api = apiWithSearch();
  const f = fixture(api);
  const first = await f.gate.check('3354', f.detail, jest.fn(), jest.fn());
  const other = { ...f.detail, title: '另一条事件' };
  const second = await f.gate.check('3354', other, jest.fn(), jest.fn());
  expect(first.status).toBe('original');
  expect(second.status).toBe('original');
  expect(api.search).toHaveBeenCalledTimes(1);
});

it('refreshes the shared recent index after its short freshness window', async () => {
  let now = 1_800_000_000_000;
  const api = apiWithSearch(), f = fixture(api, () => now);
  await f.gate.check('3354', f.detail, jest.fn(), jest.fn());
  now += 2 * 60 * 1000 + 1;
  await f.gate.check('3354', { ...f.detail, title: '稍后同一事件' }, jest.fn(), jest.fn());
  expect(api.search).toHaveBeenCalledTimes(2);
});

it('supports and blocks a confirmed duplicate', async () => {
  const peer = { bvid: 'BV1abcdefgh1', aid: '123', ownerId: '88', title: '同题成片', description: '', publishedAt: 1,
    duration: 3, complete: true, cues: [
      { id: 'P1', start: 0, end: 1, text: '起因突然出现' }, { id: 'P2', start: 1, end: 2, text: '事情继续发展' }, { id: 'P3', start: 2, end: 3, text: '结果完成收尾' }
    ] };
  const api = apiWithSearch([peer]); api.read.mockResolvedValue(peer);
  const f = fixture(api);
  (f.gate as any).request = async () => JSON.stringify({ sameEvent: true, complete: true, quality: true, reason: '对方完整覆盖同一事件',
    anchors: [{ sourceId: 'S1', peerId: 'P1', quote: '起因突然出现' }, { sourceId: 'S2', peerId: 'P2', quote: '事情继续发展' }],
    beats: { setup: { sourceId: 'S1', peerId: 'P1' }, development: { sourceId: 'S2', peerId: 'P2' }, payoff: { sourceId: 'S3', peerId: 'P3' } } });
  const result = await f.gate.check('3354', f.detail, jest.fn(), jest.fn());
  expect(result.status).toBe('covered');
  expect(api.has).toHaveBeenCalled();
  expect(f.clips.detail('3354').evidence.preUploadPeerCoverage.status).toBe('covered');
});
