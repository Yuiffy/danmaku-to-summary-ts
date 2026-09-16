import { resolveRetryPolicy, retryReason, retryDelay } from './retry';
test('merges explicit overrides and enforces bounded retry settings', () => {
    expect(resolveRetryPolicy({ maxAttempts: 2 }, { maxAttempts: 1, jitterRatio: 0 }).maxAttempts).toBe(1);
    expect(() => resolveRetryPolicy({ maxAttempts: 10 })).toThrow();
    expect(() => resolveRetryPolicy({ jitterRatio: NaN })).toThrow();
});
test('classifies explicit failures without retrying unknown generations or content errors', () => {
    const p = resolveRetryPolicy({ maxAttempts: 2 });
    expect(retryReason({ status: 502 }, p)).toBe('http_502');
    expect(retryReason({ code: 'ECONNRESET', message: 'Client network socket disconnected before secure TLS connection was established' }, p)).toBe('connect_tls');
    for (const error of [{ status: 401 }, { code: 'ECONNRESET' }, { code: 'ETIMEDOUT' }, { name: 'AbortError' },
        { status: 502, outcomeUnknown: true }, new SyntaxError('JSON')]) expect(retryReason(error, p)).toBeNull();
});
test('uses exponential backoff, bounded jitter and Retry-After without retrying early', () => {
    const p = resolveRetryPolicy({ baseDelayMs: 100, maxDelayMs: 200, jitterRatio: 0 });
    expect(retryDelay(p, 1)).toBe(100);
    expect(retryDelay(p, 3)).toBe(200);
    expect(retryDelay(p, 1, '20')).toBe(20000);
    expect(retryDelay(p, 1, 'Thu, 01 Jan 1970 00:00:10 GMT', 1000)).toBe(9000);
});
