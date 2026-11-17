'use client';
import { useState } from 'react';
import type { AdminAIVideoQueueView } from '../../core/admin/aiVideoQueue';
import { dateText, useResource } from './client';

const labels: Record<string, string> = { draft: '待用户确认', pending: '排队中', submitted: '生成中', paused: '已暂停', needs_review: '需核对', completed: '已完成', failed: '失败', cancelled: '已取消' };
const failures: Record<string, string> = { insufficient_credits: '没积分了', account_unavailable: '需检查即梦登录', confirmation_required: '积分自动处理待检查', billing_unavailable: '积分报价不可用',
  provider_rejected: '生成被拒绝', provider_unavailable: '服务暂不可用', invalid_reference: '素材不可用', prompt_too_long: '提示词过长', needs_review: '提交结果需核对' };

export function AIVideoQueue() {
  const [view, setView] = useState('active'), [search, setSearch] = useState(''), [page, setPage] = useState(1);
  const resource = useResource<AdminAIVideoQueueView>(`/queues/ai-video?view=${view}&search=${encodeURIComponent(search)}&page=${page}`, 5000, true);
  const data = resource.data;
  return <div className="ai-video-queue">
    <div className="toolbar"><p className="muted">即梦视频生成队列与历史，每 5 秒更新。</p><button onClick={resource.refresh}>刷新</button></div>
    {resource.error && <div className="notice error" role="alert">{resource.error}{data && '；下方保留上次读取的状态。'}</div>}
    {!data && resource.loading && <p role="status">正在读取视频队列…</p>}
    {data && <>
      <section className="login-status" aria-label="视频队列概况"><dl>
        <div><dt>待用户确认</dt><dd>{data.counts.draft || 0}</dd></div>
        <div><dt>排队中</dt><dd>{data.counts.pending || 0}</dd></div><div><dt>生成中</dt><dd>{data.counts.submitted || 0}</dd></div>
        <div><dt>暂停与待核对</dt><dd>{(data.counts.paused || 0) + (data.counts.needs_review || 0)}</dd></div><div><dt>已完成</dt><dd>{data.counts.completed || 0}</dd></div>
      </dl><p className="muted">队列更新于 {dateText(data.updatedAt)}。生成中表示远端任务已提交，排队位置和预计完成时间以实际记录为准。</p></section>
      <details><summary>各用户视频积分统计（{data.creditUsage?.length || 0} 人）</summary>
        <p className="muted">覆盖全部队列历史，不受下方筛选和分页影响。已提交积分按当时报价上限累计；实际扣费与退款以即梦账单为准。旧记录缺少报价时单列，不按零积分计算。</p>
        <div className="table-scroll"><table><thead><tr><th>用户</th><th>任务 / 完成</th><th>已提交积分（报价上限）</th><th>提交待核对积分</th><th>缺少报价的任务</th></tr></thead><tbody>
          {data.creditUsage?.map(user => <tr key={user.key}><td>{user.senderName || '未记录昵称'}<small className="muted"> · {user.key.slice(0, 12)}</small></td>
            <td>{user.tasks} / {user.completed}</td><td>{user.submittedCredits}</td><td>{user.uncertainCredits}</td><td>{user.unpricedTasks}</td></tr>)}
          {!data.creditUsage?.length && <tr><td colSpan={5}>暂无 QQ 用户视频记录</td></tr>}
        </tbody></table></div>
      </details>
      <div className="toolbar"><label>显示 <select value={view} onChange={event => { setView(event.target.value); setPage(1); }}>
        <option value="active">当前队列</option><option value="history">历史记录</option><option value="all">全部任务</option></select></label>
        <label>搜索 <input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="名称、提示词或模型" maxLength={200} /></label>
        <span className="muted">共 {data.total} 条</span></div>
      <div className="table-scroll"><table><thead><tr><th>状态与进度</th><th>视频内容</th><th>生成设置</th><th>时间</th></tr></thead><tbody>
        {data.rows.map(row => <tr key={row.key}><td><span className={`status status-${row.status}`}>{labels[row.status] || row.status}</span>
          <p>已完成 {row.completed} / {row.repeat} 次</p>{row.active > 0 && <p className="muted">{row.active} 次处理中</p>}
          {row.failureCode && <p>{failures[row.failureCode] || '需检查任务'}</p>}{row.requiredCredits !== undefined && <p>报价上限 {row.requiredCredits} 积分</p>}</td>
          <td><strong>{row.name}</strong><p className="muted">{row.source === 'qq' ? 'QQ 请求' : '手工队列'} · {row.backend === 'dreamina-canvas' ? 'Canvas' : 'Dreamina CLI'}</p>
            <details><summary>查看提示词</summary><p className="comment-copy">{row.prompt || '未记录提示词'}</p><small className="muted">{row.id}</small></details>
            {row.playable && <details><summary>预览视频</summary><video controls preload="none" style={{ maxWidth: '100%', maxHeight: 420 }} src={`/api/admin/queues/ai-video/${row.key}/media`} /></details>}</td>
          <td>{row.model}<p>{row.resolution} · {row.ratio} · {row.duration} 秒</p><p className="muted">{row.referenceCount} 张参考图 · {row.videoCount || 0} 段参考视频 · {row.audioCount} 段声音</p></td>
          <td>创建 {dateText(row.createdAt)}<p>提交 {dateText(row.lastSubmittedAt)}</p>{row.nextQueryAt && <p className="muted">下次检查 {dateText(row.nextQueryAt)}</p>}</td></tr>)}
        {!data.rows.length && <tr><td colSpan={4}>{view === 'active' ? '当前没有等待或运行中的视频任务' : '暂无符合条件的视频记录'}</td></tr>}
      </tbody></table></div>
      <div className="toolbar"><button disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>上一页</button><span>{data.page} / {data.pages}</span>
        <button disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>下一页</button></div>
    </>}
  </div>;
}
