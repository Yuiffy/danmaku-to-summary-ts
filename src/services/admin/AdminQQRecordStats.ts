import { QQConversationSummary, QQRecord, QQRecordStats, QQUserSummary } from '../../core/admin/qqRecords';
import { QQ_QUOTA_REPLY } from '../qqbot/QQPolicy';
import { QQUsageSnapshot, qqUserQuota } from './AdminQQUsage';

export const qqIdentity = (appId: string, hash: string) => `${appId}:${hash}`;
export const qqQuotaNotice = (record: QQRecord) => record.answer === QQ_QUOTA_REPLY ||
  /^生图需要歇一会儿～(?:(?:每人每天|每人每5小时|全局每天)最多\d+张，请(?:稍后|明天)再试。|全局生图间隔至少1分钟，请稍后再试。)$/u.test(record.answer);

export function summarizeQQRecords(records: QQRecord[]): QQRecordStats {
  return { records: records.length, replied: records.filter(row => row.status === 'sent').length,
    failed: records.filter(row => !!row.error || row.status === 'unknown').length,
    active: records.filter(row => ['accepted', 'generating', 'sending'].includes(row.status)).length,
    skipped: records.filter(row => row.status === 'skipped').length, quotaNotices: records.filter(qqQuotaNotice).length,
    images: records.filter(row => !!row.image).length,
    users: new Set(records.map(row => qqIdentity(row.appId, row.user))).size,
    conversations: new Set(records.map(row => qqIdentity(row.appId, row.conversation))).size };
}

export function qqUsers(records: QQRecord[], snapshots: Map<string, QQUsageSnapshot>, now: number): QQUserSummary[] {
  const groups = new Map<string, QQRecord[]>();
  for (const row of records) {
    const key = qqIdentity(row.appId, row.user), group = groups.get(key) || [];
    group.push(row); groups.set(key, group);
  }
  return [...groups].map(([key, rows]) => {
    const latest = rows[0], name = rows.find(row => row.senderName)?.senderName;
    return { key, appId: latest.appId, user: latest.user, scope: latest.scope, ...(name ? { senderName: name } : {}),
      lastAt: latest.requestedAt, stats: summarizeQQRecords(rows), ...qqUserQuota(snapshots.get(latest.appId) || {}, latest.user, latest.scope, now) };
  });
}

export function qqConversations(records: QQRecord[]): QQConversationSummary[] {
  const groups = new Map<string, QQRecord[]>();
  for (const row of records) {
    const key = qqIdentity(row.appId, row.conversation), group = groups.get(key) || [];
    group.push(row); groups.set(key, group);
  }
  return [...groups].map(([key, rows]) => ({ key, appId: rows[0].appId, conversation: rows[0].conversation, scope: rows[0].scope,
    records: rows.length, users: new Set(rows.map(row => row.user)).size }));
}
