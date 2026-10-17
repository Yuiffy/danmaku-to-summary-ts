import * as path from 'path';
import { EmbeddingConfig } from './EmbeddingClient';

export interface LiveQuestionConfig {
  enabled: boolean;
  providerConfigPath: string;
  /** Explicit room-specific directories, never paths supplied by chat or the model. */
  recordingRoots: Record<string, string[]>;
  roomAliases?: Record<string, string[]>;
  /** Read-only curated gift archives, keyed by their owner room. */
  giftCatalogs?: Record<string, string>;
  globalCooldownMs?: number;
  userCooldownMs?: number;
  noticeCooldownMs?: number;
  timeoutMs?: number;
  maxQuestionsPerHour?: number;
  semantic?: EmbeddingConfig;
}

export interface QuestionRequest {
  roomId: string;
  uid: string;
  question: string;
  askedAt?: number;
}

export interface QuestionSource {
  kind: 'subtitle' | 'danmaku' | 'gift-catalog';
  date: string | null;
  time: string;
  roomId?: string;
  roomName?: string;
  catalogMonth?: string;
}
export interface QuestionClue extends QuestionSource {
  excerpt: string;
}

export interface QuestionAnswer {
  basis?: 'general';
  answer: string;
  shortAnswer?: string;
  source?: QuestionSource;
  clues?: QuestionClue[];
}

export type QuestionAnswerer = (request: QuestionRequest, signal: AbortSignal) => Promise<QuestionAnswer>;
export type QuestionAnnounce = (roomId: string, message: string, isCurrent: () => boolean) => void;
export type QuestionAuthorize = (roomId: string, uid: string) => boolean;
export interface QuestionRecord { request: QuestionRequest; result: QuestionAnswer }
export type QuestionRecordWriter = (record: QuestionRecord, signal: AbortSignal, isCurrent: () => boolean) => Promise<void>;

export const QUESTION_LIMITS = {
  globalCooldownMs: 30000,
  userCooldownMs: 120000,
  noticeCooldownMs: 15000,
  timeoutMs: 90000,
  maxQuestionsPerHour: 20
} as const;

export const NO_EVIDENCE = '没在录像字幕和弹幕中找到可靠依据。';

export function validateQuestionConfig(config: LiveQuestionConfig): void {
  if (!config || typeof config.enabled !== 'boolean') throw new Error('questions.enabled must be boolean');
  if (!config.enabled) return;
  const semantic = config.semantic;
  if (semantic !== undefined && (typeof semantic.enabled !== 'boolean' || !path.isAbsolute(semantic.directory || '') ||
    !['local', 'daiyu'].includes(semantic.backend) || typeof semantic.model !== 'string' || !semantic.model.trim() ||
    !Number.isInteger(semantic.dimensions) || semantic.dimensions < 32 || semantic.dimensions > 4096 ||
    semantic.backend === 'local' && (semantic.dimensions !== 512 || !path.isAbsolute(semantic.modelDirectory || '')))) {
    throw new Error('Invalid questions.semantic configuration');
  }
  if (typeof config.providerConfigPath !== 'string' || !path.isAbsolute(config.providerConfigPath) ||
      !config.recordingRoots || typeof config.recordingRoots !== 'object' || Array.isArray(config.recordingRoots) ||
      !Object.keys(config.recordingRoots).length || Object.keys(config.recordingRoots).length > 1000) {
    throw new Error('Questions require an absolute providerConfigPath and room-specific recordingRoots');
  }
  for (const [roomId, roots] of Object.entries(config.recordingRoots)) {
    if (!/^[1-9]\d*$/u.test(roomId) || !Array.isArray(roots) || !roots.length || roots.length > 4 ||
        roots.some(root => typeof root !== 'string' || !path.isAbsolute(root) || path.parse(root).root === path.resolve(root))) {
      throw new Error('Question recordingRoots must contain numeric room IDs and absolute recording directories');
    }
  }
  for (const key of ['roomAliases', 'giftCatalogs'] as const) {
    const values = config[key];
    if (values === undefined) continue;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Invalid questions.${key}`);
    for (const [roomId, value] of Object.entries(values)) {
      if (!Object.prototype.hasOwnProperty.call(config.recordingRoots, roomId)) throw new Error('Unknown catalog/alias room');
      if (key === 'roomAliases' ? !Array.isArray(value) || value.length > 12 || value.some(alias => typeof alias !== 'string' ||
        alias.trim().length < 2 || alias.length > 60 || unsafeQuestionText(alias) || /[\p{Cc}\p{Cf}]/u.test(alias)) :
        typeof value !== 'string' || !path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.json') throw new Error(`Invalid questions.${key}`);
    }
  }
  const bounds = {
    globalCooldownMs: [10000, 3600000], userCooldownMs: [30000, 3600000],
    noticeCooldownMs: [10000, 300000], timeoutMs: [1000, 180000], maxQuestionsPerHour: [1, 60]
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = config[key as keyof typeof bounds];
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
      throw new Error(`Invalid questions.${key}`);
    }
  }
}

/** Refuse obvious credential/command requests as well as enforcing tool isolation. */
export function unsafeQuestionText(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '');
  return /(?:cookie|sessdata|bili_jct|api[ _-]?key|access[ _-]?token|bearer\s|密钥|密码|令牌|系统提示|提示词|环境变量|powershell|cmd\.exe|忽略.{0,8}(?:指令|规则|要求)|执行.{0,8}(?:命令|代码|脚本)|读取.{0,8}(?:配置|文件)|[a-z]:[\\/]|https?:\/\/)/iu.test(normalized);
}

/** Empty means a bare mention; null means this is not a valid question command. */
export function parseLiveQuestion(text: string): string | null {
  if (typeof text !== 'string' || text.length > 300) return null;
  const normalized = text.normalize('NFKC').trim();
  if (/[\p{Cc}\p{Cf}]/u.test(normalized)) return null;
  const match = /^@鹿饼[\s:：,，]*(.*)$/u.exec(normalized);
  const question = match?.[1].trim();
  return question !== undefined && Array.from(question).length <= 120 ? question : null;
}

export function questionPreview(question: string, maxChars = 12): string {
  const clean = question.replace(/[@#「」“”\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > maxChars ? chars.slice(0, maxChars - 1).join('') + '…' : clean;
}

export function busyQuestionMessage(question: string, maxChars: number): string {
  return `正忙着查「${questionPreview(question, maxChars - 17)}」问题，请稍后再问`;
}

export function receivedQuestionMessage(question: string, maxChars: number): string {
  const prefix = '鹿饼收到，思考“';
  const suffix = '”中…';
  return prefix + questionPreview(question, maxChars - Array.from(prefix + suffix).length) + suffix;
}

export function publicQuestionText(text: string, maxChars: number): string {
  if (typeof text !== 'string' || unsafeQuestionText(text)) return '';
  return Array.from(text.normalize('NFKC').replace(/[@#<>\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim())
    .slice(0, maxChars).join('');
}

/** Only a bounded, plain-text answer leaves the agent; no tool or API errors are public. */
export function formatQuestionAnswer(result: QuestionAnswer, maxChars: number): string {
  const answer = publicQuestionText(result?.shortAnswer || result?.answer, 300) || NO_EVIDENCE;
  const chars = Array.from('鹿饼答：' + answer);
  return chars.length > maxChars ? chars.slice(0, maxChars - 1).join('') + '…' : chars.join('');
}

export function formatQuestionRecord(record: QuestionRecord): string {
  const lines = [
    `直播问答（房间${record.request.roomId}）`,
    `问题：${publicQuestionText(record.request.question, 120) || '问题内容已省略'}`,
    `回复：${publicQuestionText(record.result.answer, 300) || NO_EVIDENCE}`,
    record.result.basis === 'general' ? '一般回答，不涉及直播事实。' : '线索：'
  ];
  const clues = record.result.clues || (record.result.source ? [{ ...record.result.source, excerpt: '' }] : []);
  for (const [index, clue] of clues.slice(0, 3).entries()) {
    const text = publicQuestionText(clue.excerpt, 300);
    const room = clue.roomId ? `${publicQuestionText(clue.roomName || clue.roomId, 60)}（${clue.roomId}） ` : '';
    const kind = clue.kind === 'gift-catalog' ? `舰礼档案（所属月${clue.catalogMonth || '不详'}）` : clue.kind === 'subtitle' ? '录像字幕' : '观众弹幕';
    lines.push(`${index + 1}. ${room}${clue.date || '日期不详'} ${clue.time} ${kind}${text ? `：${text}` : ''}`);
  }
  if (!clues.length && record.result.basis !== 'general') lines.push('在已检索的直播记录中没有找到可靠依据。');
  return lines.join('\n');
}
