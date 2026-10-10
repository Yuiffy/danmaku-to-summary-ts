'use client';
import { useState } from 'react';
import { ReminderView } from '../../core/admin/contracts';
import { api, dateText, statusText, useResource } from './client';

type Item = NonNullable<ReminderView['state']>['items'][number];
export function Reminders({ onConfig }: { onConfig: () => void }) {
  const resource = useResource<ReminderView>('/reminders', 5000), data = resource.data;
  const [item, setItem] = useState<Item>(), [templates, setTemplates] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [commandId, setCommandId] = useState('');
  const commandResult = data?.results?.find(result => result.id === commandId);
  function edit(next: Item) { setItem({ ...next }); setTemplates(next.templates.join('\n')); setMessage(''); }
  async function submit(body: unknown) {
    setBusy(true); setError(''); setMessage('');
    try { const result = await api('/reminders', body); setMessage(result.message); setCommandId(result.id); setItem(undefined); resource.refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败'); }
    finally { setBusy(false); }
  }
  return <>
    <div className="toolbar"><p className="muted">每日按上海时间去重，在直播安静时发送。修改由直播机器人接收。</p><button onClick={resource.refresh}>刷新</button></div>
    {(resource.error || error) && <div className="notice error" role="alert">{error || resource.error}</div>}
    {message && <div className={`notice ${commandResult?.status === 'rejected' ? 'error' : ''}`} role="status">{commandResult?.message || message}</div>}
    {resource.loading && <div className="empty">读取提醒…</div>}
    {data && !data.configured && <div className="empty"><h2>尚未配置直播提醒</h2><p>在直播机器人配置中添加提醒，填写状态与通知配置路径。</p><button className="primary" onClick={onConfig}>配置提醒</button></div>}
    {data?.configured && data.state && <>
      <div className="reminder-heading"><div><div className="eyebrow">房间 {data.roomId}</div><h2>每日提醒 <span className="status">{data.state.enabled ? '已开启' : '已关闭'}</span></h2><p className="muted">开播 {data.policy?.startMinutes ?? 15}–{data.policy?.endMinutes ?? 60} 分钟 · 间隔至少 {data.policy?.minGapMinutes ?? 10} 分钟</p></div>
        <div className="button-row"><button disabled={busy || !data.runningEnabled} onClick={() => void submit({ action: 'switch', enabled: !data.state?.enabled })}>{data.state.enabled ? '关闭全部提醒' : '开启全部提醒'}</button><button disabled={busy || !data.runningEnabled} onClick={() => void submit({ action: data.state?.pausedSession ? 'resume' : 'pause' })}>{data.state.pausedSession ? '恢复本场提醒' : '暂停本场'}</button></div></div>
      {!data.runningEnabled && <div className="notice">提醒策略当前未启用。<button onClick={onConfig}>打开配置</button></div>}
      {data.pending.length > 0 && <div className="notice">{data.pending.length} 条修改等待机器人接收。若持续积压，请检查直播机器人运行状态。</div>}
      {!!data.results?.length && <details className="reminder-results"><summary>最近管理结果</summary>{data.results.map(result => <p key={result.id} className={result.status === 'rejected' ? 'notice error' : 'muted'}>{dateText(result.at)} · {result.message}</p>)}</details>}
      <div className="section-heading"><h2>提醒项目</h2><button disabled={!data.runningEnabled || data.state.items.length >= 10} onClick={() => edit({ id: `web-${Date.now().toString(36)}`, name: '', enabled: true, templates: [''] })}>＋ 新增提醒</button></div>
      <div className="reminder-list">{data.state.items.map(next => <div key={next.id}><div><strong>{next.name}</strong><span className="mono muted">{next.id}</span><p>{next.templates[0]}</p></div><span className="status">{next.enabled ? '开启' : '关闭'}</span><button disabled={busy || !data.runningEnabled} onClick={() => edit(next)}>编辑</button><button disabled={busy || !data.runningEnabled} onClick={() => void submit({ action: 'upsert', item: { ...next, enabled: !next.enabled } })}>{next.enabled ? '关闭' : '开启'}</button></div>)}</div>
      {item && <form className="reminder-editor" onSubmit={event => { event.preventDefault(); void submit({ action: 'upsert', item: { ...item, templates: templates.split('\n').map(text => text.trim()).filter(Boolean) } }); }}>
        <h3>编辑提醒</h3><div className="form-stack"><label>事项名称<input required value={item.name} onChange={event => setItem({ ...item, name: event.target.value })} maxLength={40} /></label><label>提醒文案（每行一个版本）<textarea required rows={4} value={templates} onChange={event => setTemplates(event.target.value)} /></label><label className="check-label"><input type="checkbox" checked={item.enabled} onChange={event => setItem({ ...item, enabled: event.target.checked })} />启用此项目</label></div><div className="button-row"><button className="primary" disabled={busy} type="submit">保存修改</button><button type="button" onClick={() => setItem(undefined)}>取消</button></div>
      </form>}
      <div className="section-heading"><h2>发送记录</h2><span className="muted">最近 32 天</span></div>
      <div className="table-scroll"><table><thead><tr><th>时间</th><th>事项</th><th>发送内容</th><th>结果</th><th>通知记录</th></tr></thead><tbody>{[...data.state.receipts].reverse().map((receipt, index) => <tr key={index}><td>{dateText(receipt.at)}</td><td>{data.state?.items.find(next => next.id === receipt.id)?.name || receipt.id}</td><td>{receipt.text}</td><td>{statusText(receipt.status)}</td><td>{receipt.notified ? '已记录' : '未确认'}</td></tr>)}</tbody></table>{!data.state.receipts.length && <div className="empty">暂无发送记录</div>}</div>
    </>}
  </>;
}
