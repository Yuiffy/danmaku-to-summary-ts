'use client';
import { useState } from 'react';
import { api, dateText, statusText, useResource } from './client';

export function DelayedTasks() {
  const resource = useResource<{ tasks: any[] }>('/delayed-tasks', 5000), [roomId, setRoomId] = useState(''), [delay, setDelay] = useState('600');
  const [textPath, setTextPath] = useState(''), [imagePath, setImagePath] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState<{ taskId?: string }>();
  async function execute(taskId?: string) {
    setConfirmation(undefined);
    setBusy(true); setError(''); setMessage('');
    try {
      const body = taskId ? {} : { roomId, delaySeconds: Number(delay), goodnightTextPath: textPath || undefined, comicImagePath: imagePath || undefined };
      await api(taskId ? `/delayed-tasks/${encodeURIComponent(taskId)}` : '/delayed-tasks', body, taskId ? 'DELETE' : 'POST');
      setMessage(taskId ? '任务已取消' : '延迟回复任务已创建'); resource.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  }
  return <>
    <div className="toolbar"><p className="muted">任务由 Webhook 服务保存与执行，每 5 秒刷新。</p><button onClick={resource.refresh}>刷新</button></div>
    {(error || resource.error) && <div className="notice error" role="alert">{error || resource.error}</div>}{message && <div className="notice" role="status">{message}</div>}
    {confirmation && <div className="notice" role="alertdialog" aria-label="确认延迟回复操作"><p>{confirmation.taskId ? '确认取消这个延迟回复任务？' : `确认创建房间 ${roomId} 的延迟回复？任务会按服务规则自动发布评论。`}</p><div className="button-row"><button className="primary" disabled={busy} onClick={() => void execute(confirmation.taskId)}>{confirmation.taskId ? '确认取消任务' : '确认授权并创建'}</button><button disabled={busy} onClick={() => setConfirmation(undefined)}>返回检查</button></div></div>}
    <div className="table-scroll"><table><thead><tr><th>房间</th><th>任务</th><th>计划时间</th><th>状态</th><th>异常</th><th /></tr></thead><tbody>{resource.data?.tasks.map(task => <tr key={task.taskId}><td>{task.roomId}</td><td className="mono">{task.taskId.slice(0, 8)}</td><td>{dateText(task.scheduledTime)}</td><td>{statusText(task.status)}</td><td>{task.error || '—'}</td><td><button disabled={busy || task.status !== 'pending'} onClick={() => setConfirmation({ taskId: task.taskId })}>取消</button></td></tr>)}</tbody></table>{!resource.data?.tasks.length && !resource.error && <div className="empty">暂无延迟回复任务</div>}</div>
    <details className="new-task"><summary>＋ 创建延迟回复</summary><form onSubmit={event => { event.preventDefault(); setConfirmation({}); }}><div className="form-grid"><label>房间 ID<input required pattern="[1-9][0-9]*" value={roomId} onChange={event => setRoomId(event.target.value)} /></label><label>延迟秒数<input required type="number" min="0" value={delay} onChange={event => setDelay(event.target.value)} /></label></div><div className="form-stack"><label>晚安文案路径（留空自动查找）<input value={textPath} onChange={event => setTextPath(event.target.value)} /></label><label>漫画路径（可选）<input value={imagePath} onChange={event => setImagePath(event.target.value)} /></label></div><button className="primary" disabled={busy}>创建并授权回复</button></form></details>
  </>;
}
