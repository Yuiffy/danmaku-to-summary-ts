import { CatalogSong, identifySongFromCatalog, lyricDigest, SongRow, songWorkKey, songWorkName, validateCatalogTitle } from './songIdentity';
import { researchSong } from './songResearch';
import { createSongCatalog } from './songIdentityCatalog';
import { bindTranscriptTitles } from './activityTitles';

const event = { id: 'activity-2', start: 100, end: 180 };
const rows: SongRow[] = [
  { index: 1, start: 110, end: 114, text: '沿着安静的小路走到山坡那一头' },
  { index: 2, start: 124, end: 128, text: '晚风把云朵悄悄推到我的窗口' },
  { index: 3, start: 140, end: 145, text: '明天把这些故事写进新画册里头' }
];
const song: CatalogSong = { id: '123', name: '测试之歌', artists: ['测试歌手'], lyrics: rows.map(row => row.text).join('\n'),
  url: 'https://music.163.com/song?id=123', lyricUrl: 'https://music.163.com/api/song/lyric?id=123&lv=-1&kv=-1&tv=-1', fetchedAt: '2026-10-13T00:00:00Z' };

test('restyling after a boundary repair rematches known catalog lyrics without accepting discarded citations', () => {
  const allRows = [{ index: 1, start: 101, end: 105, text: rows[0].text }, ...rows.map(r => ({ ...r, index: r.index + 1 }))];
  const transcript = { path: 'source.srt', sha256: 'bound' };
  const original = identifySongFromCatalog(event, allRows, [song], transcript);
  if (original.status !== 'identified') throw new Error('fixture');
  expect(original.item.segments[0].start).toBe(101);
  const narrowed = { ...event, start: 109 };
  const refreshed = bindTranscriptTitles([original.item], [narrowed], allRows, transcript).items[0];
  expect(refreshed.segments.every((r: SongRow) => r.start >= narrowed.start)).toBe(true);
  expect(() => validateCatalogTitle(refreshed, narrowed, allRows, transcript)).not.toThrow();
  expect(() => bindTranscriptTitles([original.item], [{ ...event, start: 130 }], allRows, transcript)).toThrow('no longer supports');
  expect(() => bindTranscriptTitles([original.item], [narrowed], allRows, { ...transcript, sha256: 'changed' })).toThrow('Invalid');
});
const transcript = { path: '/source.srt', sha256: lyricDigest('source') };

test('identifies a work from three separate local lyric lines even without a spoken title', () => {
  const result = identifySongFromCatalog(event, rows, [song], transcript);
  expect(result).toMatchObject({ status: 'identified', item: { name: song.name, method: 'catalog_lyric_match', activityId: event.id,
    transcriptSha256: transcript.sha256, catalog: { lyricSha256: lyricDigest(song.lyrics) } } });
  expect(result).not.toHaveProperty('approved');
});
test('a repeated line, another activity, or competing supported work names do not identify a song', () => {
  const repeated = rows.map(row => ({ ...row, text: rows[0].text }));
  expect(identifySongFromCatalog(event, repeated, [song], transcript).status).toBe('unresolved');
  expect(identifySongFromCatalog({ ...event, start: 150 }, rows, [song], transcript).status).toBe('unresolved');
  expect(identifySongFromCatalog(event, rows, [song, { ...song, id: '456', name: '另一首歌' }], transcript).status).toBe('unresolved');
});
test('album duplicate and live editions of the same named work do not create a false conflict', () => {
  expect(identifySongFromCatalog(event, rows, [song, { ...song, id: '456', name: '测试之歌 (Studio Live Ver.)' }], transcript))
    .toMatchObject({ status: 'identified', item: { name: '测试之歌' } });
});
test('normalizes explicit cover presentation and performer prefixes without merging distinct songs', () => {
  expect(songWorkName('测试之歌（X Studio COVER）')).toBe('测试之歌');
  expect(songWorkName('《测试之歌》12p多人翻唱')).toBe('测试之歌');
  expect(songWorkName('【甲/乙】测试之歌', ['甲', '乙'])).toBe('测试之歌');
  expect(songWorkName('【夜】测试之歌', ['甲', '乙'])).toBe('【夜】测试之歌');
  expect(songWorkName('测试之歌2')).toBe('测试之歌2');
  expect(songWorkKey('天之若')).toBe(songWorkKey('天ノ弱'));
});
test('summary hint plus nearby spoken announcement can resolve a short or garbled lyric capture', () => {
  const contextRows = [{ index: 0, start: 90, end: 95, text: '那我唱天之若了' }, ...rows];
  const result = identifySongFromCatalog(event, contextRows, [{ ...song, name: '天ノ弱', lyrics: '无法从本段字幕匹配的目录歌词' }], transcript, { hints: ['天之若'] });
  expect(result).toMatchObject({ status: 'identified', item: { name: '天之若', method: 'catalog_title_context_match', titleAlias: { source: 'recording_summary_hint' } } });
  if (result.status !== 'identified') throw new Error('expected context match');
  expect(() => validateCatalogTitle(result.item, event, contextRows, transcript)).not.toThrow();
});
test('packaging revalidates original rows, catalog identity and lyric digests', () => {
  const result = identifySongFromCatalog(event, rows, [song], transcript);
  if (result.status !== 'identified') throw new Error('expected fixture match');
  expect(() => validateCatalogTitle(result.item, event, rows, transcript)).not.toThrow();
  expect(() => validateCatalogTitle({ ...result.item, name: '另一首歌' }, event, rows, transcript)).toThrow('Invalid');
  expect(() => validateCatalogTitle(result.item, event, [{ ...rows[0], text: '原文变化' }, ...rows.slice(1)], transcript)).toThrow('differs');
});
test('uses nearby song-request comments for discovery but rejects the suggested name without matching lyrics', async () => {
  const search = jest.fn(async () => [{ id: '123', name: '弹幕误点的歌', artists: [] }]);
  const propose = jest.fn(async prompt => {
    expect(prompt).toContain('点一首测试之歌'); expect(prompt).not.toContain('远处的点歌');
    return JSON.stringify({ queries: [{ kind: 'name', query: '测试之歌', segmentIndices: [], danmakuIndices: [1] }] });
  });
  const result = await researchSong({ event, rows, transcript, audience: [{ index: 1, time: 90, text: '点一首测试之歌' },
    { index: 2, time: 10000, text: '远处的点歌' }] }, { propose, catalog: { search, lyrics: async () => ({ ...song, lyrics: '完全无关的歌曲歌词' }) } });
  expect(search).toHaveBeenCalledWith('测试之歌', 'name'); expect(result.status).toBe('unresolved');
  expect(result.discovery.audience).toEqual([{ index: 1, time: 90, text: '点一首测试之歌' }]);
});
test('automatically searches recording summary song hints before model proposals', async () => {
  const search = jest.fn(async (query: string) => query === '天之若' ? [{ id: '123', name: '天ノ弱', artists: [] }] : []);
  const propose = jest.fn(async () => JSON.stringify({ queries: [] }));
  const result = await researchSong({ event, rows: [{ index: 0, start: 90, end: 95, text: '那我唱天之若了' }, ...rows], transcript,
    audience: [], summaryHints: ['天之若'] }, { propose, catalog: { search, lyrics: async () => ({ ...song, name: '天ノ弱', lyrics: '无关歌词' }) } });
  expect(search).toHaveBeenCalledWith('天之若', 'name');
  expect(result).toMatchObject({ status: 'identified', item: { name: '天之若', method: 'catalog_title_context_match' } });
});
test('provider failure falls back to literal local lyric queries and still requires cross-checking', async () => {
  const search = jest.fn(async () => [{ id: song.id, name: song.name, artists: song.artists }]);
  const result = await researchSong({ event, rows, transcript, audience: [] }, { propose: async () => { throw new Error('offline'); },
    catalog: { search, lyrics: async () => song } });
  expect(result.status).toBe('identified'); expect(search).toHaveBeenCalledTimes(3);
  expect(result.discovery.errors).toHaveLength(1);
});
test('catalog adapter encodes queries and only reads fixed endpoints with bounded requests', async () => {
  const transport = jest.fn(async () => ({ ok: true, json: async () => ({ code: 200, result: { songs: [{ id: 123, name: song.name, artists: [{ name: '测试歌手' }] }] } }) }));
  const catalog = createSongCatalog(transport as any);
  await expect(catalog.search('歌词 & limit=999', 'lyrics')).resolves.toEqual([{ id: '123', name: song.name, artists: ['测试歌手'] }]);
  const url = new URL(transport.mock.calls[0][0]);
  expect(url.hostname).toBe('music.163.com'); expect(url.searchParams.get('limit')).toBe('6');
  expect(url.searchParams.get('s')).toBe('歌词 & limit=999'); expect(url.searchParams.get('type')).toBe('1006');
  await expect(catalog.lyrics({ id: '../secrets', name: '', artists: [] })).rejects.toThrow('Invalid');
});
