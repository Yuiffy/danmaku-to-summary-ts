import { CommentImageConfig, positiveId, shanghaiDay } from './CommentPolicy';
import { CommentJob, CommentState } from './CommentState';
import { HOUR_MS } from './CommentQuota';

export type CommentImageLimitReason = 'trusted_hourly' | 'trusted_daily' | 'user_daily' | 'other_global_daily';

export function reserveCommentImage(config: CommentImageConfig, state: CommentState, job: CommentJob, now: number):
  { allowed: true } | { allowed: false; reason: CommentImageLimitReason } {
  const uid = job.event.uid;
  if (!positiveId(uid)) return { allowed: false, reason: 'user_daily' };
  const day = shanghaiDay(now);
  const usage = state.days[day] ||= { tokens: 0, users: {} };
  const images = usage.images ||= { total: 0, users: {} };
  const userCount = images.users[uid] || 0;
  if (config.trustedUids.includes(uid)) {
    const window = (state.imageWindows ||= {})[uid] ||= { starts: [] };
    window.starts = window.starts.filter(at => at > now - HOUR_MS);
    if (window.starts.length >= config.trustedHourlyLimit) return { allowed: false, reason: 'trusted_hourly' };
    if (userCount >= config.trustedDailyLimit) return { allowed: false, reason: 'trusted_daily' };
  } else {
    if (userCount >= config.otherUserDailyLimit) return { allowed: false, reason: 'user_daily' };
    if (images.total >= config.otherGlobalDailyLimit) return { allowed: false, reason: 'other_global_daily' };
  }
  images.users[uid] = userCount + 1;
  if (config.trustedUids.includes(uid)) state.imageWindows![uid].starts.push(now);
  if (!config.trustedUids.includes(uid)) images.total++;
  return { allowed: true };
}

export function commentImageLimitMessage(reason: CommentImageLimitReason): string {
  return reason === 'trusted_hourly' ? '这小时的生图额度用完啦，稍后再来找鹿饼吧～' :
    reason === 'trusted_daily' ? '今天的生图额度用完啦，明天再来找鹿饼吧～' :
    reason === 'user_daily' ? '你今天已经生过一张图啦，明天再来试试吧～' :
    '今天其他人的生图额度已经用完啦，明天再来试试吧～';
}
