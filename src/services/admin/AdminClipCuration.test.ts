import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdminClipStore } from './AdminClipStore';
import { atomicJson } from './AdminFiles';

test('Web lists both failed precision ordinary media and unrendered backups with source playback and curation reasons', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-curation-'));
  try {
    const assets = path.join(root, 'assets'); fs.mkdirSync(assets);
    const source = { mediaPath: path.join(assets, 'source.mp4'), srtPath: path.join(assets, 'source.srt') };
    fs.writeFileSync(source.mediaPath, 'recording');
    fs.writeFileSync(source.srtPath, '1\n00:00:10,000 --> 00:00:20,000\n完整故事\n');
    const ordinary = path.join(assets, 'ordinary.mp4'); fs.writeFileSync(ordinary, 'video');
    const failed = { source, window: { start: 10, end: 20 }, uploadReady: false,
      editorialStyle: { status: 'kept_original', failure: 'precision failed' }, output: { mediaPath: ordinary } };
    const deferred = { source, window: { start: 10, end: 20 }, uploadReady: false,
      curation: { status: 'covered', reason: '已有完整同题', peer: { bvid: 'BV1234567890' } }, output: {} };
    const records = Object.fromEntries([failed, deferred].map((metadata, index) => {
      const id = index + 1, metadataPath = path.join(assets, `${id}.json`); atomicJson(metadataPath, metadata);
      return [id, { id, title: `候选${id}`, status: 'review', metadataPath }];
    }));
    atomicJson(path.join(root, 'data/runtime/clip_upload_registry.json'), { clips: records });
    const store = new AdminClipStore(root, () => [assets]);
    expect(store.list({}).total).toBe(2);
    expect(store.detail('1')).toMatchObject({ media: true, source: { available: true }, clip: { issues: [expect.stringContaining('普通版可预览')] } });
    expect(store.detail('2')).toMatchObject({ media: false, source: { available: true, subtitles: expect.stringContaining('完整故事') },
      clip: { issues: [expect.stringContaining('已有完整同题')] }, evidence: { curation: deferred.curation } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
