'use client';
import { useEffect, useRef, useState } from 'react';
import { AdminJob, CampaignCandidateDetail, ClipSummary } from '../../core/admin/contracts';
import { api, statusText, useResource } from './client';

export function CampaignFeedback({ id, detail, onRefresh }: { id: string; detail: CampaignCandidateDetail; onRefresh: () => void }) {
  const feedback = useResource<{ job: AdminJob | null; clip: ClipSummary | null }>(`/campaign-candidates/${id}/feedback`, 3000, true);
  const [title, setTitle] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [submitted, setSubmitted] = useState<AdminJob>();
  const restored = useRef(false), submitting = useRef(false), observed = useRef<AdminJob>();
  const remote = feedback.data?.job;
  const job = submitted && (!remote || submitted.createdAt > remote.createdAt || submitted.id === remote.id && submitted.updatedAt > remote.updatedAt) ? submitted : remote;
  const clip = feedback.data?.clip;
  const active = !!job && ['queued', 'running'].includes(job.status);
  const complete = !!clip && ['uploaded', 'queued', 'uploading', 'excluded', 'cancelled'].includes(clip.status);
  const failed = !!job && ['failed', 'interrupted'].includes(job.status) && !complete;
  useEffect(() => {
    if (restored.current || !feedback.data) return;
    restored.current = true;
    let saved: { title?: string; note?: string } | undefined;
    try { saved = JSON.parse(localStorage.getItem(`campaign-feedback-${id}`) || 'null'); } catch { /* Draft storage is optional. */ }
    const previous = feedback.data.job;
    setTitle(saved?.title ?? (typeof previous?.edits?.title === 'string' ? previous.edits.title : ''));
    setNote(saved?.note ?? (previous?.note === '投' ? '' : previous?.note || ''));
  }, [feedback.data, id]);
  useEffect(() => {
    const previous = observed.current; observed.current = job || undefined;
    if (previous?.id === job?.id && ['queued', 'running'].includes(previous?.status || '') && !active) onRefresh();
  }, [job, active, onRefresh]);
  function draft(nextTitle: string, nextNote: string) {
    restored.current = true; setTitle(nextTitle); setNote(nextNote);
    try { localStorage.setItem(`campaign-feedback-${id}`, JSON.stringify({ title: nextTitle, note: nextNote })); } catch { /* Submitted intent is also saved on the server. */ }
  }
  async function publish() {
    if (submitting.current || active || complete) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const result = await api<AdminJob>(`/campaign-candidates/${id}/actions`, { revision: detail.revision,
        note: note.trim() || '投', ...(title.trim() ? { title: title.trim() } : {}), publishApproved: true });
      setSubmitted(result); feedback.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '提交失败'); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <section className="inspector-section"><h3>制作并投稿</h3>
    <label>投稿标题（可直接填写）<input aria-label="候补切片投稿标题" maxLength={300} placeholder="留空则按修改意见和原片内容拟定" value={title} disabled={busy || active || complete} onChange={event => draft(event.target.value, note)} /></label>
    <label>修改意见（可选）<textarea aria-label="候补切片修改意见" rows={4} maxLength={1000} placeholder="例如：标题突出这次翻车，开头保留铺垫，结尾不要截断。也可以只填标题直接投稿。" value={note} disabled={busy || active || complete} onChange={event => draft(title, event.target.value)} /></label>
    <p className="muted">点击即授权按意见制作并投稿到 B 站。手填标题优先保留；后台补齐文案、制作字幕和封面，再加入现有投稿队列。</p>
    {(error || feedback.error) && <p className="notice error" role="alert">{error || feedback.error}</p>}
    {job && <div className={`notice${failed ? ' error' : ''}`} role={failed ? 'alert' : 'status'}>
      <strong>{complete ? statusText(clip!.status) : active ? job.phase || '已提交，等待后台处理' : job.status === 'succeeded' ? '已加入投稿队列' : `${statusText(job.status)} · ${job.phase || '等待处理'}`}</strong>
      {active && <p>可以继续查看其他备选，返回后进度会自动更新。</p>}
      {failed && <p>标题和意见已保存，可补充修改后重试。</p>}
      {clip && <p>正式候选 #{clip.id} · {clip.title}</p>}
      <details><summary>查看处理过程与已保存意见</summary>{typeof job.edits?.title === 'string' && <p>指定标题：{job.edits.title}</p>}<p>{job.note}</p><pre>{job.output || '等待执行…'}</pre></details>
    </div>}
    <button className="primary" disabled={!detail.candidate.previewAvailable || busy || active || complete || !feedback.data} onClick={() => void publish()}>{busy ? '正在提交…' : active ? '正在制作并投稿…' : complete ? statusText(clip!.status) : failed ? '按当前标题和意见重试投稿' : title.trim() || note.trim() ? '按当前标题和意见制作并投稿' : '制作并投稿'}</button>
  </section>;
}
