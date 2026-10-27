import { createHash } from 'crypto';
import { CommentReplyConfig, LIMITS, unsafeComment } from '../bilibili/comment-replies/CommentPolicy';
import { QQImageConfig, qqImageRequested, validateQQImageConfig } from './QQImagePolicy';

export const QQ_MODEL = 'gpt-6-luna';
export const QQ_PRIVATE_REPLY = '鹿饼现在只在群聊里回答问题，请把我邀请进群，再艾特我来聊天吧～';
export const QQ_IMAGE_REPLY = '生图功能还在准备中，现在可以先在群里艾特我聊天、提问哦～';
export const QQ_FAILURE_REPLY = '鹿饼这次没能顺利回答，请稍后再来问我吧。';
export const QQ_QUOTA_REPLY = '鹿饼今天有点困困了，歇一会儿再来叫我吧～';
export const QQ_LIMITS = { maxAgeMs: 240000, retentionMs: 86400000, maxReceipts: 10000,
  startsPerMinute: 5, hourlyUserReplies: 6, dailyUserReplies: 20, sendIntervalMs: 5000,
  timeoutMs: 90000, privateIntervalMs: 600000, reservation: 65536, agentTurns: 5 } as const;

export interface QQConfig {
  secretConfigPath?: string;
  credentialsPath?: string;
  providerConfigPath?: string;
  dailyTokenBudget: number;
  maxQueue: number;
  maxUserQueue: number;
  privateReply: string;
  knowledge?: CommentReplyConfig['knowledge'];
  images?: QQImageConfig;
}
export interface QQInbound {
  kind: string; rawEventType: string; senderId: string; senderIsBot?: boolean;
  content: string; messageId: string; timestamp: string; groupOpenid?: string;
  mentions?: Array<{ is_you?: boolean }>;
}
export interface QQRequest {
  key: string; user: string; scope: 'group' | 'c2c'; targetId: string; msgId: string;
  text: string; createdAt: number;
}
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[\w.-]{1,256}$/u.test(value);
export const qqDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function validateQQConfig(config: QQConfig): void {
  const nonempty = (value: unknown) => typeof value === 'string' && !!value.trim();
  if (!config || (config.secretConfigPath !== undefined ? !nonempty(config.secretConfigPath) :
    ![config.credentialsPath, config.providerConfigPath].every(nonempty)) ||
    !Number.isSafeInteger(config.dailyTokenBudget) || config.dailyTokenBudget < QQ_LIMITS.reservation ||
    !Number.isInteger(config.maxQueue) || config.maxQueue < 1 || config.maxQueue > 100 ||
    !Number.isInteger(config.maxUserQueue) || config.maxUserQueue < 1 || config.maxUserQueue > config.maxQueue ||
    typeof config.privateReply !== 'string' || !config.privateReply.trim() || Array.from(config.privateReply).length > 300 ||
    /[\p{Cc}\p{Cf}]/u.test(config.privateReply) || unsafeComment(config.privateReply)) throw new Error('Invalid QQ bot configuration');
  const k = config.knowledge;
  if (k && (typeof k.runtimeConfigPath !== 'string' || !k.runtimeConfigPath.trim() || !/^[1-9]\d{0,24}$/u.test(k.roomId) ||
    !Array.isArray(k.collaborationRooms) || k.collaborationRooms.length > 3 || k.collaborationRooms.some(id =>
      typeof id !== 'string' || !/^[1-9]\d{0,24}$/u.test(id)))) throw new Error('Invalid QQ knowledge configuration');
  if (config.images) validateQQImageConfig(config.images);
}

/** Only call on authenticated SDK events. Nickname/plain-text @ strings grant no authority. */
export function qqRequest(message: QQInbound, now: number, botId?: string): QQRequest | undefined {
  if (!message || !opaque(message.senderId) || !opaque(message.messageId) || message.senderIsBot || message.senderId === botId) return;
  const scope = message.kind;
  if (scope !== 'group' && scope !== 'c2c') return;
  if (scope === 'c2c' && message.rawEventType !== 'C2C_MESSAGE_CREATE') return;
  if (scope === 'group' && (message.rawEventType !== 'GROUP_AT_MESSAGE_CREATE' &&
    !(message.rawEventType === 'GROUP_MESSAGE_CREATE' && Array.isArray(message.mentions) && message.mentions.some(item => item?.is_you === true)))) return;
  const targetId = scope === 'group' ? message.groupOpenid : message.senderId;
  const createdAt = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
  if (!opaque(targetId) || !Number.isFinite(createdAt) || createdAt > now + 60000 || now - createdAt >= QQ_LIMITS.maxAgeMs) return;
  if (typeof message.content !== 'string' || message.content.length > 20000) return;
  const text = message.content.normalize('NFKC').replace(/<@!?[\w.-]+>/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (Array.from(text).length > LIMITS.inputChars) return;
  return { key: qqDigest(JSON.stringify([scope, targetId, message.messageId])),
    user: qqDigest(JSON.stringify([scope, message.senderId])), scope, targetId, msgId: message.messageId, text, createdAt };
}

export function qqFixedReply(request: QQRequest, config: QQConfig): string | undefined {
  if (request.scope === 'c2c') return config.privateReply;
  if (!request.text) return '我在～在艾特后面写上想聊的话，或者带上主播、原话和日期来提问吧。';
  if (qqImageRequested(request.text) && !config.images?.enabled) return QQ_IMAGE_REPLY;
  return undefined;
}
