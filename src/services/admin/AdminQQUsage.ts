import * as fs from 'fs';
import * as path from 'path';
import { QQAccountUsage, QQQuotaStatus } from '../../core/admin/qqRecords';
import { QQ_LIMITS } from '../qqbot/QQPolicy';
import { QQ_IMAGE_LIMITS } from '../qqbot/QQImagePolicy';
import { QQState, validateQQState } from '../qqbot/QQState';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';

export interface QQUsagePolicy {
  dailyTokenBudget: number;
  images?: { enabled: boolean; dailyLimit: number; userDailyLimit: number };
}
export interface QQUsageSnapshot { state?: QQState; policy?: QQUsagePolicy }
const unknown = (): QQQuotaStatus => ({ status: 'unavailable', reasons: [{ code: 'unavailable', label: '运行账本或额度配置不可用' }] });
const nextMidnight = (now: number) => Date.parse(`${shanghaiDay(now)}T00:00:00+08:00`) + 86400000;
const recent = (starts: number[], now: number, window: number) => starts.filter(at => now - at < window);

/** Pure projection of the worker's admission rules; never uses noticeUntil as an actual quota. */
export function qqUserQuota(snapshot: QQUsageSnapshot, userId: string, scope: 'group' | 'c2c', now: number): { text: QQQuotaStatus; image?: QQQuotaStatus } {
  const { state, policy } = snapshot;
  if (!state) return { text: unknown() };
  const user = state.users[userId], today = state.day === shanghaiDay(now);
  const paused: QQQuotaStatus['reasons'] = state.paused ? [{ code: 'paused', label: '机器人已暂停，需人工核对恢复' }] : [];
  if (scope === 'c2c') {
    const until = (user?.privateAt ?? -QQ_LIMITS.privateIntervalMs) + QQ_LIMITS.privateIntervalMs;
    const reasons = [...paused, ...(until > now ? [{ code: 'private_cooldown', label: '私聊引导冷却', until }] : [])];
    return { text: { status: state.paused ? 'paused' : reasons.length ? 'limited' : 'available', reasons } };
  }
  if (!policy) return { text: state.paused ? { status: 'paused', reasons: paused } : unknown() };
  const starts = recent(user?.starts || [], now, QQ_LIMITS.userWindowMs);
  const globalStarts = recent(state.starts, now, 60000);
  const reasons: QQQuotaStatus['reasons'] = [...paused];
  if (starts.length >= QQ_LIMITS.userWindowReplies) reasons.push({ code: 'user_window', label: '个人五小时额度已满', until: Math.min(...starts) + QQ_LIMITS.userWindowMs });
  if (globalStarts.length >= QQ_LIMITS.startsPerMinute) reasons.push({ code: 'global_minute', label: '全局每分钟生成限流', until: Math.min(...globalStarts) + 60000 });
  if ((today ? state.tokens : 0) + QQ_LIMITS.reservation > policy.dailyTokenBudget) reasons.push({ code: 'global_tokens', label: '全局每日文本预算不足', until: nextMidnight(now) });
  const text: QQQuotaStatus = { status: state.paused ? 'paused' : reasons.length ? 'limited' : 'available',
    used: starts.length, limit: QQ_LIMITS.userWindowReplies, remaining: Math.max(0, QQ_LIMITS.userWindowReplies - starts.length), windowMs: QQ_LIMITS.userWindowMs, reasons };
  if (!policy.images?.enabled) return { text };
  const imageReasons: QQQuotaStatus['reasons'] = [...paused];
  const images = today ? user?.images || 0 : 0;
  const imageStarts = recent(user?.imageStarts || [], now, QQ_IMAGE_LIMITS.userWindowMs);
  if (images >= policy.images.userDailyLimit) imageReasons.push({ code: 'user_images', label: '个人每日生图额度已满', until: nextMidnight(now) });
  if (imageStarts.length >= QQ_IMAGE_LIMITS.userWindowImages) imageReasons.push({ code: 'user_image_window', label: '个人五小时生图额度已满', until: Math.min(...imageStarts) + QQ_IMAGE_LIMITS.userWindowMs });
  if ((today ? state.images || 0 : 0) >= policy.images.dailyLimit) imageReasons.push({ code: 'global_images', label: '全局每日生图额度已满', until: nextMidnight(now) });
  if (state.lastImageAt !== undefined && state.lastImageAt + QQ_IMAGE_LIMITS.intervalMs > now) imageReasons.push({ code: 'image_cooldown', label: '全局生图间隔', until: state.lastImageAt + QQ_IMAGE_LIMITS.intervalMs });
  return { text, image: { status: state.paused ? 'paused' : imageReasons.length ? 'limited' : 'available', used: images,
    limit: policy.images.userDailyLimit, remaining: Math.max(0, policy.images.userDailyLimit - images),
    window: { used: imageStarts.length, limit: QQ_IMAGE_LIMITS.userWindowImages,
      remaining: Math.max(0, QQ_IMAGE_LIMITS.userWindowImages - imageStarts.length), windowMs: QQ_IMAGE_LIMITS.userWindowMs }, reasons: imageReasons } };
}

export function qqAccountUsage(appId: string, snapshot: QQUsageSnapshot, now: number): QQAccountUsage {
  const { state, policy } = snapshot;
  if (!state || !policy) return { appId, status: 'unavailable' };
  return { appId, status: state.paused ? 'paused' : 'ok', day: shanghaiDay(now),
    tokensUsed: state.day === shanghaiDay(now) ? state.tokens : 0, tokenBudget: policy.dailyTokenBudget,
    starts: recent(state.starts, now, 60000).length, startsLimit: QQ_LIMITS.startsPerMinute };
}

/** Only fixed public config fields and hashed runtime counters. No provider/credential loading or writes. */
export function readQQUsage(root: string, appId: string, budget = { remaining: 32 * 1024 * 1024 }): QQUsageSnapshot {
  const snapshot: QQUsageSnapshot = {};
  if (!/^[1-9]\d{0,24}$/u.test(appId)) return snapshot;
  const read = (directory: string, name: string, maxBytes: number, ledger = false) => {
    const folder = fs.lstatSync(directory), file = path.join(directory, name), stat = fs.lstatSync(file);
    if (folder.isSymbolicLink() || !folder.isDirectory() || stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) throw new Error('Invalid QQ usage source');
    if (ledger) { if (stat.size > budget.remaining) throw new Error('QQ usage read budget exceeded'); budget.remaining -= stat.size; }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  try {
    const state = read(path.join(root, 'data/runtime/qqbot'), `${appId}.json`, 32 * 1024 * 1024, true) as QQState;
    validateQQState(state, appId); snapshot.state = state;
  } catch { /* Missing/corrupt state is explicitly unknown, never a zero-use account. */ }
  try {
    const config = read(path.join(root, 'config'), 'qqbot.example.json', 65536);
    if (!Number.isSafeInteger(config.dailyTokenBudget) || config.dailyTokenBudget < QQ_LIMITS.reservation) throw new Error('Invalid QQ budget');
    snapshot.policy = { dailyTokenBudget: config.dailyTokenBudget };
    if (config.images?.enabled) {
      const { dailyLimit, userDailyLimit } = config.images;
      if (![dailyLimit, userDailyLimit].every(value => Number.isInteger(value) && value >= 1 && value <= 300) || userDailyLimit > dailyLimit) throw new Error('Invalid QQ image quota');
      snapshot.policy.images = { enabled: true, dailyLimit, userDailyLimit };
    }
  } catch { snapshot.policy = undefined; }
  return snapshot;
}
