/** Bounded local diagnostics shared by the archive and read-only operator UI. */
export const QQ_AGENT_LIMITS = { modelCalls: 9, tools: 8 } as const;
export const QQ_FAILURE_STAGES = ['model_prepare', 'model_budget', 'model_http', 'model_decode', 'model_output',
  'agent_run', 'answer_validation', 'tool', 'cleanup', 'trace_record', 'image_prepare', 'image_http', 'image_decode', 'image_store', 'send', 'state'] as const;
export const QQ_FAILURE_CODES = {
  unexpected: '未分类异常', aborted: '请求已取消', timeout: '请求超时', network: '网络请求失败',
  http_error: '接口返回失败状态', invalid_json: '响应不是有效 JSON', invalid_output: '响应结构不合法',
  truncated: '模型输出被截断', invalid_tool: '工具调用不合法', empty_output: '模型未返回内容',
  budget_exceeded: '累计请求预算不足', turn_limit: '超过模型轮数上限', invalid_evidence: '引用了无效证据',
  unsafe_answer: '回答未通过公开发送检查', secret_output: '回答包含凭据', invalid_schema: '最终回答格式不合法',
  duplicate_tool: '重复工具操作', tool_limit: '超过工具次数上限', tool_failed: '资料工具执行失败',
  cleanup_failed: '资料会话清理失败', record_failed: '诊断记录保存失败', invalid_tokens: '用量结算不合法',
  image_unavailable: '图片适配器不可用', image_bytes: '图片内容缺失或不合法', image_size: '图片超过大小上限',
  send_failed: 'QQ 发送结果不确定', state_failed: '持久化检查点失败'
} as const;
export interface QQDiagnostic {
  stage: typeof QQ_FAILURE_STAGES[number]; code: keyof typeof QQ_FAILURE_CODES; at: number;
  elapsedMs?: number; turn?: number; httpStatus?: number; requestId?: string; outputChars?: number;
  requestBytes?: number; budgetBefore?: number; charge?: number; budgetLimit?: number;
  finishReason?: string; errorName?: string; systemCode?: string; fingerprint?: string;
  validation?: 'not_string' | 'empty' | 'too_long' | 'control_or_mention' | 'unsafe_content';
  frames?: string[];
}
export interface QQModelCall {
  turn: number; at: number; elapsedMs: number; status: 'running' | 'ok' | 'failed' | 'blocked';
  requestBytes: number; budgetBefore: number; charge: number; budgetLimit: number;
  httpStatus?: number; requestId?: string; finishReason?: string; failure?: QQDiagnostic;
}
const numbers = ['elapsedMs', 'turn', 'httpStatus', 'requestBytes', 'budgetBefore', 'charge', 'budgetLimit', 'outputChars'] as const;
const strings = ['requestId', 'finishReason', 'errorName', 'systemCode', 'fingerprint'] as const;
const safeNumber = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= Number.MAX_SAFE_INTEGER;
const safeTag = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/u.test(value);
export function validQQDiagnostic(value: QQDiagnostic): boolean {
  return !!value && QQ_FAILURE_STAGES.includes(value.stage) && Object.hasOwn(QQ_FAILURE_CODES, value.code) && safeNumber(value.at) &&
    numbers.every(key => value[key] === undefined || safeNumber(value[key])) && strings.every(key => value[key] === undefined || safeTag(value[key])) &&
    (value.validation === undefined || ['not_string', 'empty', 'too_long', 'control_or_mention', 'unsafe_content'].includes(value.validation)) &&
    (value.frames === undefined || Array.isArray(value.frames) && value.frames.length <= 6 &&
      value.frames.every(frame => typeof frame === 'string' && /^[\w.-]{1,80}\.[cm]?[jt]s:\d{1,7}:\d{1,6}$/u.test(frame)));
}
/** Explicit projections also strip unknown nested fields from on-disk records. */
export function projectQQDiagnostic(value: QQDiagnostic): QQDiagnostic {
  const result: QQDiagnostic = { stage: value.stage, code: value.code, at: value.at };
  for (const key of numbers) if (value[key] !== undefined) result[key] = value[key];
  for (const key of strings) if (value[key] !== undefined) result[key] = value[key];
  if (value.validation !== undefined) result.validation = value.validation;
  if (value.frames !== undefined) result.frames = [...value.frames];
  return result;
}
export function validQQModelCall(value: QQModelCall): boolean {
  return !!value && ['running', 'ok', 'failed', 'blocked'].includes(value.status) && value.turn >= 1 && value.turn <= QQ_AGENT_LIMITS.modelCalls + 1 &&
    ['turn', 'at', 'elapsedMs', 'requestBytes', 'budgetBefore', 'charge', 'budgetLimit'].every(key => safeNumber(value[key as keyof QQModelCall])) &&
    (value.httpStatus === undefined || safeNumber(value.httpStatus)) &&
    [value.requestId, value.finishReason].every(item => item === undefined || safeTag(item)) &&
    (value.failure === undefined || validQQDiagnostic(value.failure));
}
export function projectQQModelCall(value: QQModelCall): QQModelCall {
  const { turn, at, elapsedMs, status, requestBytes, budgetBefore, charge, budgetLimit, httpStatus, requestId, finishReason, failure } = value;
  return { turn, at, elapsedMs, status, requestBytes, budgetBefore, charge, budgetLimit,
    ...(httpStatus !== undefined ? { httpStatus } : {}), ...(requestId ? { requestId } : {}), ...(finishReason ? { finishReason } : {}),
    ...(failure ? { failure: projectQQDiagnostic(failure) } : {}) };
}
