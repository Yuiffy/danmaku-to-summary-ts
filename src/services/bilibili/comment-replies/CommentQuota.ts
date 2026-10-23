import { CommentAudience, CommentReplyConfig, FanTier, LIMITS, QUOTA_NOTICE, shanghaiDay } from './CommentPolicy';
import type { CommentJob, CommentState } from './CommentState';

export const HOUR_MS = 3600000;
export function fanTier(config: CommentReplyConfig, audience?: CommentAudience): FanTier {
  const uid = audience?.status === 'available' ? audience.wearing?.anchorUid : undefined;
  return uid && uid === config.fanQuota?.suiUid ? 'sui' : uid && config.fanQuota?.relatedUids.includes(uid) ? 'related' : 'other';
}
export function quotaExceeded(config: CommentReplyConfig, state: CommentState, job: CommentJob, now: number): 'daily' | 'hourly' | undefined {
  if (config.unlimitedUids.includes(job.event.uid)) return undefined;
  const tier = fanTier(config, job.audience);
  const user = state.days[shanghaiDay(now)]?.users[job.event.uid];
  if (job.quotaDay !== shanghaiDay(now) && (user?.count || 0) >= (config.fanQuota?.daily[tier] ?? LIMITS.dailyUserReplies)) return 'daily';
  if (config.fanQuota && (job.quotaAt === undefined || job.quotaAt <= now - HOUR_MS) &&
    (state.userWindows?.[job.event.uid]?.starts.filter(at => at > now - HOUR_MS).length || 0) >= config.fanQuota.hourly[tier]) return 'hourly';
  return undefined;
}
function noticeText(config: CommentReplyConfig, job: CommentJob, kind: 'daily' | 'hourly'): string {
  if (!config.fanQuota) return QUOTA_NOTICE;
  if (fanTier(config, job.audience) === 'sui') return kind === 'hourly'
    ? '哎呀，陪饼干岁聊得有点困困了的说，让人家眯一小会儿，等会儿再来找我玩吧～'
    : '今天和饼干岁聊得好开心，人家先困困啦，明天再一起玩吧～';
  return kind === 'hourly'
    ? '哎呀人家鹿饼有点困困了的说，先眯一小会儿～戴着饼干岁牌子来叫我，会更有精神陪你聊哦。'
    : '今天聊得有点困困了，明天再来找人家玩吧～戴着饼干岁牌子来，还能多陪你聊一会儿哦。';
}

/** Reserve before IO; UID usage is shared across tiers, threads and badge changes. */
export function reserveCommentQuota(config: CommentReplyConfig, state: CommentState, job: CommentJob, now: number): 'allowed' | 'notice' | 'skip' {
  const day = shanghaiDay(now), uid = job.event.uid;
  const usage = state.days[day] ||= { tokens: 0, users: {} };
  const user = usage.users[uid] ||= { count: 0, notice: false };
  const window = config.fanQuota && !config.unlimitedUids.includes(uid) ? ((state.userWindows ||= {})[uid] ||= { starts: [] }) : undefined;
  if (window) window.starts = window.starts.filter(at => at > now - HOUR_MS);
  const exceeded = quotaExceeded(config, state, job, now);
  if (exceeded) {
    const tier = fanTier(config, job.audience);
    const until = exceeded === 'hourly' ? window!.starts[window!.starts.length - config.fanQuota!.hourly[tier]] + HOUR_MS
      : Date.parse(`${day}T00:00:00+08:00`) + 86400000;
    if (exceeded === 'daily' ? user.notice : (window!.noticeUntil || 0) > now) {
      if (exceeded === 'hourly') window!.noticeUntil = Math.max(window!.noticeUntil!, until);
      return 'skip';
    }
    if (exceeded === 'daily') user.notice = true;
    else window!.noticeUntil = until;
    job.notice = true; job.noticeUntil = until; job.quotaDay = day;
    job.answer = noticeText(config, job, exceeded);
    return 'notice';
  }
  if (job.quotaDay !== day) user.count++;
  if (job.quotaAt === undefined || job.quotaAt <= now - HOUR_MS) {
    window?.starts.push(now); job.quotaAt = now;
  }
  job.quotaDay = day;
  return 'allowed';
}
