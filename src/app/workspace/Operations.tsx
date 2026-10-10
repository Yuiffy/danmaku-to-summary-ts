'use client';
import { useState } from 'react';
import { AdminJob } from '../../core/admin/contracts';
import { api, dateText, statusText, useResource } from './client';
import { ManualClipForm, ManualClipReview } from './ManualClips';
import { StreamWorkflowForm } from './StreamWorkflows';

const actionNames: Record<string, string> = { correct: '修改字幕', cut: '制作成片', preview: '生成粗剪', subtitles: '准备字幕', rebuild: '准备重制', 'approve-review': '通过审核', enqueue: '入队投稿', exclude: '排除视频', precision: 'AI 精剪' };
export function Operations() {
  const resource = useResource<{ jobs: AdminJob[] }>('/jobs', 3000), queues = useResource<{ uploads: any[]; manual: any[]; accountRollingUploadGuard?: any; submissionRateLimit?: any }>('/queues', 10000);
  const [tab, setTab] = useState('jobs'), [selected, setSelected] = useState(''), [manualId, setManualId] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function action(body: any) {
    const note = window.prompt('取消原因');
    if (!note) return;
    setBusy(true); setError('');
    try { await api('/queues/actions', { ...body, note }); resource.refresh(); setTab('jobs'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  }
  const job = resource.data?.jobs.find(next => next.id === selected);
  return <>
    <div className="toolbar"><div className="tabs">{[['jobs', '管理操作'], ['uploads', '投稿队列'], ['manual', '手工切片'], ['streams', '完整内容制作']].map(([key, label]) => <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{label}</button>)}</div><button onClick={() => { resource.refresh(); queues.refresh(); }}>刷新</button></div>
    {(error || resource.error || queues.error) && <div className="notice error" role="alert">{error || resource.error || queues.error}</div>}
    {tab === 'streams' && <StreamWorkflowForm onQueued={() => { resource.refresh(); setTab('jobs'); }} />}
    {tab === 'jobs' && <div className="operations-layout"><div className="table-scroll"><table><thead><tr><th>操作</th><th>目标</th><th>状态</th><th>时间</th><th /></tr></thead><tbody>{resource.data?.jobs.map(next => <tr key={next.id}><td>{actionNames[next.action] || next.action}</td><td className="mono">{next.target}</td><td><span className={`status status-${next.status}`}>{statusText(next.status)}</span></td><td>{dateText(next.createdAt)}</td><td><button onClick={() => setSelected(next.id)}>查看输出</button></td></tr>)}</tbody></table>{!resource.data?.jobs.length && <div className="empty">暂无管理操作</div>}</div>{job && <section className="job-output"><div className="section-heading"><h3>{actionNames[job.action] || job.action} · {job.target}</h3><span>{statusText(job.status)}</span></div><pre>{job.output || '等待执行输出…'}</pre></section>}</div>}
    {tab === 'uploads' && <><p className="muted">由现有单实例上传 worker 执行。这里只取消任务，不自动启动或重试投稿。</p>{queues.data?.submissionRateLimit && <div className="notice">投稿冷却：<pre>{JSON.stringify(queues.data.submissionRateLimit, null, 2)}</pre></div>}<div className="table-scroll"><table><thead><tr><th>任务</th><th>视频编号</th><th>状态 / 阶段</th><th>更新时间</th><th /></tr></thead><tbody>{queues.data?.uploads.map(next => <tr key={next.id}><td className="mono">{next.id}</td><td>{next.clipIds?.join(', ')}</td><td>{statusText(next.status)}{next.phase ? ` · ${next.phase}` : ''}</td><td>{dateText(next.updatedAt)}</td><td><button disabled={busy || !['pending', 'queued'].includes(next.status)} onClick={() => void action({ action: 'cancel-upload', id: next.id })}>取消任务</button></td></tr>)}</tbody></table>{!queues.data?.uploads.length && <div className="empty">暂无投稿任务</div>}</div></>}
    {tab === 'manual' && <><p className="muted">已生成成片的任务可按现有流程审核后入队。</p><div className="table-scroll"><table><thead><tr><th>编号</th><th>标题</th><th>状态</th><th>关联视频</th><th /></tr></thead><tbody>{queues.data?.manual.map(next => <tr key={next.id}><td className="mono">{next.id}</td><td>{next.title}</td><td>{statusText(next.status)}</td><td>{next.uploadIds?.join(', ') || '—'}</td><td><div className="button-row"><button disabled={busy || next.status !== 'pending_review'} onClick={() => setManualId(next.id)}>打开审核</button><button disabled={busy || !['pending_cut', 'pending_review', 'pending_upload'].includes(next.status)} onClick={() => void action({ action: 'cancel-manual', id: next.id })}>取消</button></div></td></tr>)}</tbody></table>{!queues.data?.manual.length && <div className="empty">暂无手工切片</div>}</div>
      {manualId && <ManualClipReview key={manualId} id={manualId} onQueued={() => { resource.refresh(); setTab('jobs'); }} />}
      <ManualClipForm onQueued={() => { resource.refresh(); setTab('jobs'); }} />
    </>}
  </>;
}
