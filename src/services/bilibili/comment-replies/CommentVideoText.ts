import fetch from 'node-fetch';
import { CommentPlatformBlocked, positiveId } from './CommentPolicy';
import { CommentVideo, safeEvidenceText } from './CommentContext';

export const BILIBILI_WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
class SubtitleReadUnavailable extends Error {}

/** Only platform-issued subtitle CDN URLs; never forward credentials or follow redirects. */
export function subtitleUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid subtitle URL');
  const url = new URL(value.startsWith('//') ? `https:${value}` : value);
  const path = decodeURIComponent(url.pathname);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      !['aisubtitle.hdslb.com', 'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com'].includes(url.hostname) ||
      !/^\/bfs\/(?:ai_subtitle|subtitle)\/[a-zA-Z0-9/_.-]+$/u.test(path) || path.includes('..')) {
    throw new Error('Invalid subtitle URL');
  }
  return url.href;
}

export async function readVideoTranscript(aid: string, cid: string, headers: Record<string, string>,
  signal: AbortSignal, transport = fetch, duration?: number): Promise<CommentVideo['transcript']> {
  if (!positiveId(aid) || !positiveId(cid)) throw new Error('Invalid subtitle target');
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 9000);
  const read = async (url: string, cdn: boolean): Promise<any> => {
    controller.signal.throwIfAborted();
    let response;
    try {
      response = await transport(url, {
        headers: cdn ? { Referer: 'https://www.bilibili.com/', 'User-Agent': BILIBILI_WEB_UA } :
          { ...headers, 'User-Agent': BILIBILI_WEB_UA, Referer: `https://www.bilibili.com/video/av${aid}/` },
        signal: controller.signal as any, redirect: 'error', timeout: 3000, size: (cdn ? 1024 : 512) * 1024
      });
    } catch { controller.signal.throwIfAborted(); throw new SubtitleReadUnavailable('Subtitle request unavailable'); }
    if ([401, 403, 412, 429].includes(response.status)) throw new CommentPlatformBlocked('Video subtitles blocked by platform');
    let body;
    try { body = JSON.parse(await response.text()); }
    catch { controller.signal.throwIfAborted(); throw new SubtitleReadUnavailable('Subtitle response unavailable'); }
    if (!cdn && [-101, -111, -352, -403, -412].includes(body?.code)) throw new CommentPlatformBlocked('Video subtitles blocked by platform');
    if (!response.ok) throw new SubtitleReadUnavailable('Subtitle request unavailable');
    if (!cdn && body?.code !== 0) throw new SubtitleReadUnavailable('Subtitle directory unavailable');
    return body;
  };
  try {
    let downloads = 0;
    // A listed AI track may temporarily have no URL. Refresh only fixed read endpoints;
    // yt-dlp's Bilibili extractor also uses player/wbi/v2 for subtitle discovery.
    for (const endpoint of ['v2', 'wbi/v2', 'v2']) {
      controller.signal.throwIfAborted();
      try {
        const data = (await read(`https://api.bilibili.com/x/player/${endpoint}?aid=${aid}&cid=${cid}`, false))?.data;
        if (positiveId(data?.aid) !== aid || positiveId(data?.cid) !== cid || !Array.isArray(data?.subtitle?.subtitles)) {
          throw new Error('Video subtitles unavailable: target mismatch');
        }
        if (data.need_login_subtitle) return undefined;
        // Prefer submitted Chinese over automatic Chinese, then one other available language.
        const tracks = data.subtitle.subtitles.slice(0, 32).filter((track: any) =>
          typeof track?.lan === 'string' && (track.subtitle_url || track.subtitle_url_v2));
        const track = tracks.find((v: any) => /^zh/u.test(v.lan)) || tracks.find((v: any) => v.lan === 'ai-zh') || tracks[0];
        if (!track) continue;
        const url = subtitleUrl(track.subtitle_url || track.subtitle_url_v2), assetPath = new URL(url).pathname;
        if (assetPath.startsWith('/bfs/ai_subtitle/prod/') && !assetPath.startsWith(`/bfs/ai_subtitle/prod/${aid}${cid}`)) {
          // Some successful directory responses point at another video's AI asset.
          // Discard it without CDN IO, then ask the next fixed endpoint for this same target.
          continue;
        }
        downloads++;
        const transcript = parseTranscript(await read(url, true), track.lan, duration);
        if (transcript) return transcript;
      } catch (error) { if (!(error instanceof SubtitleReadUnavailable)) throw error; }
      if (downloads >= 2) break;
    }
    return undefined;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

function parseTranscript(payload: any, language: string, duration?: number): CommentVideo['transcript'] {
  if (!Array.isArray(payload.body) || payload.body.length > 10000) throw new Error('Invalid subtitle payload');
  // A successful JSON response can still be the wrong asset. Reject contradictory timelines wholesale.
  if (duration && payload.body.some((cue: any) => Number.isFinite(cue.to) && cue.to > duration + 5)) {
    throw new Error('Subtitle timeline does not match video');
  }
  let chars = 0;
  const cues = payload.body.flatMap((cue: any) => {
    if (!Number.isFinite(cue.from) || !Number.isFinite(cue.to) || cue.from < 0 || cue.to < cue.from || cue.to > 604800 ||
        typeof cue.content !== 'string' || cue.content.length > 180 || chars + cue.content.length > 100000) return [];
    const text = safeEvidenceText(cue.content, 180);
    if (!text) return [];
    chars += text.length; return [{ at: cue.from, text }];
  }).sort((a: { at: number }, b: { at: number }) => a.at - b.at);
  return cues.length ? { language: language.slice(0, 20), cues, partial: cues.length !== payload.body.length } : undefined;
}
