'use client';
import { PointerEvent, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { AdminJob, ClipDetail, CoverSelection } from '../../core/admin/contracts';
import { api, statusText, useResource } from './client';

type Crop = NonNullable<CoverSelection['crop']>;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
function baseCrop(ratio: number): Crop {
  const width = Math.min(1, 16 / 9 / ratio), height = Math.min(1, ratio / (16 / 9));
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

export function CoverEditor({ id, part, detail, text, onText, disabled, onSaved }: {
  id: number; part: number; detail: ClipDetail; text: string; onText: (value: string) => void; disabled: boolean; onSaved: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null), surface = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(detail.coverSelection?.part === part ? detail.coverSelection.time : 0);
  const [duration, setDuration] = useState(0), [ratio, setRatio] = useState(16 / 9), [ready, setReady] = useState(false);
  const [crop, setCrop] = useState<Crop | undefined>(detail.coverSelection?.part === part ? detail.coverSelection.crop : undefined);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<{ url: string; signature: string }>(), [jobId, setJobId] = useState('');
  const jobs = useResource<{ jobs: AdminJob[] }>('/jobs', jobId ? 2000 : 0, true);
  const job = jobs.data?.jobs.find(item => item.id === jobId);
  const notified = useRef('');
  const drag = useRef<{ x: number; y: number; crop: Crop }>();
  const previewRequest = useRef<AbortController>();
  const frameCallback = useRef<number>();
  const pending = !!jobId && (!job || ['queued', 'running'].includes(job.status));
  const locked = disabled || busy || pending || detail.pendingRebuild || detail.clip.pendingCut
    || ['queued', 'uploading', 'uploaded', 'excluded', 'cancelled'].includes(detail.clip.status);
  const selection: CoverSelection = { time, part, text, ...(crop ? { crop } : {}) };
  const signature = JSON.stringify({ selection, revision: detail.revision });
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => () => previewRequest.current?.abort(), []);
  useEffect(() => {
    const element = video.current;
    return () => { if (element && frameCallback.current !== undefined) element.cancelVideoFrameCallback?.(frameCallback.current); };
  }, []);
  useEffect(() => {
    if (job?.status === 'succeeded' && notified.current !== job.id) { notified.current = job.id; onSaved(); }
  }, [job, onSaved]);
  function seek(value: number) {
    const next = clamp(value, 0, Math.max(0, duration - .04));
    setTime(next); if (video.current) { video.current.pause(); captureFrame(video.current); video.current.currentTime = next; }
  }
  function captureFrame(element: HTMLVideoElement) {
    if (!element.requestVideoFrameCallback) return;
    if (frameCallback.current !== undefined) element.cancelVideoFrameCallback(frameCallback.current);
    setReady(false);
    frameCallback.current = element.requestVideoFrameCallback((_now, frame) => {
      frameCallback.current = undefined;
      // Seek seconds can fall between frames; save the timestamp of the frame actually displayed.
      setTime(frame.mediaTime); setReady(true);
    });
  }
  function resize(scale: number) {
    if (!crop) return;
    const base = baseCrop(ratio), width = base.width * scale, height = base.height * scale;
    setCrop({ x: clamp(crop.x + (crop.width - width) / 2, 0, 1 - width),
      y: clamp(crop.y + (crop.height - height) / 2, 0, 1 - height), width, height });
  }
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!crop || locked) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, crop };
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const rect = surface.current?.getBoundingClientRect(), start = drag.current;
    if (!rect || !start || locked) return;
    setCrop({ ...start.crop, x: clamp(start.crop.x + (event.clientX - start.x) / rect.width, 0, 1 - start.crop.width),
      y: clamp(start.crop.y + (event.clientY - start.y) / rect.height, 0, 1 - start.crop.height) });
  }
  async function renderPreview() {
    setBusy(true); setError('');
    const controller = new AbortController(); previewRequest.current = controller;
    try {
      const response = await fetch(`/api/admin/clips/${id}/cover-preview`, { method: 'POST',
        signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection, revision: detail.revision }) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || '封面预览失败'); }
      setPreview({ url: URL.createObjectURL(await response.blob()), signature });
    } catch (reason) { setError(reason instanceof Error ? reason.message : '封面预览失败'); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError('');
    try {
      const next = await api<AdminJob>(`/clips/${id}/actions`, { action: 'cover', revision: detail.revision, selection,
        note: `用户确认封面：P${part} 第 ${time.toFixed(3)} 秒${crop ? '，自选裁剪' : ''}` });
      setJobId(next.id); jobs.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '封面保存失败'); }
    finally { setBusy(false); }
  }
  return <div className="cover-editor">
    <h3>选择封面画面</h3>
    <p className="muted">拖动进度条选择 P{part} 中的一帧。可裁剪为 16:9，预览文字效果后确认保存。</p>
    <div ref={surface} className="cover-frame" style={{ aspectRatio: ratio }}>
      <video ref={video} muted playsInline preload="metadata" aria-label="封面选帧视频"
        src={`/api/admin/clips/${id}/assets/media?part=${part}&v=${detail.mediaRevision || detail.revision}`}
        onLoadedMetadata={event => {
          const current = event.currentTarget;
          setDuration(Number.isFinite(current.duration) ? current.duration : 0);
          setRatio(current.videoWidth / current.videoHeight || 16 / 9);
          const next = clamp(time, 0, Math.max(0, current.duration - .04));
          setTime(next); captureFrame(current); current.currentTime = next;
        }} onLoadedData={() => setReady(true)}
        onSeeked={event => { if (!event.currentTarget.requestVideoFrameCallback) setTime(event.currentTarget.currentTime); setReady(true); }}
        onError={() => { setReady(false); setError('视频无法加载，请先确认成片可以播放'); }} />
      {crop && <div className="cover-crop" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
        <span>拖动画面框调整位置</span>
      </div>}
    </div>
    <label>视频进度 · {time.toFixed(2)} / {duration.toFixed(2)} 秒<input aria-label="封面视频进度" type="range" min={0} max={Math.max(0, duration - .04)} step={.01} value={time} disabled={locked || !duration} onChange={event => seek(Number(event.target.value))} /></label>
    <div className="cover-controls"><button disabled={locked || !duration} onClick={() => seek(time - 1 / 30)}>前一帧（约 1/30 秒）</button><button disabled={locked || !duration} onClick={() => seek(time + 1 / 30)}>后一帧（约 1/30 秒）</button>
      <label>定位秒数<input type="number" min={0} max={Math.max(0, duration - .04)} step={.01} value={Number(time.toFixed(3))} disabled={locked || !duration} onChange={event => { if (event.target.value !== '') seek(Number(event.target.value)); }} /></label></div>
    <label className="check-label"><input type="checkbox" checked={!!crop} disabled={locked || !duration} onChange={event => setCrop(event.target.checked ? baseCrop(ratio) : undefined)} />自选裁剪</label>
    {crop && <div className="cover-crop-controls"><label>裁剪大小<input type="range" min={.1} max={1} step={.01} value={crop.width / baseCrop(ratio).width} disabled={locked} onChange={event => resize(Number(event.target.value))} /></label>
      <label>水平位置<input type="range" min={0} max={Math.max(0, 1 - crop.width)} step={.001} value={crop.x} disabled={locked} onChange={event => setCrop({ ...crop, x: Number(event.target.value) })} /></label>
      <label>垂直位置<input type="range" min={0} max={Math.max(0, 1 - crop.height)} step={.001} value={crop.y} disabled={locked} onChange={event => setCrop({ ...crop, y: Number(event.target.value) })} /></label>
      <button disabled={locked} onClick={() => setCrop(baseCrop(ratio))}>重置裁剪</button></div>}
    <label>封面文字<textarea value={text} onChange={event => onText(event.target.value)} rows={2} maxLength={300} disabled={locked} /></label>
    <div className="cover-controls"><button disabled={locked || !ready || !text.trim()} onClick={() => void renderPreview()}>{busy ? '处理中…' : '预览带文字封面'}</button>
      <button disabled={locked || preview?.signature !== signature} onClick={() => void save()}>确认并重新生成封面</button></div>
    {preview && <><Image src={preview.url} alt="待确认的带文字封面" width={960} height={540} unoptimized className="cover-result" />{preview.signature !== signature && <p className="muted">画面、裁剪、文字或视频版本已变化，请重新预览。</p>}</>}
    {(error || jobs.error && jobId) && <p role="alert" className="notice error">{error || jobs.error}</p>}
    {jobId && <div role="status" className={`notice${job && ['failed', 'interrupted'].includes(job.status) ? ' error' : ''}`}>
      {job?.status === 'succeeded' ? '封面已保存，请核对新封面后重新审核。' : `封面保存：${job ? statusText(job.status) : '等待执行'}`}
      {job && <details><summary>查看执行结果</summary><pre>{job.output}</pre></details>}
    </div>}
  </div>;
}
