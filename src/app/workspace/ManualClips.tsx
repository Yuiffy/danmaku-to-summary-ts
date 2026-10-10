'use client';
import { useState } from 'react';
import Image from 'next/image';
import { api, statusText, useResource } from './client';

export function ManualClipForm({ onQueued }: { onQueued: () => void }) {
  const [form, setForm] = useState({ mediaPath: '', srtPath: '', start: '', end: '', title: '', description: '', coverText: '', profile: 'small_sui' });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(action: string) {
    setBusy(true); setError('');
    try { await api('/manual/actions', { ...form, action }); onQueued(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  }
  return <details className="new-task"><summary>＋ 新建手工切片 / 制作下一条</summary>
    {error && <div className="notice error">{error}</div>}
    <form onSubmit={event => { event.preventDefault(); void submit('add-manual'); }}><div className="form-stack">
      <label>源录播路径<input required value={form.mediaPath} onChange={event => setForm({ ...form, mediaPath: event.target.value })} /></label>
      <label>原始 SRT 路径<input required value={form.srtPath} onChange={event => setForm({ ...form, srtPath: event.target.value })} /></label>
    </div><div className="form-grid"><label>开始秒数<input required type="number" min="0" step="any" value={form.start} onChange={event => setForm({ ...form, start: event.target.value })} /></label><label>结束秒数<input required type="number" min="0" step="any" value={form.end} onChange={event => setForm({ ...form, end: event.target.value })} /></label></div><div className="form-stack">
      <label>标题<input required value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      <label>简介<textarea required value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
      <label>封面文字<textarea required rows={2} value={form.coverText} onChange={event => setForm({ ...form, coverText: event.target.value })} /></label>
      <label>投稿样式<select value={form.profile} onChange={event => setForm({ ...form, profile: event.target.value })}><option value="small_sui">【小岁】</option><option value="old_sui">老岁片</option></select></label>
    </div><div className="button-row"><button className="primary" disabled={busy} type="submit">加入待制作队列</button><button disabled={busy} type="button" onClick={() => void submit('cut-manual')}>制作下一条待制作任务</button></div><p className="muted">制作完成后保留待审核；审核与投稿在下方任务中执行。</p></form>
  </details>;
}
export function ManualClipReview({ id, onQueued }: { id: string; onQueued: () => void }) {
  const resource = useResource<any>(`/manual/${id}`), data = resource.data, [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function approve() {
    if (!window.confirm(`确认已看过 ${id} 的画面、字幕与封面，授权入队投稿？`)) return;
    setBusy(true); setError('');
    try { await api('/queues/actions', { action: 'approve-manual', id, revision: data.revision, publishApproved: true }); onQueued(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  }
  return <section className="manual-review"><div className="section-heading"><h2>{id} · 手工切片审核</h2><button onClick={resource.refresh}>刷新审核内容</button></div>
    {(error || resource.error) && <div className="notice error">{error || resource.error}</div>}
    {data && <><h3>{data.task.title}</h3><p className="muted">{statusText(data.task.status)} · 源录播 {data.task.start}–{data.task.end} 秒</p>
      {data.media && <video className="review-video" src={`/api/admin/manual/${id}/assets/media?v=${data.revision}`} controls preload="metadata" />}
      <p className="manual-description">{data.task.description}</p>{data.cover && <Image src={`/api/admin/manual/${id}/assets/cover?v=${data.revision}`} className="manual-cover" width={480} height={300} alt="手工切片封面" unoptimized />}
      <button className="primary" disabled={busy || !data.media || data.task.status !== 'pending_review'} onClick={() => void approve()}>审核通过并授权投稿</button></>}
  </section>;
}
