'use client';

import { useState } from 'react';
import { PeerCoverageHistoryItem } from '../../core/admin/contracts';
import { dateText, statusText } from './client';

export interface PeerCoverageHistoryResponse { items: PeerCoverageHistoryItem[]; total: number }

const peerStatusText: Record<string, string> = {
  covered: '已确认同题', original: '暂未发现同题', needs_review: '待人工复核', rejected: '已排除', budget: '达到预算'
};
const peerMatchStatusText: Record<string, string> = {
  covered: '已确认覆盖', same_event_unconfirmed: '疑似同题', subtitle_unavailable: '字幕不完整',
  read_failed: '读取失败', different_event: '不同事件', irrelevant: 'AI判定无关', own_account: '本账号'
};
function peerStatus(value: string) { return peerStatusText[value] || statusText(value); }
function peerMatchStatus(value: string) { return peerMatchStatusText[value] || value; }

export function PeerCoverageHistory({ history, error, onRefresh, onSelect }: {
  history?: PeerCoverageHistoryResponse; error?: string; onRefresh: () => void; onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const items = history?.items || [];
  const filtered = filter ? items.filter(item => item.status === filter) : items;
  const counts = items.reduce<Record<string, number>>((all, item) => { all[item.status] = (all[item.status] || 0) + 1; return all; }, {});
  return <section className="peer-coverage-history">
    <div className="section-heading"><div><h3>同题核查记录</h3><p className="muted">按时间查看投稿前 B 站查询；共享搜索索引和缓存状态也会保留。</p></div><div className="button-row"><select aria-label="同题核查状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="">全部 {history ? `(${history.total})` : ''}</option>{Object.entries(counts).map(([key, count]) => <option key={key} value={key}>{peerStatus(key)} ({count})</option>)}</select><button onClick={onRefresh}>刷新记录</button></div></div>
    {error && <div className="notice error" role="alert">同题核查记录读取失败：{error}<button onClick={onRefresh}>重试</button></div>}
    {!history && !error && <p className="muted">正在读取核查记录…</p>}
    {history && !filtered.length && <p className="muted">还没有符合条件的核查记录。</p>}
    {!!filtered.length && <div className="peer-history-list">{filtered.map((item, index) => <article className="peer-history-item" key={`${item.checkedAt}-${item.id}-${index}`}>
      <div className="peer-history-main"><div className="peer-history-heading"><button className="peer-history-clip" onClick={() => onSelect(item.id)}>#{item.id}</button><span className={`status status-${item.status}`}>{peerStatus(item.status)}</span><time dateTime={item.checkedAt}>{dateText(item.checkedAt)}</time>{item.cached && <span className="peer-history-cache">缓存</span>}</div>
        <strong title={item.title}>{item.title || '未记录标题'}</strong><small>{item.host || '未记录主播'}{item.sourceWindow ? ` · 源 ${item.sourceWindow.start.toFixed(1)}–${item.sourceWindow.end.toFixed(1)} 秒` : ''}</small></div>
      <div className="peer-history-result"><div className="peer-history-facts"><span>搜索 {item.searchCount} 次</span><span>候选 {item.matches.length} 条</span>{item.searchIndexCheckedAt && <span>共享索引 {dateText(item.searchIndexCheckedAt)}</span>}</div>
        {item.searches.length ? <div className="peer-history-searches">{item.searches.map((search, searchIndex) => <span key={`${search.query}-${searchIndex}`} title={search.bvids.join(', ')}><span className="mono">{search.query}</span> · {search.bvids.length} 条</span>)}</div> : <span className="muted">没有留下实际搜索词（可能在查询前就被限频或登录态拦截）</span>}
        {item.matches.length ? <div className="peer-history-matches">{item.matches.slice(0, 4).map((match: any, matchIndex: number) => <a key={`${match.bvid || 'match'}-${matchIndex}`} href={match.url || (match.bvid ? `https://www.bilibili.com/video/${match.bvid}/` : '#')} target="_blank" rel="noreferrer"><span className="mono">{match.bvid || '—'}</span> {match.title || '未命名视频'}<small>{peerMatchStatus(match.status)}{match.reason ? ` · ${match.reason}` : ''}</small></a>)}{item.matches.length > 4 && <small className="muted">还有 {item.matches.length - 4} 条，展开记录查看完整结果</small>}</div> : <p className="peer-history-reason">{item.reason}</p>}
        <details><summary>查看本次判断</summary><p>{item.reason}</p>{item.matches.length > 4 && <div className="peer-history-all-matches">{item.matches.slice(4).map((match: any, matchIndex: number) => <div key={`${match.bvid || 'match'}-${matchIndex}`}><span className="mono">{match.bvid || '—'}</span> · {peerMatchStatus(match.status)} · {match.title || '未命名视频'}{match.reason ? ` · ${match.reason}` : ''}</div>)}</div>}</details>
      </div>
    </article>)}</div>}
  </section>;
}
