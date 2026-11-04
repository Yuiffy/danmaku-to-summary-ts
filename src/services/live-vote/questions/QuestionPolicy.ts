import * as path from 'path';
import { EmbeddingConfig } from './EmbeddingClient';
import { DanmakuAttribution } from './DanmakuEvidence';
import { RecordingFtsConfig } from './RecordingFtsIndex';
import { StockQuote } from './StockSearch';

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
  /** Trusted numeric UIDs exempt from query frequency limits, still subject to authorization. */
  unlimitedUids?: string[];
  semantic?: EmbeddingConfig;
  lexical?: RecordingFtsConfig;
}

export interface QuestionRequest {
  roomId: string;
  uid: string;
  question: string;
  askedAt?: number;
}

export interface QuestionSource extends DanmakuAttribution {
  kind: 'subtitle' | 'danmaku' | 'gift-catalog' | 'highlight' | 'clip-subtitle' | 'public-search' | 'live-overview';
  date: string | null;
  time: string;
  roomId?: string;
  roomName?: string;
  catalogMonth?: string;
  provider?: string;
  title?: string;
  retrievedAt?: string;
}
export interface QuestionClue extends QuestionSource {
  excerpt: string;
}

export interface QuestionAnswer {
  basis?: 'general' | 'public';
  answer: string;
  shortAnswer?: string;
  source?: QuestionSource;
  clues?: QuestionClue[];
  /** Structured public quotes let the danmaku channel retain concrete values. */
  publicQuotes?: StockQuote[];
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
export const NO_PUBLIC_EVIDENCE = '本次公开资料查询未找到足够依据，可换个关键词或补充具体对象。';

export function validateQuestionConfig(config: LiveQuestionConfig): void {
  if (!config || typeof config.enabled !== 'boolean') throw new Error('questions.enabled must be boolean');
  if (!config.enabled) return;
  if (config.unlimitedUids !== undefined && (!Array.isArray(config.unlimitedUids) || config.unlimitedUids.length > 1000 ||
      config.unlimitedUids.some(uid => typeof uid !== 'string' || !/^[1-9]\d*$/u.test(uid)))) {
    throw new Error('questions.unlimitedUids must contain numeric UID strings');
  }
  const semantic = config.semantic;
  const lexical = config.lexical;
  if (lexical !== undefined && (typeof lexical.enabled !== 'boolean' || !path.isAbsolute(lexical.directory || '') ||
      path.parse(lexical.directory).root === path.resolve(lexical.directory) || lexical.pollIntervalMs !== undefined &&
      (!Number.isInteger(lexical.pollIntervalMs) || lexical.pollIntervalMs < 30000 || lexical.pollIntervalMs > 3600000))) {
    throw new Error('Invalid questions.lexical configuration');
  }
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

function quoteTicker(quote: StockQuote): string {
  if (quote.symbol === 'usINX') return '标普';
  return quote.symbol.replace(/^(?:us|hk|sh|sz|bj)/u, '') || quote.name;
}

function quoteNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function quotePercent(value: number | null, decimals = 1): string {
  if (value == null) return '?%';
  const rounded = Number(value.toFixed(decimals));
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/** Format structured public quotes as bounded, concrete danmaku rows. */
export function formatQuestionAnswerParts(result: QuestionAnswer, maxChars: number): string[] {
  const quotes = result?.publicQuotes?.slice(0, 5) || [];
  if (!quotes.length) return [formatQuestionAnswer(result, maxChars)];
  const prefix = '鹿饼答：';
  const labels = quotes.map(quoteTicker);
  const detailed = (decimals: number) => quotes.map((quote, index) => `${labels[index]}${quotePercent(quote.changePercent, decimals)}`).join(' ');
  const candidates = [`参考 ${detailed(1)}`, `参考 ${detailed(0)}`, detailed(1), detailed(0),
    quotes.map((quote, index) => `${labels[index].slice(0, 1)}${quotePercent(quote.changePercent)}`).join('')];
  const selected = candidates.find(candidate => Array.from(prefix + candidate).length <= maxChars);
  return [Array.from(prefix + (selected || candidates.at(-1)!)).slice(0, maxChars).join('')];
}

export function formatQuestionRecord(record: QuestionRecord): string {
  const lines = [
    `直播问答（房间${record.request.roomId}）`,
    `问题：${publicQuestionText(record.request.question, 120) || '问题内容已省略'}`,
    `回复：${publicQuestionText(record.result.answer, 300) || NO_EVIDENCE}`,
    record.result.basis === 'general' ? '一般回答，不涉及直播事实。' : '线索：'
  ];
  const clues = record.result.clues || (record.result.source ? [{ ...record.result.source, excerpt: '' }] : []);
  for (const [index, clue] of clues.slice(0, 5).entries()) {
    const text = publicQuestionText(clue.excerpt, 300);
    if (clue.kind === 'public-search') {
      lines.push(`${index + 1}. 公开资料 ${publicQuestionText(clue.provider || '', 60)} ${publicQuestionText(clue.title || '', 100)}（查询时间${clue.date || '不详'} ${clue.time}，北京时间；非数据发生时间）${text ? `：${text}` : ''}`);
      continue;
    }
    const room = clue.roomId ? `${publicQuestionText(clue.roomName || clue.roomId, 60)}（${clue.roomId}） ` : '';
    const kind = clue.kind === 'live-overview' ? '直播概述（生成资料，非原话）' : clue.kind === 'gift-catalog' ? `舰礼档案（所属月${clue.catalogMonth || '不详'}）` : clue.kind === 'subtitle' ? '录像字幕' : clue.kind === 'highlight' ? '精选摘要（粗略线索）' : clue.kind === 'clip-subtitle' ? '切片字幕（切片内时间）' : clue.messageType === 'superchat' ? '观众SC' : '观众弹幕';
    const sender = publicQuestionText(clue.senderName || '', 80);
    const uid = clue.senderUid && /^[1-9]\d*$/u.test(clue.senderUid) ? clue.senderUid : '';
    const sentAt = clue.sentAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/u.test(clue.sentAt) ? clue.sentAt.slice(0, 19).replace('T', ' ') : '';
    const details = [sender && `发送者${sender}`, uid && `UID ${uid}`, sentAt && `${clue.sentAtBasis === 'recording_start' ? '按录制起点推算' : '发送时间'}${sentAt}（北京时间）`].filter(Boolean).join('；');
    lines.push(`${index + 1}. ${room}${clue.date || '日期不详'} ${clue.time} ${kind}${details ? `（${details}）` : ''}${text ? `：${text}` : ''}`);
  }
  if (!clues.length && record.result.basis !== 'general') lines.push(record.result.basis === 'public' ? '本次公开查询没有可引用结果。' : '在已检索的直播记录中没有找到可靠依据。');
  return lines.join('\n');
}
