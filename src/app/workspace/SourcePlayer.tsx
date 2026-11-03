'use client';
import { RefObject, useEffect, useRef, useState } from 'react';
import { useResource } from './client';
import { formatSubtitleTime, srtToVtt, subtitleRows } from '../../core/admin/subtitles';

export function SourcePlayer({ id, revision, subtitles, video, onOrigin, basePath = `/clips/${id}` }: {
  id?: number; basePath?: string; revision: string; subtitles: string; video: RefObject<HTMLVideoElement>; onOrigin: (value: number) => void;
}) {
  const [forceRemux, setForceRemux] = useState(false);
  const sourceEndpoint = `${basePath}/source-playback?v=${revision}${forceRemux ? '&remux=1' : ''}`;
  const resource = useResource<{ origin: number; start: number; end: number; direct?: boolean; format?: string }>(sourceEndpoint);
  const [track, setTrack] = useState(''), [error, setError] = useState('');
  const busyRetry = resource.status === 429;
  const retryAttempt = useRef(0);
  const flvPlayer = useRef<{ destroy: () => void }>();
  const playback = resource.data;
  const rawFlv = !!playback && playback.direct === true && playback.format === '.flv' && !forceRemux;
  const sourceUrl = `/api/admin${basePath}/assets/source-preview?v=${revision}${forceRemux ? '&remux=1' : ''}`;
  useEffect(() => { setForceRemux(false); }, [basePath, revision]);
  useEffect(() => {
    if (!busyRetry) {
      if (!resource.loading && resource.status !== undefined) retryAttempt.current = 0;
      return;
    }
    const delay = Math.min(10_000, 1_000 * 2 ** retryAttempt.current++);
    const timer = window.setTimeout(resource.refresh, delay);
    return () => window.clearTimeout(timer);
  }, [busyRetry, resource.loading, resource.status, resource.refresh]);
  useEffect(() => {
    if (!rawFlv || !playback || !video.current) return;
    let cancelled = false;
    void import('mpegts.js').then(module => {
      const mpegts = module.default;
      if (cancelled || !video.current) return;
      if (!mpegts.isSupported()) throw new Error('当前浏览器不支持 FLV 直读');
      const player = mpegts.createPlayer({ type: 'flv', isLive: false, url: sourceUrl }, { seekType: 'range', enableWorker: false });
      flvPlayer.current = player;
      player.on(mpegts.Events.ERROR, () => {
        if (cancelled) return;
        flvPlayer.current = undefined;
        setError('FLV 直读失败，正在切换兼容预览…');
        setForceRemux(true);
      });
      player.attachMediaElement(video.current);
      player.load();
    }).catch(reason => {
      if (cancelled) return;
      flvPlayer.current = undefined;
      setError(reason instanceof Error ? reason.message : 'FLV 直读失败，正在切换兼容预览…');
      setForceRemux(true);
    });
    return () => {
      cancelled = true;
      flvPlayer.current?.destroy();
      flvPlayer.current = undefined;
    };
  }, [playback, rawFlv, sourceUrl, video]);
  useEffect(() => {
    if (!playback) return;
    onOrigin(playback.origin);
    const display = subtitleRows(subtitles).map(row => `${row.id}\n${formatSubtitleTime(Math.max(0, row.at - playback.origin))} --> ${formatSubtitleTime(row.end - playback.origin)}\n${row.text}\n`).join('\n');
    const url = URL.createObjectURL(new Blob([srtToVtt(display)], { type: 'text/vtt' }));
    setTrack(url);
    return () => URL.revokeObjectURL(url);
  }, [playback, subtitles, onOrigin]);
  return <>
    {resource.loading && <div className="media-empty">正在定位原片…大录播首次加载可能需要约 1 分钟，完成后会缓存。</div>}
    {busyRetry ? <div className="notice" role="status">另一个原片正在加载，已自动排队重试…<button onClick={() => { retryAttempt.current = 0; resource.refresh(); }}>立即重试</button></div>
      : (resource.error || error) && <div className="notice error" role="alert">{resource.error || error}<button onClick={() => { setError(''); resource.refresh(); }}>重试原片</button></div>}
    {playback && <><video ref={video} key={`${revision}-${playback.origin}-${forceRemux ? 'remux' : 'source'}`} className="review-video" controls preload="metadata"
      src={rawFlv ? undefined : sourceUrl}
      onLoadedMetadata={event => { event.currentTarget.currentTime = Math.max(0, playback.start - playback.origin); }}
      onError={() => { if (rawFlv) { setError('FLV 直读失败，正在切换兼容预览…'); setForceRemux(true); } else setError('浏览器无法播放这段原片，可生成粗剪后预览。'); }}>
      {track && <track kind="subtitles" src={track} srcLang="zh" label="原片字幕" default />}
    </video><p className="muted">原片已定位到 {formatSubtitleTime(playback.start).split(',')[0]}，点击下方字幕可跳到对应原话。</p></>}
  </>;
}
