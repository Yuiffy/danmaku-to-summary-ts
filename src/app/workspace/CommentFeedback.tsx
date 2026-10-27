'use client';
import { useState } from 'react';
import { COMMENT_FEEDBACK_CATEGORIES, type AdminCommentFeedbackView } from '../../core/admin/commentFeedback';
import { dateText, useResource } from './client';

export function CommentFeedback() {
  const [category, setCategory] = useState('all'), [search, setSearch] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(1);
  const resource = useResource<AdminCommentFeedbackView>(`/comment-feedback?category=${category}&search=${encodeURIComponent(query)}&page=${page}`, 30000);
  const data = resource.data;
  return <div className="comment-replies">
    <div className="toolbar"><p className="muted">收集我们投稿视频中主动 @ 鹿饼的制作意见，保留原话与来源，供后续复盘。每 30 秒更新。</p><button onClick={resource.refresh}>刷新</button></div>
    <form className="toolbar" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(1); }}>
      <label>分类 <select value={category} onChange={event => { setCategory(event.target.value); setPage(1); }}><option value="all">全部分类</option>
        {Object.entries(COMMENT_FEEDBACK_CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>关键词 <input value={search} maxLength={120} onChange={event => setSearch(event.target.value)} placeholder="反馈原文、视频或作者" /></label><button type="submit">筛选</button>
    </form>
    {resource.error && <div className="notice error" role="alert">{resource.error}</div>}
    {!data && resource.loading && <p role="status">正在读取视频反馈…</p>}
    {data && <><p className="muted">符合筛选的反馈共 {data.total} 条。反馈独立长期保留，不随回复历史清理。</p>
      <div className="table-scroll"><table><thead><tr><th>分类与来源</th><th>反馈原话</th><th>时间</th></tr></thead><tbody>
        {data.rows.map(row => <tr key={row.id}><td>{COMMENT_FEEDBACK_CATEGORIES[row.category]}<p>{row.videoTitle || `视频 av${row.videoAid}`}</p>
          <a href={row.url} target="_blank" rel="noreferrer">查看原评论 ↗</a></td>
          <td><p className="comment-copy">{row.quote}</p><div className="muted">{row.authorName || '评论者'} · UID {row.authorUid}</div>
            <details><summary>完整评论</summary><p className="comment-copy">{row.comment}</p></details></td>
          <td>评论 {dateText(row.commentCreatedAt)}<p>收集 {dateText(row.collectedAt)}</p></td></tr>)}
        {!data.rows.length && <tr><td colSpan={3}>暂无符合条件的反馈。观众可在投稿视频下 @ 鹿饼，提出选材、剪辑或字幕等具体建议。</td></tr>}
      </tbody></table></div>
      <div className="toolbar"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {data.pages}</span>
        <button disabled={page >= data.pages} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </>}
  </div>;
}
