'use client';
import { useState } from 'react';
import Image from 'next/image';
import { QQ_RECORD_STATUSES, type AdminQQRecordsView } from '../../core/admin/qqRecords';
import { dateText, useResource } from './client';

export function QQRecords() {
  const [date, setDate] = useState(''), [scope, setScope] = useState('all'), [status, setStatus] = useState('all');
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(1);
  const resource = useResource<AdminQQRecordsView>(`/qq-records?date=${date}&scope=${scope}&status=${status}&search=${encodeURIComponent(query)}&page=${page}`, 5000);
  const data = resource.data;
  return <div className="comment-replies">
    <div className="toolbar"><p className="muted">群聊仅响应艾特，私聊回复入群引导。问答长期保存在本机，每 5 秒更新。</p><button onClick={resource.refresh}>刷新</button></div>
    <form className="toolbar" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(1); }}>
      <label>日期 <select value={date} onChange={event => { setDate(event.target.value); setPage(1); }}><option value="">最新有记录日期</option>
        {data?.dates.map(day => <option key={day} value={day}>{day}</option>)}
      </select></label>
      <label>会话 <select value={scope} onChange={event => { setScope(event.target.value); setPage(1); }}>
        <option value="all">全部</option><option value="group">群聊艾特</option><option value="c2c">私聊</option></select></label>
      <label>状态 <select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="all">全部</option>
        {Object.entries(QQ_RECORD_STATUSES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>关键词 <input value={search} maxLength={120} onChange={event => setSearch(event.target.value)} placeholder="问题、回答或会话标识" /></label><button type="submit">筛选</button>
    </form>
    {resource.error && <div className="notice error" role="alert">{resource.error}</div>}
    {!data && resource.loading && <p role="status">正在读取 QQ 问答…</p>}
    {data && <><p className="muted">{data.date} · 共 {data.total} 条。仅“已回复”表示收到 QQ 成功回执；“待核对”不会自动重发。</p>
      <div className="table-scroll"><table><thead><tr><th>时间与会话</th><th>提问</th><th>鹿饼回复</th><th>状态</th></tr></thead><tbody>
        {data.rows.map(row => <tr key={row.id}><td>{dateText(row.requestedAt)}<p>{row.scope === 'group' ? '群聊艾特' : '私聊'}</p>
          <small>会话 {row.conversation.slice(0, 12)}<br />用户 {row.user.slice(0, 12)}</small></td>
          <td><p className="comment-copy">{row.question || '（空艾特）'}</p></td><td><p className="comment-copy">{row.answer || '—'}</p><small>{row.model || '固定回复'}</small>
            {row.agent && <details><summary>查询过程 · {row.agent.modelCalls} 次模型调用</summary>
              <p>{row.agent.tools.length ? row.agent.tools.map(step => `${step.name}（${step.status === 'ok' ? '完成' : '失败'}，${step.elapsedMs} ms）`).join(' → ') : '直接回答，未调用资料工具'}</p>
              <small>输入 {row.agent.inputTokens} / 输出 {row.agent.outputTokens} token（缺少用量时按预算估计）</small>
            </details>}
            {row.image && <><a href={`/api/admin/qq-records/${row.appId}/${data.date}/${row.id}/image`} target="_blank" rel="noreferrer">
              <Image unoptimized src={`/api/admin/qq-records/${row.appId}/${data.date}/${row.id}/image`} width={240} height={240} alt="鹿饼按本次要求生成的图片" style={{ objectFit: 'contain' }} />
            </a><details><summary>生图提示词</summary><p className="comment-copy">{row.image.prompt}</p></details></>}
          </td><td>{QQ_RECORD_STATUSES[row.status]}{row.error && <p>{row.error === 'image_failed' ? '图片生成失败' : '模型请求失败'}，使用固定提示</p>}<small>{dateText(row.updatedAt)}</small></td></tr>)}
        {!data.rows.length && <tr><td colSpan={4}>暂无符合条件的记录。在群里从 QQ 的艾特列表选中鹿饼后发送问题。</td></tr>}
      </tbody></table></div>
      <div className="toolbar"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {data.pages}</span>
        <button disabled={page >= data.pages} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </>}
  </div>;
}
