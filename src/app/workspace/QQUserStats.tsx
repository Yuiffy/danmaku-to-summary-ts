'use client';
import type { AdminQQRecordsView, QQQuotaStatus } from '../../core/admin/qqRecords';
import { dateText } from './client';

const statusText = { available: '可用', limited: '已限频', paused: '已暂停', unavailable: '未知' };
function Quota({ value }: { value: QQQuotaStatus }) {
  return <div className={`qq-quota qq-quota-${value.status}`}>
    <strong>{statusText[value.status]}</strong>
    {value.used !== undefined && <span> {value.used} / {value.limit} · 剩余 {value.remaining}</span>}
    {value.window && <small>滚动 5 小时 {value.window.used} / {value.window.limit} · 剩余 {value.window.remaining}</small>}
    {value.reasons.map(reason => <small key={reason.code}>{reason.label}{reason.until && <> · {dateText(reason.until)} 可重新尝试</>}</small>)}
  </div>;
}

export function QQUserStats({ data, selectedUser, onSelect }: { data: AdminQQRecordsView; selectedUser: string; onSelect: (key: string) => void }) {
  const users = selectedUser ? data.users.filter(user => user.key === selectedUser) : data.users.slice(0, 100);
  return <details className="qq-user-stats" open>
    <summary>用户统计与当前限频 · {data.users.length} 位用户</summary>
    <p className="muted">用户统计按 {data.date} 与消息类型汇总，不受会话、状态和关键词筛选影响。额度为当前运行账本快照，{dateText(data.asOf)} 更新。</p>
    <div className="table-scroll qq-user-table"><table><thead><tr><th>用户</th><th>记录 / 会话</th><th>已回复 / 额度提示</th><th>文本额度 · 滚动 5 小时</th><th>生图额度 · 今日</th><th>会话筛选</th></tr></thead><tbody>
      {users.map(user => <tr key={user.key} className={selectedUser === user.key ? 'qq-user-selected' : ''}>
        <td><strong>{user.senderName || 'QQ 未提供昵称'}</strong><small>{user.user.slice(0, 12)} · {user.scope === 'group' ? '群聊' : '私聊'}</small><small>最近提问 {dateText(user.lastAt)}</small></td>
        <td>{user.stats.records} 条 / {user.stats.conversations} 个</td><td>{user.stats.replied} / {user.stats.quotaNotices}<small>异常 {user.stats.failed} · 跳过 {user.stats.skipped}</small></td>
        <td><Quota value={user.text} />{user.scope === 'c2c' && <small>仅固定入群引导</small>}</td>
        <td>{user.image ? <Quota value={user.image} /> : '—'}</td>
        <td><button type="button" aria-pressed={selectedUser === user.key} onClick={() => onSelect(user.key)}>看会话</button></td>
      </tr>)}
      {!users.length && <tr><td colSpan={6}>所选日期与消息类型下暂无用户记录。</td></tr>}
    </tbody></table></div>
    {!selectedUser && data.users.length > 100 && <p className="muted">展示最近提问的 100 位用户；可用上方用户筛选定位其他用户。</p>}
    <div className="qq-account-usage">{data.accounts.map(account => <p key={account.appId} className="muted">
      全局 · 账号 {account.appId} · {account.status === 'unavailable' ? '运行账本或额度配置不可用' : <>
        {account.status === 'paused' && <strong>机器人已暂停 · </strong>}今日文本预算 {(account.tokensUsed || 0).toLocaleString('zh-CN')} / {account.tokenBudget?.toLocaleString('zh-CN')} token
        · 近一分钟 {account.starts} / {account.startsLimit} 次生成</>}
    </p>)}</div>
  </details>;
}
