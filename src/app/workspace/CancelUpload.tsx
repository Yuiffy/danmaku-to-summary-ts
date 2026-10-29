'use client';
import { useEffect, useState } from 'react';
import { AdminJob } from '../../core/admin/contracts';
import { api } from './client';

export function CancelUpload({ clipId, jobId, disabled = false, onCancelled }: {
  clipId?: number; jobId?: string; disabled?: boolean; onCancelled: () => void;
}) {
  const [note, setNote] = useState('人工审核撤回，待修改后重新投稿'), [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<AdminJob>(), [error, setError] = useState('');
  const submittedId = submitted?.id;
  const pending = !!submitted && ['queued', 'running'].includes(submitted.status);
  useEffect(() => {
    if (!submittedId || !pending) return;
    let current = true;
    const refresh = async () => {
      try {
        const { jobs } = await api<{ jobs: AdminJob[] }>('/jobs');
        const latest = jobs.find(job => job.id === submittedId);
        if (!current || !latest) return;
        setSubmitted(latest); setError('');
        if (latest.status === 'succeeded') onCancelled();
      } catch (reason) { if (current) setError(reason instanceof Error ? reason.message : '取消进度读取失败'); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => { current = false; clearInterval(timer); };
  }, [submittedId, pending, onCancelled]);
  async function cancel() {
    if (busy || !note.trim()) return;
    setBusy(true); setError('');
    try {
      const job = await api<AdminJob>(clipId ? `/clips/${clipId}/actions` : '/queues/actions',
        { action: 'cancel-upload', ...(clipId ? {} : { id: jobId }), note });
      setSubmitted(job);
      if (job.status === 'succeeded') onCancelled();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '取消失败'); }
    finally { setBusy(false); }
  }
  return <details className="cancel-upload"><summary>取消{clipId ? ` #${clipId} 投稿` : '任务投稿'}</summary>
    <p className="muted">保留视频和编号。上传中将停止传输，停止后可修改再投；已进入最终提交的稿件需核对回执。</p>
    <label>取消原因<textarea value={note} maxLength={1000} disabled={busy || pending} onChange={event => setNote(event.target.value)} rows={2} /></label>
    <button disabled={disabled || busy || pending || !note.trim()} onClick={() => void cancel()}>{busy || pending ? '正在提交取消…' : '确认取消投稿'}</button>
    {error && <p role="alert">{error}</p>}
    {submitted?.status === 'succeeded' && <p role="status">取消请求已保存。后台停止后返回待审核，可按意见修改并重新投稿。</p>}
    {submitted && ['failed', 'interrupted'].includes(submitted.status) && <p role="alert">取消未完成：{submitted.output || '请查看任务记录并核对当前状态'}</p>}
  </details>;
}
