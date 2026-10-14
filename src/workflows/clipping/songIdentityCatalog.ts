import type fetch from 'node-fetch';
import { CatalogSong } from './songIdentity';

export interface MusicCandidate { id: string; name: string; artists: string[] }
export interface SongCatalog {
  search(query: string, kind: 'name' | 'lyrics'): Promise<MusicCandidate[]>;
  lyrics(candidate: MusicCandidate): Promise<CatalogSong>;
}
/** Read-only catalog access: fixed HTTPS endpoints, no account cookie and no arbitrary URLs. */
export function createSongCatalog(transport: typeof fetch = require('node-fetch')): SongCatalog {
  const json = async (url: URL): Promise<any> => {
    const response = await transport(url.toString(), { redirect: 'error', timeout: 20000, size: 512 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } });
    if (!response.ok) throw new Error(`Song catalog HTTP ${response.status}`);
    const data = await response.json() as any;
    if (data.code !== 200) throw new Error('Song catalog returned an unavailable result');
    return data;
  };
  return {
    async search(query, kind) {
      if (!['name', 'lyrics'].includes(kind) || typeof query !== 'string' || !query.trim() || query.length > 120 || query.includes('\0')) throw new Error('Invalid song search');
      const url = new URL('https://music.163.com/api/search/get');
      url.search = new URLSearchParams({ s: query, type: kind === 'lyrics' ? '1006' : '1', limit: '6' }).toString();
      const data = await json(url);
      return (data.result?.songs || []).slice(0, 6).filter((song: any) => Number.isSafeInteger(song.id) && song.id > 0
        && typeof song.name === 'string' && song.name.length <= 200).map((song: any) => ({ id: String(song.id), name: song.name,
        artists: (song.artists || []).map((artist: any) => artist.name).filter((name: any) => typeof name === 'string').slice(0, 12) }));
    },
    async lyrics(candidate) {
      if (!/^[1-9]\d{0,14}$/u.test(candidate.id)) throw new Error('Invalid catalog song ID');
      const url = new URL('https://music.163.com/api/song/lyric');
      url.search = new URLSearchParams({ id: candidate.id, lv: '-1', kv: '-1', tv: '-1' }).toString();
      const data = await json(url), lyrics = data.lrc?.lyric;
      if (typeof lyrics !== 'string' || !lyrics.trim() || lyrics.length > 50000) throw new Error('Song lyrics unavailable');
      return { ...candidate, lyrics, url: `https://music.163.com/song?id=${candidate.id}`, lyricUrl: url.toString(), fetchedAt: new Date().toISOString() };
    }
  };
}
