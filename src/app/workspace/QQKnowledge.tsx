'use client';
import { useState } from 'react';
import { api, dateText, useResource } from './client';

interface Entry { id: string; title: string; content: string; source: string; tags: string[]; enabled: boolean; updatedAt: number; }
interface View { entries: Entry[]; total: number; }
export function QQKnowledge() {
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [selected, setSelected] = useState<Entry>(), [draft, setDraft] = useState<Entry>();
  const resource = useResource<View>(`/qq-knowledge?search=${encodeURIComponent(query)}`, 5000); const data = resource.data;
  const save = async () => { if (!draft) return; await api(`/qq-knowledge/${encodeURIComponent(draft.id)}`, { ...draft, tags: draft.tags }, 'PUT'); setSelected(undefined); setDraft(undefined); resource.refresh(); };
  const remove = async (entry: Entry) => { if (!window.confirm(`删除“${entry.title}”？`)) return; await api(`/qq-knowledge/${encodeURIComponent(entry.id)}`, undefined, 'DELETE'); if (selected?.id === entry.id) { setSelected(undefined); setDraft(undefined); } resource.refresh(); };
  return <div className="comment-replies">
    <div className="toolbar"><p className="muted">本地 SQLite 知识库，随 QQBot 按需使用；只保存已确认的配置规则和维护说明。</p><button onClick={resource.refresh}>刷新</button></div>
    <form className="toolbar" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); }}><label>搜索 <input value={search} maxLength={300} onChange={event => setSearch(event.target.value)} placeholder="例如：群主 全部消息" /></label><button type="submit">筛选</button></form>
    {resource.error && <div className="notice error">{resource.error}</div>}
    {data && <div className="table-scroll"><table><thead><tr><th>标题</th><th>来源</th><th>更新时间</th><th>操作</th></tr></thead><tbody>
      {data.entries.map(entry => <tr key={entry.id}><td><strong>{entry.title}</strong><p className="muted">{entry.content}</p></td><td>{entry.source}<p>{entry.tags.join(' · ')}</p></td><td>{dateText(entry.updatedAt)}<p>{entry.enabled ? '启用' : '已停用'}</p></td><td><button onClick={() => { setSelected(entry); setDraft({ ...entry }); }}>编辑</button> <button onClick={() => void remove(entry)}>删除</button></td></tr>)}
      {!data.entries.length && <tr><td colSpan={4}>暂无知识条目。</td></tr>}
    </tbody></table></div>}
    {selected && draft && <div className="notice"><h3>编辑知识条目</h3><label>标题 <input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label><label>内容 <textarea rows={8} value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} /></label><label>来源 <input value={draft.source} onChange={event => setDraft({ ...draft, source: event.target.value })} /></label><label>标签 <input value={draft.tags.join(', ')} onChange={event => setDraft({ ...draft, tags: event.target.value.split(',').map(value => value.trim()).filter(Boolean) })} /></label><label><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /> 启用</label><div className="toolbar"><button onClick={() => void save()}>保存</button><button onClick={() => { setSelected(undefined); setDraft(undefined); }}>取消</button></div></div>}
  </div>;
}
