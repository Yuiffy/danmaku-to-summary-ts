'use client';
import { useState } from 'react';
import Image from 'next/image';
import { QQ_RECORD_STATUSES, type AdminQQRecordsView } from '../../core/admin/qqRecords';
import { dateText, useResource } from './client';
import { QQUserStats } from './QQUserStats';
import { QQ_FAILURE_CODES, type QQDiagnostic } from '../../core/admin/qqDiagnostics';

function FailureDetail({ value }: { value: QQDiagnostic }) {
  return <div><p>{QQ_FAILURE_CODES[value.code]} · <code>{value.stage}/{value.code}</code></p>
    <small>{dateText(value.at)}{value.turn !== undefined && ` · 第 ${value.turn} 轮`}{value.elapsedMs !== undefined && ` · ${value.elapsedMs} ms`}
      {value.httpStatus !== undefined && ` · HTTP ${value.httpStatus}`}{value.finishReason && ` · finish_reason=${value.finishReason}`}</small>
    {value.budgetBefore !== undefined && <p>累计预留 {value.budgetBefore} + 本轮 {value.charge} / 上限 {value.budgetLimit}；请求 {value.requestBytes} 字节</p>}
    {value.requestId && <p>上游请求 ID：<code>{value.requestId}</code></p>}
    {(value.errorName || value.systemCode) && <p>异常类型：{value.errorName} {value.systemCode}</p>}
    {value.validation && <p>校验项：{value.validation} · 输出 {value.outputChars} 字</p>}
    {value.fingerprint && <small>异常指纹：{value.fingerprint}</small>}
    {!!value.frames?.length && <p>调用位置：<code>{value.frames.join(' ← ')}</code></p>}
  </div>;
}

export function QQRecords() {
  const [date, setDate] = useState(''), [scope, setScope] = useState('all'), [status, setStatus] = useState('all');
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(1);
  const [user, setUser] = useState(''), [conversation, setConversation] = useState('');
  const resource = useResource<AdminQQRecordsView>(`/qq-records?date=${date}&scope=${scope}&status=${status}&user=${encodeURIComponent(user)}&conversation=${encodeURIComponent(conversation)}&search=${encodeURIComponent(query)}&page=${page}`, 5000);
  const data = resource.data;
  const selectUser = (value: string) => { setUser(value); setConversation(''); setPage(1); };
  const resetPeople = () => { setUser(''); setConversation(''); setPage(1); };
  return <div className="comment-replies">
    <div className="toolbar"><p className="muted">群聊仅响应艾特，私聊回复入群引导。问答长期保存在本机，每 5 秒更新。</p><button onClick={resource.refresh}>刷新</button></div>
    <form className="toolbar" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(1); }}>
      <label>日期 <select value={date} onChange={event => { setDate(event.target.value); resetPeople(); }}><option value="">最新有记录日期</option>
        {data?.dates.map(day => <option key={day} value={day}>{day}</option>)}
      </select></label>
      <label>消息类型 <select value={scope} onChange={event => { setScope(event.target.value); resetPeople(); }}>
        <option value="all">全部</option><option value="group">群聊艾特</option><option value="c2c">私聊</option></select></label>
      <label>用户 <select value={user} onChange={event => selectUser(event.target.value)}><option value="">全部用户</option>
        {data?.users.map(item => <option key={item.key} value={item.key}>{item.senderName || item.user.slice(0, 12)} · {item.scope === 'group' ? '群聊' : '私聊'} · {item.stats.records} 条</option>)}
      </select></label>
      <label>会话 <select value={conversation} onChange={event => { setConversation(event.target.value); setPage(1); }}><option value="">全部会话</option>
        {data?.conversations.map(item => <option key={item.key} value={item.key}>{item.scope === 'group' ? '群聊' : '私聊'} {item.conversation.slice(0, 12)} · {item.records} 条</option>)}
      </select></label>
      <label>状态 <select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="all">全部</option>
        {Object.entries(QQ_RECORD_STATUSES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>关键词 <input value={search} maxLength={120} onChange={event => setSearch(event.target.value)} placeholder="昵称、问题、回答或会话标识" /></label><button type="submit">筛选</button>
    </form>
    {resource.error && <div className="notice error" role="alert">{resource.error}</div>}
    {!data && resource.loading && <p role="status">正在读取 QQ 问答…</p>}
    {data && <>
      <QQUserStats data={data} selectedUser={user} onSelect={selectUser} />
      <dl className="qq-statistics" aria-label="本次筛选统计">
        {[['记录', data.summary.records], ['已回复', data.summary.replied], ['生成 / 发送异常', data.summary.failed],
          ['额度提示', data.summary.quotaNotices], ['用户', data.summary.users], ['会话', data.summary.conversations]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <p className="muted">{data.date} · 本次筛选共 {data.total} 条（分页前统计）· 处理中 {data.summary.active} · 跳过 {data.summary.skipped} · 成图 {data.summary.images}。仅“已回复”表示收到 QQ 成功回执。</p>
      <div className="table-scroll"><table><thead><tr><th>时间与会话</th><th>提问</th><th>鹿饼回复</th><th>状态</th></tr></thead><tbody>
        {data.rows.map(row => <tr key={row.id}><td>{dateText(row.requestedAt)}<p>{row.scope === 'group' ? '群聊艾特' : '私聊'}</p>
          <p>{row.senderName || 'QQ 未提供昵称'}</p><small><button className="qq-link" onClick={() => { setConversation(`${row.appId}:${row.conversation}`); setPage(1); }}>会话 {row.conversation.slice(0, 12)}</button><br />
            <button className="qq-link" onClick={() => selectUser(`${row.appId}:${row.user}`)}>用户 {row.user.slice(0, 12)}</button></small></td>
          <td><p className="comment-copy">{row.question || '（空艾特）'}</p></td><td><p className="comment-copy">{row.answer || '—'}</p><small>{row.model || '固定回复'}</small>
            {row.agent && <details><summary>查询过程 · {row.agent.modelCalls} 次模型调用</summary>
              <p>{row.agent.tools.length ? row.agent.tools.map(step => `${step.name}（${step.status === 'ok' ? '完成' : '失败'}，${step.elapsedMs} ms）`).join(' → ') : '未执行资料工具'}</p>
              <small>输入 {row.agent.inputTokens} / 输出 {row.agent.outputTokens} token（缺少用量时按预算估计）</small>
              {row.agent.calls?.map(call => <div key={call.turn}><p>第 {call.turn} 轮 · {call.status === 'ok' ? '完成' : call.status === 'blocked' ? '调用前阻止' : call.status === 'running' ? '请求中／尚未记录完成' : '失败'} · {call.elapsedMs} ms
                {call.httpStatus !== undefined && ` · HTTP ${call.httpStatus}`}{call.finishReason && ` · ${call.finishReason}`}</p>
                <small>{dateText(call.at)} · 请求 {call.requestBytes} 字节 · 预留 {call.budgetBefore} + {call.charge} / {call.budgetLimit}</small>
                {call.requestId && <p>上游请求 ID：<code>{call.requestId}</code></p>}
                {call.failure && <FailureDetail value={call.failure} />}</div>)}
              {row.agent.tools.filter(step => step.failure).map((step, index) => <div key={index}><p>{step.name}</p><FailureDetail value={step.failure!} /></div>)}
              {row.agent.failures?.map((failure, index) => <FailureDetail key={index} value={failure} />)}
            </details>}
            {row.image && <><a href={`/api/admin/qq-records/${row.appId}/${data.date}/${row.id}/image`} target="_blank" rel="noreferrer">
              <Image unoptimized src={`/api/admin/qq-records/${row.appId}/${data.date}/${row.id}/image`} width={240} height={240} alt="鹿饼按本次要求生成的图片" style={{ objectFit: 'contain' }} />
            </a><details><summary>生图提示词</summary><p className="comment-copy">{row.image.prompt}</p></details></>}
          </td><td>{QQ_RECORD_STATUSES[row.status]}{row.error && <p>{row.error === 'image_failed' ? '图片生成失败' : '模型请求失败'}，使用固定提示</p>}
            {row.failure && <details open><summary>失败原因</summary><FailureDetail value={row.failure} /></details>}
            {row.sendFailure && <details open><summary>发送异常</summary><FailureDetail value={row.sendFailure} /></details>}
            {row.error && !row.failure && <p>旧记录未保存详细原因</p>}
            <details><summary>诊断标识</summary><p>请求哈希：<code>{row.id}</code></p>{row.queuedMs !== undefined && <p>排队 {row.queuedMs} ms</p>}</details>
            <small>{dateText(row.updatedAt)}</small></td></tr>)}
        {!data.rows.length && <tr><td colSpan={4}>暂无符合条件的记录。在群里从 QQ 的艾特列表选中鹿饼后发送问题。</td></tr>}
      </tbody></table></div>
      <div className="toolbar"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {data.pages}</span>
        <button disabled={page >= data.pages} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </>}
  </div>;
}
