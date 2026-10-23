'use client';
import { useState } from 'react';
import type { AdminCommentRepliesView } from '../../core/admin/commentReplies';
import { dateText, useResource } from './client';

const labels: Record<string, string> = { queued: '排队中', generating: '处理中', ready: '等待发送', sending: '提交中',
  sent: '已提交（平台回执）', unknown: '发送结果待核实', failed: '处理失败', expired: '已过期', skipped: '已跳过' };
const likes: Record<string, string> = { pending: '点赞中', liked: '已点赞', unknown: '点赞结果待核实', skipped: '未点赞' };
export function CommentReplies() {
  const [filter, setFilter] = useState('all'), [page, setPage] = useState(1);
  const resource = useResource<AdminCommentRepliesView>(`/comment-replies?status=${filter}&page=${page}`, 5000, true);
  const data = resource.data;
  const active = data ? ['queued', 'generating', 'ready', 'sending'].reduce((sum, status) => sum + (data.counts[status] || 0), 0) : 0;
  return <div className="comment-replies">
    <div className="toolbar"><p className="muted">查看评论回复的处理进度与最近 7 天记录，每 5 秒更新。</p><button onClick={resource.refresh}>刷新</button></div>
    {resource.error && <div className="notice error" role="alert">{resource.error}</div>}
    {!data && resource.loading && <p role="status">正在读取评论记录…</p>}
    {data && <>
      <section className="login-status" aria-label="自动回复状态"><h2>{{ running: '自动回复运行中', paused: '自动回复已暂停，需核实', stopped: '自动回复已停止', missing: '尚无评论记录' }[data.service]}</h2>
        <dl><div><dt>排队与处理中</dt><dd>{active} 条</dd></div><div><dt>已提交</dt><dd>{data.counts.sent || 0} 条</dd></div>
          <div><dt>今日模型请求预留</dt><dd>{data.today.modelCalls} / {data.today.limit}</dd></div></dl>
        <p className="muted">状态更新于 {dateText(data.updatedAt)}。已提交表示 B 站返回成功回执，公开可见性仍由平台审核决定。</p>
      </section>
      <div className="toolbar"><label>显示 <select value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }}>
        <option value="all">全部记录</option><option value="active">排队与处理中</option><option value="history">已处理记录</option></select></label>
        <span className="muted">共 {data.total} 条</span></div>
      <div className="table-scroll"><table><thead><tr><th>状态</th><th>评论与回复</th><th>处理时间</th></tr></thead><tbody>
        {data.rows.map(row => <tr key={row.key}><td><span className={`status status-${row.status}`}>{labels[row.status] || row.status}</span>
          <p className="muted">{row.likeStatus ? likes[row.likeStatus] : '旧记录未记录点赞'}</p></td>
          <td><div className="muted">UID {row.uid} · {row.trigger === 'mention' ? '@ 鹿饼' : row.trigger === 'reply' ? '评论回复' : '历史记录'}</div>
            <p className="comment-copy">{row.text}</p>{row.answer && <p className="comment-copy comment-answer">鹿饼：{row.answer}</p>}
            {row.url && <a href={row.url} target="_blank" rel="noreferrer">打开评论区 ↗</a>}
            {row.replyId && <div className="muted">回复 ID {row.replyId}</div>}</td>
          <td>接收 {dateText(row.admittedAt)}{row.processingAt && <p>开始 {dateText(row.processingAt)}</p>}{row.completedAt && <p>完成 {dateText(row.completedAt)}</p>}</td></tr>)}
        {!data.rows.length && <tr><td colSpan={3}>暂无符合条件的记录</td></tr>}
      </tbody></table></div>
      <div className="toolbar"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button>
        <span>{page} / {data.pages}</span><button disabled={page >= data.pages} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </>}
  </div>;
}
