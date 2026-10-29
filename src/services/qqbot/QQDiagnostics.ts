import { createHash } from 'crypto';
import { QQDiagnostic, projectQQDiagnostic } from '../../core/admin/qqDiagnostics';

export class QQDiagnosticError extends Error {
  constructor(readonly diagnostic: QQDiagnostic) {
    super('QQ generation failed'); this.name = 'QQDiagnosticError';
    if (!diagnostic.frames) diagnostic.frames = safeFrames(this.stack);
  }
}
function safeFrames(stack: unknown): string[] {
  if (typeof stack !== 'string') return [];
  return stack.split('\n').slice(1).filter(line => /[\\/]services[\\/](?:qqbot|live-vote[\\/]questions)[\\/]|[\\/]tools[\\/]qqbot[\\/]|[\\/]@openai[\\/]agents-core[\\/]/u.test(line))
    .flatMap(line => {
      const match = line.match(/[\\/]([\w.-]{1,80}\.[cm]?[jt]s:\d{1,7}:\d{1,6})\)?$/u);
      return match ? [match[1]] : [];
    }).slice(0, 6);
}
export function qqFailure(stage: QQDiagnostic['stage'], code: QQDiagnostic['code'], detail: Partial<QQDiagnostic> = {}): QQDiagnosticError {
  return new QQDiagnosticError(projectQQDiagnostic({ ...detail, stage, code, at: detail.at ?? Date.now() }));
}
/** Never copy arbitrary exception messages, provider bodies, headers, paths or QQ IDs into logs. */
export function qqDiagnostic(error: unknown, stage: QQDiagnostic['stage'], code: QQDiagnostic['code'] = 'unexpected',
  signal?: AbortSignal, detail: Partial<QQDiagnostic> = {}): QQDiagnostic {
  if (error instanceof QQDiagnosticError) return projectQQDiagnostic({ ...detail, ...error.diagnostic });
  const candidate = error as { name?: unknown; code?: unknown; type?: unknown; message?: unknown } | undefined;
  const errorName = typeof candidate?.name === 'string' && ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AbortError',
    'FetchError', 'ModelBehaviorError', 'MaxTurnsExceededError', 'UserError'].includes(candidate.name) ? candidate.name : 'Error';
  const systemCode = typeof candidate?.code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'EPIPE', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO'].includes(candidate.code) ? candidate.code : undefined;
  if (signal?.aborted) code = signal.reason instanceof QQDiagnosticError ? signal.reason.diagnostic.code : 'aborted';
  else if (candidate?.type === 'request-timeout' || systemCode === 'ETIMEDOUT') code = 'timeout';
  else if (errorName === 'AbortError') code = 'aborted';
  else if (stage.endsWith('_http') && (errorName === 'FetchError' || systemCode)) code = 'network';
  else if (stage === 'agent_run' && (errorName === 'SyntaxError' || errorName === 'ModelBehaviorError')) code = 'invalid_schema';
  const fingerprint = createHash('sha256').update(String(candidate?.message ?? error ?? 'unknown')).digest('hex');
  return projectQQDiagnostic({ ...detail, stage, code, at: Date.now(), errorName, ...(systemCode ? { systemCode } : {}), fingerprint,
    frames: safeFrames((error as { stack?: unknown } | undefined)?.stack) });
}
export function qqRequestId(response: { headers?: { get(name: string): string | null } }, secret: string): string | undefined {
  for (const name of ['x-request-id', 'request-id', 'x-trace-id']) {
    const value = response.headers?.get(name);
    if (value && /^[a-zA-Z0-9_.:-]{1,100}$/u.test(value) && !value.includes(secret)) return value;
  }
  return undefined;
}
