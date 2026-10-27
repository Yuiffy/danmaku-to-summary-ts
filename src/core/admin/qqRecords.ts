export const QQ_RECORD_STATUSES = {
  accepted: '已接收', generating: '生成中', sending: '发送中／待核对', sent: '已回复', unknown: '发送结果待核对', skipped: '已跳过'
} as const;
export interface QQAgentTrace {
  modelCalls: number; inputTokens: number; outputTokens: number;
  tools: Array<{ name: string; status: 'ok' | 'failed'; elapsedMs: number }>;
}
export interface QQRecord {
  version: 1; id: string; appId: string; scope: 'group' | 'c2c'; user: string; conversation: string;
  senderName?: string;
  question: string; answer: string; status: keyof typeof QQ_RECORD_STATUSES;
  requestedAt: number; updatedAt: number; model: string; error?: 'model_failed' | 'image_failed';
  image?: { sha256: string; prompt: string };
  agent?: QQAgentTrace;
}
export interface AdminQQRecordsView {
  date: string; dates: string[]; total: number; page: number; pages: number; rows: QQRecord[];
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
    (value.agent === undefined || validQQAgentTrace(value.agent));
}
function validQQAgentTrace(value: QQAgentTrace): boolean {
  return !!value && Number.isSafeInteger(value.modelCalls) && value.modelCalls >= 0 && value.modelCalls <= 5 &&
    [value.inputTokens, value.outputTokens].every(tokens => Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= 10000000) &&
    Array.isArray(value.tools) && value.tools.length <= 4 && value.tools.every(step => !!step &&
      typeof step.name === 'string' && /^[a-z_]{1,40}$/u.test(step.name) && ['ok', 'failed'].includes(step.status) &&
      Number.isSafeInteger(step.elapsedMs) && step.elapsedMs >= 0);
}
