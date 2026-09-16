export {};
const { postWithRetry, requestRetryPolicy, strictGenerationWithRetry } = require('./request_transport');
const { resolveRetryPolicy } = require('../workflow-runtime').loadWorkflow('text/response');
test('retries the same request after 502, consuming its body once and recording the failed attempt', async () => {
    const body = jest.fn(async () => 'upstream'); const retry = jest.fn(); const sleep = jest.fn(async () => {});
    const send = jest.fn().mockResolvedValueOnce({ status: 502, text: body, headers: { get: () => '2' } })
        .mockResolvedValueOnce({ status: 200 });
    expect(await postWithRetry(send, resolveRetryPolicy({ maxAttempts: 2 }), { onRetry: retry, sleep })).toEqual({ status: 200 });
    expect(body).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000); expect(retry).toHaveBeenCalledTimes(1);
});
test('does not submit after Retry-After exceeds the deadline, or for ambiguous connection resets', async () => {
    const policy = resolveRetryPolicy({ maxAttempts: 3 }); const sleep = jest.fn();
    const send = jest.fn(async () => ({ status: 429, text: async () => 'rate limit', headers: { get: () => '3600' } }));
    await expect(postWithRetry(send, policy, { deadlineAt: Date.now() + 500, sleep })).rejects.toMatchObject({ status: 429 });
    expect(send).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
    const reset = jest.fn(async () => { throw Object.assign(Error('socket reset'), { code: 'ECONNRESET' }); });
    await expect(postWithRetry(reset, policy)).rejects.toThrow('socket reset'); expect(reset).toHaveBeenCalledTimes(1);
});
test('per-request policy overrides provider and global settings; strict evaluation stays single shot', () => {
    const root = { ai: { text: { retry: { maxAttempts: 2, baseDelayMs: 10 } } } };
    expect(requestRetryPolicy(root, { retry: { maxAttempts: 3 } }, { retry: { maxAttempts: 1 } })).toMatchObject({ maxAttempts: 1, baseDelayMs: 10 });
    expect(requestRetryPolicy(root, {}, { strictEvaluation: true, retry: { maxAttempts: 3 } }).maxAttempts).toBe(1);
});
test('an explicitly retrying strict stage keeps each generation single-shot and accounts for every attempt', async () => {
    const failed = { httpStatus: 502, status: 'failure', requestId: 'failed' };
    const success = { status: 'success', requestId: 'ok' };
    const generate = jest.fn().mockRejectedValueOnce(Object.assign(Error('502'), { attempts: [failed] }))
        .mockResolvedValueOnce({ text: '{}', meta: { attempts: [success] } });
    const result = await strictGenerationWithRetry(generate, resolveRetryPolicy({ maxAttempts: 2, baseDelayMs: 0 }), { sleep: async () => {} });
    expect(result.meta.attempts).toEqual([failed, success]); expect(generate).toHaveBeenCalledTimes(2);
});
