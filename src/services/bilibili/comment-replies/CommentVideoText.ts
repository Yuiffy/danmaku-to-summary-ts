import fetch from 'node-fetch';
import { CommentPlatformBlocked, positiveId } from './CommentPolicy';
import { CommentVideo, safeEvidenceText } from './CommentContext';

export const BILIBILI_WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
  const response = await transport(`https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`, {
    headers, signal: signal as any, redirect: 'error', timeout: 3000, size: 512 * 1024
  });
  if ([403, 412, 429].includes(response.status)) throw new CommentPlatformBlocked('Video subtitles blocked by platform');
  const body = JSON.parse(await response.text()), data = body?.data;
  if ([-101, -111, -352, -403, -412].includes(body?.code)) throw new CommentPlatformBlocked('Video subtitles blocked by platform');
  if (!response.ok || body.code !== 0 || positiveId(data?.aid) !== aid || positiveId(data?.cid) !== cid ||
      !Array.isArray(data?.subtitle?.subtitles)) throw new Error('Video subtitles unavailable');
  // Prefer submitted Chinese over automatic Chinese, then a single other available language.
  const tracks = data.subtitle.subtitles.slice(0, 32).filter((track: any) => typeof track.lan === 'string' && track.subtitle_url);
  const track = tracks.find((v: any) => /^zh/u.test(v.lan)) || tracks.find((v: any) => v.lan === 'ai-zh') || tracks[0];
  if (!track) return undefined;
  const url = subtitleUrl(track.subtitle_url);
  const assetPath = new URL(url).pathname;
  if (assetPath.startsWith('/bfs/ai_subtitle/prod/') && !assetPath.startsWith(`/bfs/ai_subtitle/prod/${aid}${cid}`)) {
    throw new Error('Subtitle asset does not match video');
  }
  const subtitles = await transport(url, {
    headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': BILIBILI_WEB_UA }, signal: signal as any,
    redirect: 'error', timeout: 3000, size: 1024 * 1024
  });
  if ([403, 412, 429].includes(subtitles.status)) throw new CommentPlatformBlocked('Subtitle CDN blocked by platform');
  if (!subtitles.ok) throw new Error('Video subtitles unavailable');
  const payload = JSON.parse(await subtitles.text());
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
  return cues.length ? { language: track.lan.slice(0, 20), cues, partial: cues.length !== payload.body.length } : undefined;
}
