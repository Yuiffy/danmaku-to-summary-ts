import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { identifyActivitySongs, researchNewSongPresentation } from './songResearchRuntime';
import { lyricDigest } from './songIdentity';

test('automatic naming applies supported evidence, preserves pending approval, and handles catalog outages', async () => {
  const row = { kind: 'songs', activityReview: { status: 'pending' }, uploadReady: false };
  const identify = jest.fn(async () => ({ status: 'identified', evidencePath: 'evidence.json', identified: [{ name: '测试' }], unresolved: [] }));
  const apply = jest.fn(async () => ({ ...row, copy: { title: '测试' } }));
  expect(await researchNewSongPresentation(row, { identify, apply })).toMatchObject({ copy: { title: '测试' }, activityReview: { status: 'pending' } });
  expect(apply).toHaveBeenCalledWith('evidence.json');
  identify.mockClear();
  await researchNewSongPresentation({ ...row, activityReview: { status: 'approved' } }, { identify, apply });
  expect(identify).not.toHaveBeenCalled();
  identify.mockRejectedValueOnce(new Error('outage'));
  expect(await researchNewSongPresentation(row, { identify, apply })).toMatchObject({ songResearch: { status: 'needs_review' }, uploadReady: false });
});

test('research persists provenance without mutating the package and rejects a source change during search', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'song-research-'));
  try {
    const transcript = { path: path.join(root, 'source.srt'), sha256: lyricDigest('source') };
    fs.writeFileSync(transcript.path, 'source');
    const file = path.join(root, 'songs.json');
    const original = JSON.stringify({ type: 'stream_activity_submission', kind: 'songs', transcript, source: {},
      activities: [{ id: 'a', kind: 'song', start: 0, end: 100 }] });
    fs.writeFileSync(file, original);
    const rows = ['沿着安静的小路走到山坡那一头', '晚风把云朵悄悄推到我的窗口', '明天把这些故事写进新画册里头']
      .map((text, i) => ({ index: i + 1, start: i * 20, end: i * 20 + 5, text }));
    const io = { parse: () => rows, audience: async () => [], propose: async () => '{"queries":[]}', catalog: {
      search: async () => [{ id: '123', name: '测试', artists: ['甲'] }],
      lyrics: async () => ({ id: '123', name: '测试', artists: ['甲'], lyrics: rows.map(row => row.text).join('\n'),
        url: 'https://music.163.com/song?id=123', lyricUrl: 'https://music.163.com/api/song/lyric?id=123&lv=-1&kv=-1&tv=-1', fetchedAt: new Date().toISOString() }) } };
    const result = await identifyActivitySongs(file, {}, io);
    expect(result.status).toBe('identified');
    expect(fs.existsSync(result.evidencePath)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    await expect(identifyActivitySongs(file, {}, { ...io, propose: async () => {
      fs.writeFileSync(transcript.path, 'changed'); return '{"queries":[]}';
    } })).rejects.toThrow('changed during');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
