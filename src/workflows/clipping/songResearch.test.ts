import { researchSong } from './songResearch';
import { lyricDigest } from './songIdentity';

const rows = ['沿着安静的小路走到山坡那一头', '晚风把云朵悄悄推到我的窗口', '明天把这些故事写进新画册里头']
  .map((text, index) => ({ index: index + 1, start: index * 20, end: index * 20 + 5, text }));

test('later lyric results retain a share of the bounded catalog comparison budget', async () => {
  const search = jest.fn(async (query: string) => Array.from({ length: 6 }, (_, index) => ({
    id: query === rows[0].text ? String(900 + index) : String(Number(query) * 10 + index),
    name: query === rows[0].text ? '本段歌曲' : '不相关歌曲', artists: ['甲'] })));
  const lyrics = jest.fn(async song => ({ ...song,
    lyrics: song.id === '900' ? rows.map(row => row.text).join('\n') : '别的歌词',
    url: `https://music.163.com/song?id=${song.id}`, fetchedAt: new Date().toISOString() }));
  const result = await researchSong({ event: { id: 'a', start: 0, end: 100 }, rows, audience: [],
    summaryHints: ['3', '4', '5', '6'], transcript: { path: 'source.srt', sha256: lyricDigest('source') } }, {
    propose: async () => JSON.stringify({ queries: [
      { kind: 'name', query: '1', segmentIndices: [1], danmakuIndices: [] },
      { kind: 'name', query: '2', segmentIndices: [2], danmakuIndices: [] },
      { kind: 'lyrics', query: rows[0].text, segmentIndices: [1], danmakuIndices: [] }
    ] }), catalog: { search, lyrics }
  });
  expect(result.status).toBe('identified');
  expect(search).toHaveBeenCalledWith(rows[0].text, 'lyrics');
  expect(lyrics).toHaveBeenCalledWith(expect.objectContaining({ id: '900' }));
  expect(lyrics).toHaveBeenCalledTimes(12);
  expect(search).toHaveBeenCalledTimes(4);
});

test('empty model searches fall back to local lyrics even when summary hints exist', async () => {
  const search = jest.fn(async () => []);
  await researchSong({ event: { id: 'a', start: 0, end: 100 }, rows, audience: [], summaryHints: ['其他歌'],
    transcript: { path: 'source.srt', sha256: lyricDigest('source') } }, {
    propose: async () => '{"queries":[]}', catalog: { search, lyrics: jest.fn() }
  });
  expect(search).toHaveBeenCalledWith(rows[0].text, 'lyrics');
  expect(search).toHaveBeenCalledWith('其他歌', 'name');
  expect(search).toHaveBeenCalledTimes(4);
});
