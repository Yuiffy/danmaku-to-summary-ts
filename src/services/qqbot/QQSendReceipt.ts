import { qqImageReferenceId } from './QQImageInputPolicy';

export interface QQSendReceiptDiagnostic {
  version: 1; step: 'upload' | 'message'; outcome: 'returned' | 'invalid_receipt' | 'failed';
  kind?: 'object' | 'missing' | 'other'; hasId?: boolean; hasTimestamp?: boolean;
  hasReference?: boolean; hasNestedId?: boolean; hasAudit?: boolean;
  httpStatus?: number; platformCode?: number; errorName?: 'ApiError' | 'TypeError' | 'Error' | 'AbortError';
}

const numericCode = (value: unknown): value is number => Number.isSafeInteger(value) && Math.abs(value as number) <= 2147483647;

/** A parsed HTTP 400 business rejection is distinct from an uncertain transport/receipt failure. */
export class QQSendRejectedError extends Error {
  readonly httpStatus = 400;
  constructor(readonly platformCode: number) { super('QQ message rejected'); this.name = 'QQSendRejectedError'; }
}

export function qqSendRejection(error: unknown): QQSendRejectedError | undefined {
  const diagnostic = qqSendFailureDiagnostic(error, 'message');
  if (diagnostic.errorName === 'ApiError' && diagnostic.httpStatus === 400 &&
    numericCode(diagnostic.platformCode) && diagnostic.platformCode > 0) return new QQSendRejectedError(diagnostic.platformCode);
  return undefined;
}

/** Project only fixed structural flags and a numeric platform code; never expose response values. */
export function qqSendReceiptDiagnostic(value: unknown): QQSendReceiptDiagnostic {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
  const platformCode = object?.code ?? object?.err_code;
  return { version: 1, step: 'message', outcome: qqImageReferenceId(object?.id) ? 'returned' : 'invalid_receipt',
    kind: object ? 'object' : value == null ? 'missing' : 'other',
    hasId: qqImageReferenceId(object?.id), hasTimestamp: typeof object?.timestamp === 'number' || typeof object?.timestamp === 'string',
    hasReference: qqImageReferenceId(object?.ext_info?.ref_idx),
    hasNestedId: qqImageReferenceId(object?.data?.id) || qqImageReferenceId(object?.result?.id),
    hasAudit: !!(object?.audit || object?.message_audit || object?.data?.message_audit),
    ...(numericCode(platformCode) ? { platformCode } : {}) };
}

/** SDK ApiError exposes structured status/code; discard its path, message and arbitrary properties. */
export function qqSendFailureDiagnostic(error: unknown, step: 'upload' | 'message'): QQSendReceiptDiagnostic {
  const candidate = error as { name?: unknown; httpStatus?: unknown; bizCode?: unknown } | undefined;
  const errorName = ['ApiError', 'TypeError', 'Error', 'AbortError'].includes(candidate?.name as string)
    ? candidate!.name as NonNullable<QQSendReceiptDiagnostic['errorName']> : 'Error';
  return { version: 1, step, outcome: 'failed', errorName,
    ...(numericCode(candidate?.httpStatus) && (candidate!.httpStatus as number) >= 0 ? { httpStatus: candidate!.httpStatus as number } : {}),
    ...(numericCode(candidate?.bizCode) ? { platformCode: candidate!.bizCode } : {}) };
}
