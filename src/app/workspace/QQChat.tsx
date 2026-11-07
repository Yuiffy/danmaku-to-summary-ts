'use client';
import { useState } from 'react';
import { api, dateText, useResource } from './client';

interface ChatRow { id: string; conversation: string; senderName?: string; text: string; createdAt: number; }
interface ChatView { date: string; dates: string[]; total: number; page: number; pages: number; rows: ChatRow[]; asOf: number; }

export function QQChat() {
  const [date, setDate] = useState(''), [search, setSearch] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(1);
  const resource = useResource<ChatView>(`/qq-chat?date=${date}&search=${encodeURIComponent(query)}&page=${page}`, 5000);
  const data = resource.data;
  const removeOlder = async () => {
    const before = date || data?.dates.at(-1);
    if (!before || !window.confirm(`删除 ${before} 之前的群聊归档？此操作不可恢复。`)) return;
    await api(`/qq-chat?before=${encodeURIComponent(before)}`, undefined, 'DELETE');
    resource.refresh();
  };
  return <div className="comment-replies">
    <div className="toolbar"><p className="muted">全量群聊归档仅用于鹿饼上下文与总结；消息按日期保存，可删除更早日期。</p><button onClick={resource.refresh}>刷新</button><button onClick={removeOlder} disabled={!data?.dates.length}>删除更早归档</button></div>
    <form className="toolbar" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(1); }}>
      <label>日期 <select value={date} onChange={event => { setDate(event.target.value); setPage(1); }}><option value="">最新日期</option>{data?.dates.map(day => <option key={day} value={day}>{day}</option>)}</select></label>
      <label>关键词 <input value={search} maxLength={120} onChange={event => setSearch(event.target.value)} placeholder="昵称或聊天内容" /></label><button type="submit">筛选</button>
    </form>
    {resource.error && <div className="notice error" role="alert">{resource.error}</div>}
    {!data && resource.loading && <p role="status">正在读取群聊归档…</p>}
    {data && <><p className="muted">{data.date || '暂无日期'} · 共 {data.total} 条 · 第 {data.page} / {data.pages} 页</p>
      <div className="table-scroll"><table><thead><tr><th>时间</th><th>发送者</th><th>群聊</th><th>内容</th></tr></thead><tbody>
        {data.rows.map(row => <tr key={row.id}><td>{dateText(row.createdAt)}</td><td>{row.senderName || 'QQ 未提供昵称'}</td><td><code>{row.conversation.slice(0, 12)}</code></td><td className="comment-copy">{row.text}</td></tr>)}
        {!data.rows.length && <tr><td colSpan={4}>暂无群聊归档。</td></tr>}
      </tbody></table></div>
      <div className="toolbar"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {data.pages}</span><button disabled={page >= data.pages} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </>}
  </div>;
}
