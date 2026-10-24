'use client';
import { RefObject, useEffect, useState } from 'react';
import { useResource } from './client';
import { formatSubtitleTime, srtToVtt, subtitleRows } from '../../core/admin/subtitles';

export function SourcePlayer({ id, revision, subtitles, video, onOrigin, basePath = `/clips/${id}` }: {
  id?: number; basePath?: string; revision: string; subtitles: string; video: RefObject<HTMLVideoElement>; onOrigin: (value: number) => void;
}) {
  const resource = useResource<{ origin: number; start: number; end: number }>(`${basePath}/source-playback?v=${revision}`);
  const [track, setTrack] = useState(''), [error, setError] = useState('');
  const playback = resource.data;
  useEffect(() => {
    if (!playback) return;
    onOrigin(playback.origin);
    const display = subtitleRows(subtitles).map(row => `${row.id}\n${formatSubtitleTime(Math.max(0, row.at - playback.origin))} --> ${formatSubtitleTime(row.end - playback.origin)}\n${row.text}\n`).join('\n');
    const url = URL.createObjectURL(new Blob([srtToVtt(display)], { type: 'text/vtt' }));
    setTrack(url);
    return () => URL.revokeObjectURL(url);
  }, [playback, subtitles, onOrigin]);
  return <>
    {resource.loading && <div className="media-empty">正在定位原片…</div>}
    {(resource.error || error) && <div className="notice error" role="alert">{resource.error || error}<button onClick={() => { setError(''); resource.refresh(); }}>重试原片</button></div>}
    {playback && <><video ref={video} key={`${revision}-${playback.origin}`} className="review-video" controls preload="metadata"
      src={`/api/admin${basePath}/assets/source-preview?v=${revision}`}
      onLoadedMetadata={event => { event.currentTarget.currentTime = Math.max(0, playback.start - playback.origin); }}
      onError={() => setError('浏览器无法播放这段原片，可生成粗剪后预览。')}>
      {track && <track kind="subtitles" src={track} srcLang="zh" label="原片字幕" default />}
    </video><p className="muted">原片已定位到 {formatSubtitleTime(playback.start).split(',')[0]}，点击下方字幕可跳到对应原话。</p></>}
  </>;
}
