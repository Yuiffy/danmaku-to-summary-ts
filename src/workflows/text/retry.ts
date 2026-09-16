export interface RetryPolicy {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    statusCodes?: number[];
    retryConnectionErrors?: boolean;
}
export interface ResolvedRetryPolicy extends Required<RetryPolicy> {}
export function resolveRetryPolicy(...layers: Array<RetryPolicy | undefined>): ResolvedRetryPolicy {
    const value = Object.assign({ maxAttempts: 1, baseDelayMs: 1000, maxDelayMs: 10000, jitterRatio: .2,
        statusCodes: [408, 409, 425, 429, 500, 502, 503, 504], retryConnectionErrors: true },
    ...layers.filter(Boolean));
    for (const key of ['maxAttempts', 'baseDelayMs', 'maxDelayMs'] as const) {
        if (!Number.isSafeInteger(value[key]) || value[key] < (key === 'maxAttempts' ? 1 : 0)) throw new Error(`Invalid retry ${key}`);
    }
    if (value.maxAttempts > 5 || value.maxDelayMs > 60000 || value.baseDelayMs > value.maxDelayMs
        || !Number.isFinite(value.jitterRatio) || value.jitterRatio < 0 || value.jitterRatio > 1
        || !Array.isArray(value.statusCodes) || value.statusCodes.some((code: number) => !Number.isInteger(code) || code < 400 || code > 599)
        || typeof value.retryConnectionErrors !== 'boolean') throw new Error('Invalid retry policy');
    return value;
}
export function retryReason(error: any, policy: ResolvedRetryPolicy): string | null {
    if (error?.outcomeUnknown || error?.name === 'AbortError' || error?.name === 'TimeoutError'
        || /deadline exceeded|aborted|request.timeout/iu.test(String(error?.message || ''))) return null;
    const status = Number(error?.status ?? error?.statusCode ?? error?.httpStatus);
    if (policy.statusCodes.includes(status)) return `http_${status}`;
    // Only failures known to precede an HTTP submission. Generic ECONNRESET/ETIMEDOUT may follow a paid generation.
    if (!policy.retryConnectionErrors || error?.response) return null;
    const code = error?.code || error?.cause?.code;
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return `connect_${code}`;
    if (code === 'ECONNRESET' && /before secure TLS connection was established/iu.test(String(error?.message))) return 'connect_tls';
    return null;
}
export function retryDelay(policy: ResolvedRetryPolicy, attempt: number, retryAfter: string | null = null,
    now = Date.now(), random = Math.random()): number {
    const seconds = retryAfter && /^\d+(?:\.\d+)?$/u.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : NaN;
    const date = retryAfter ? Date.parse(retryAfter) - now : NaN;
    const serverDelay = Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? Math.max(0, date) : 0;
    const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
    return Math.ceil(Math.max(serverDelay, Math.min(policy.maxDelayMs,
        exponential * (1 + policy.jitterRatio * (2 * random - 1)))));
}
