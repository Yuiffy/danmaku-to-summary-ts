export interface CommentReplyConfig {
  botUid: string;
  unlimitedUids: string[];
  credentialConfigPath: string;
  providerConfigPath: string;
  dailyTokenBudget: number;
  maxQueue: number;
  maxUserQueue: number;
  pollIntervalMs: number;
  videoVision?: boolean;
  knowledge?: { runtimeConfigPath: string; roomId: string; collaborationRooms: string[] };
  projectSources?: Array<{ id: string; label: string; path: string; keywords: string[]; section?: string; kind: 'code' | 'skill' | 'guide' }>;
  speakerNames?: Record<string, string>;
  feedbackOwnerUids?: string[];
  fanQuota?: {
    suiUid: string; relatedUids: string[];
    hourly: Record<FanTier, number>; daily: Record<FanTier, number>;
  };
}
export type FanTier = 'sui' | 'related' | 'other';
export interface CommentAudience {
  status: 'available' | 'unavailable';
  wearing?: { anchorUid: string; name: string };
}

export const LIMITS = {
  sendIntervalMs: 5000, startsPerMinute: 5, dailyUserReplies: 10,
  inputChars: 600, outputChars: 300, outputTokens: 384,
  // Charge the whole reservation, including failed/uncertain provider calls. No refunds.
  tokenReservation: 4096, timeoutMs: 30000, maxAgeMs: 86400000,
  retentionMs: 7 * 86400000, maxTracked: 20000
} as const;
export const QUOTA_NOTICE = '今日你的鹿饼聊天额度到达上限，请明天再来哦~';
export const SAFETY_NOTICE = '鹿饼只能在这里聊聊天，不能执行命令、读取私人资料或操作账号哦~';
export class CommentPlatformBlocked extends Error {}

export function positiveId(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  return /^[1-9]\d{0,24}$/u.test(text) ? text : undefined;
}

export function shanghaiDay(now: number): string {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

export function validateCommentConfig(config: CommentReplyConfig): void {
  if (!config || !positiveId(config.botUid) || !Array.isArray(config.unlimitedUids) || config.unlimitedUids.length > 100 ||
      config.unlimitedUids.some(uid => !positiveId(uid) || typeof uid !== 'string') ||
      typeof config.credentialConfigPath !== 'string' || typeof config.providerConfigPath !== 'string') throw new Error('Invalid comment reply identities/config paths');
  for (const [key, min, max] of [
    ['dailyTokenBudget', LIMITS.tokenReservation, 40960000], ['maxQueue', 1, 1000],
    ['maxUserQueue', 1, 20], ['pollIntervalMs', 30000, 3600000]
  ] as const) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid comment replies ${key}`);
  }
  const knowledge = config.knowledge;
  if (config.videoVision !== undefined && typeof config.videoVision !== 'boolean') throw new Error('Invalid comment video vision flag');
  if (config.feedbackOwnerUids !== undefined && (!Array.isArray(config.feedbackOwnerUids) || config.feedbackOwnerUids.length > 20 ||
    config.feedbackOwnerUids.some(uid => typeof uid !== 'string' || !positiveId(uid)))) throw new Error('Invalid feedback video owners');
  if (config.projectSources && (!Array.isArray(config.projectSources) || config.projectSources.length > 8 ||
    config.projectSources.some(source => !source || !/^[a-z0-9-]{1,40}$/u.test(source.id) ||
      !['code', 'skill', 'guide'].includes(source.kind) || typeof source.label !== 'string' || !source.label.trim() ||
      source.label.length > 60 || unsafeComment(source.label) || typeof source.path !== 'string' || !source.path.trim() ||
      !Array.isArray(source.keywords) || !source.keywords.length || source.keywords.length > 12 ||
      source.keywords.some(word => typeof word !== 'string' || !word.trim() || word.length > 40) ||
      source.section !== undefined && (typeof source.section !== 'string' || !source.section.trim() || source.section.length > 120)) ||
    new Set(config.projectSources.map(source => source.id)).size !== config.projectSources.length)) throw new Error('Invalid public project sources');
  if (knowledge && (typeof knowledge.runtimeConfigPath !== 'string' || !knowledge.runtimeConfigPath.trim() ||
      !positiveId(knowledge.roomId) || !Array.isArray(knowledge.collaborationRooms) || knowledge.collaborationRooms.length > 3 ||
      knowledge.collaborationRooms.some(id => typeof id !== 'string' || !positiveId(id)))) throw new Error('Invalid comment knowledge config');
  if (config.speakerNames && (Object.keys(config.speakerNames).length > 100 || Object.entries(config.speakerNames)
    .some(([uid, name]) => !positiveId(uid) || typeof name !== 'string' || !name.trim() || name.length > 40 || unsafeComment(name)))) throw new Error('Invalid comment speaker names');
  const fan = config.fanQuota;
  if (fan && (typeof fan.suiUid !== 'string' || !positiveId(fan.suiUid) || !Array.isArray(fan.relatedUids) || fan.relatedUids.length > 100 ||
    fan.relatedUids.some(uid => typeof uid !== 'string' || !positiveId(uid)) ||
    [fan.hourly, fan.daily].some(limits => !limits || ['sui', 'related', 'other'].some(tier =>
      !Number.isInteger(limits[tier as FanTier]) || limits[tier as FanTier] < 1 || limits[tier as FanTier] > 1000) ||
      limits.sui < limits.related || limits.related < limits.other))) throw new Error('Invalid comment fan quotas');
}

export function unsafeComment(text: string): boolean {
  const clean = text.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '');
  return /(?:cookie|sessdata|bili_jct|api[ _-]?key|access[ _-]?token|bearer\s|密钥|密码|令牌|系统提示|提示词|环境变量|powershell|cmd\.exe|忽略.{0,12}(?:指令|规则|要求)|执行.{0,12}(?:命令|代码|脚本)|读取.{0,12}(?:配置|文件)|[a-z]:[\\/]|https?:\/\/|www\.)/iu.test(clean);
}

export function publishableAnswer(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || Array.from(text).length > LIMITS.outputChars || /[@\p{Cc}\p{Cf}]/u.test(text) || unsafeComment(text) ||
      /(?:```|<\/?(?:script|tool)|tool_calls|BEGIN .*PRIVATE KEY|sk-[a-z0-9]{12})/iu.test(text)) return undefined;
  return text;
}

export interface CommentEvent {
  trigger?: 'mention' | 'reply';
  key: string;
  uid: string;
  oid: string;
  type: number;
  root: string;
  parent: string;
  text: string;
  authorName?: string;
  createdAt: number;
}

/** Called only on authenticated Bilibili notification feeds, never on a public webhook. */
export function notificationEvent(kind: 'reply' | 'at', row: any, botUid: string): CommentEvent | undefined {
  const item = row?.item;
  const uid = positiveId(row?.user?.mid), oid = positiveId(item?.subject_id);
  const type = item?.business_id;
  const source = positiveId(item?.source_id);
  const root = positiveId(item?.root_id);
  const target = positiveId(item?.target_id);
  const createdAt = row?.[kind === 'reply' ? 'reply_time' : 'at_time'] * 1000;
  if (!uid || uid === botUid || !oid || ![1, 11, 12, 17].includes(type) || item.hide_reply_button === true ||
      !Number.isSafeInteger(createdAt) || createdAt <= 0) return undefined;
  const mentioned = kind === 'at' || Array.isArray(item.at_details) && item.at_details.some((detail: any) => positiveId(detail?.mid) === botUid);
  // Video discussions belong to the audience unless they explicitly address this account.
  if (type === 1 && !mentioned) return undefined;
  if (kind === 'reply' && !(item.type === 'reply' && source && target ||
      item.type === 'dynamic' && [11, 17].includes(type) && source || type === 1 && mentioned && source)) return undefined;
  if (kind === 'at' && !(item.type === 'reply' && source || item.type === 'dynamic' && [11, 17].includes(type))) return undefined;
  const text = item.source_content || (kind === 'at' && item.type === 'dynamic' ? item.title : '');
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) return undefined;
  const parent = source || '0';
  return { key: `${type}:${oid}:${parent === '0' ? `dynamic-${uid}` : parent}`, uid, oid, type, trigger: mentioned ? 'mention' : 'reply',
    root: root || (kind === 'at' ? target : undefined) || source || '0', parent,
    text: Array.from(text.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')).slice(0, LIMITS.inputChars).join('').trim(),
    ...(typeof row.user.nickname === 'string' ? { authorName: Array.from(row.user.nickname.replace(/[\p{Cc}\p{Cf}]/gu, ' ')).slice(0, 40).join('') } : {}), createdAt };
}
