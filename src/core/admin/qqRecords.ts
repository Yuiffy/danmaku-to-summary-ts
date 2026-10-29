import { QQ_AGENT_LIMITS, QQDiagnostic, QQModelCall, validQQDiagnostic, validQQModelCall } from './qqDiagnostics';
export const QQ_RECORD_STATUSES = {
  accepted: '已接收', generating: '生成中', sending: '发送中／待核对', sent: '已回复', unknown: '发送结果待核对', skipped: '已跳过'
} as const;
export interface QQAgentTrace {
  modelCalls: number; inputTokens: number; outputTokens: number;
  tools: Array<{ name: string; status: 'ok' | 'failed'; elapsedMs: number; failure?: QQDiagnostic }>;
  calls?: QQModelCall[];
  failures?: QQDiagnostic[];
}
export interface QQRecord {
  version: 1; id: string; appId: string; scope: 'group' | 'c2c'; user: string; conversation: string;
  senderName?: string;
  question: string; answer: string; status: keyof typeof QQ_RECORD_STATUSES;
  requestedAt: number; updatedAt: number; model: string; error?: 'model_failed' | 'image_failed';
  image?: { sha256: string; prompt: string };
  agent?: QQAgentTrace;
  failure?: QQDiagnostic;
  sendFailure?: QQDiagnostic;
  queuedMs?: number;
}
export interface AdminQQRecordsView {
  date: string; dates: string[]; total: number; page: number; pages: number; rows: QQRecord[];
  asOf: number; summary: QQRecordStats; users: QQUserSummary[]; conversations: QQConversationSummary[];
  accounts: QQAccountUsage[];
}
export interface QQRecordStats {
  records: number; replied: number; failed: number; active: number; skipped: number;
  quotaNotices: number; images: number; users: number; conversations: number;
}
export interface QQQuotaStatus {
  status: 'available' | 'limited' | 'paused' | 'unavailable';
  used?: number; limit?: number; remaining?: number; windowMs?: number;
  window?: { used: number; limit: number; remaining: number; windowMs: number };
  reasons: Array<{ code: string; label: string; until?: number }>;
}
export interface QQUserSummary {
  key: string; appId: string; user: string; scope: QQRecord['scope']; senderName?: string;
  lastAt: number; stats: QQRecordStats; text: QQQuotaStatus; image?: QQQuotaStatus;
}
export interface QQConversationSummary {
  key: string; appId: string; conversation: string; scope: QQRecord['scope']; records: number; users: number;
}
export interface QQAccountUsage {
  appId: string; status: 'ok' | 'paused' | 'unavailable'; day?: string;
  tokensUsed?: number; tokenBudget?: number; starts?: number; startsLimit?: number;
}
export function validQQRecord(value: QQRecord): boolean {
  return !!value && value.version === 1 && /^[1-9]\d{0,24}$/u.test(value.appId) &&
    [value.id, value.user, value.conversation].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item)) &&
    (value.senderName === undefined || typeof value.senderName === 'string' && value.senderName.trim() === value.senderName &&
      Array.from(value.senderName).length >= 1 && Array.from(value.senderName).length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(value.senderName)) &&
    ['group', 'c2c'].includes(value.scope) && Object.hasOwn(QQ_RECORD_STATUSES, value.status) &&
    typeof value.question === 'string' && Array.from(value.question).length <= 600 &&
    typeof value.answer === 'string' && Array.from(value.answer).length <= 600 &&
    [value.requestedAt, value.updatedAt].every(at => Number.isSafeInteger(at) && at >= 0) &&
    value.updatedAt >= value.requestedAt && (['', 'gpt-6-luna'].includes(value.model) || /^gpt-image-[\w.-]{1,60}$/u.test(value.model)) &&
    (value.error === undefined || ['model_failed', 'image_failed'].includes(value.error)) &&
    (value.image === undefined || !!value.image && /^[a-f0-9]{64}$/u.test(value.image.sha256) &&
      typeof value.image.prompt === 'string' && value.image.prompt.length <= 16000) &&
    (value.failure === undefined || validQQDiagnostic(value.failure)) &&
    (value.sendFailure === undefined || validQQDiagnostic(value.sendFailure)) &&
    (value.queuedMs === undefined || Number.isSafeInteger(value.queuedMs) && value.queuedMs >= 0) &&
    (value.agent === undefined || validQQAgentTrace(value.agent));
}
function validQQAgentTrace(value: QQAgentTrace): boolean {
  return !!value && Number.isSafeInteger(value.modelCalls) && value.modelCalls >= 0 && value.modelCalls <= QQ_AGENT_LIMITS.modelCalls &&
    [value.inputTokens, value.outputTokens].every(tokens => Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= 10000000) &&
    Array.isArray(value.tools) && value.tools.length <= QQ_AGENT_LIMITS.tools && value.tools.every(step => !!step &&
      typeof step.name === 'string' && /^[a-z_]{1,40}$/u.test(step.name) && ['ok', 'failed'].includes(step.status) &&
      Number.isSafeInteger(step.elapsedMs) && step.elapsedMs >= 0 && (step.failure === undefined || validQQDiagnostic(step.failure))) &&
    (value.calls === undefined || Array.isArray(value.calls) && value.calls.length <= QQ_AGENT_LIMITS.modelCalls + 1 && value.calls.every(validQQModelCall)) &&
    (value.failures === undefined || Array.isArray(value.failures) && value.failures.length <= 8 && value.failures.every(validQQDiagnostic));
}
