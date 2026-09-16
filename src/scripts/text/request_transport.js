'use strict';
const { resolveRetryPolicy, retryReason, retryDelay } = require('../workflow-runtime').loadWorkflow('text/response');

function requestRetryPolicy(root, provider, options) {
    const legacy = options.daiYuTransientMaxAttempts ?? options.transientMaxAttempts;
    return resolveRetryPolicy(root.ai?.text?.retry,
        provider.transientMaxAttempts !== undefined ? { maxAttempts: provider.transientMaxAttempts } : undefined,
        provider.transientRetryDelayMs !== undefined ? { baseDelayMs: provider.transientRetryDelayMs } : undefined, provider.retry,
        legacy !== undefined ? { maxAttempts: legacy } : undefined,
        options.transientRetryDelayMs !== undefined ? { baseDelayMs: options.transientRetryDelayMs } : undefined, options.retry,
        options.strictEvaluation ? { maxAttempts: 1 } : undefined);
}

async function postWithRetry(send, policy, context = {}) {
    const sleep = context.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (let attempt = 1; ; attempt++) {
        let failure, response;
        try {
            response = await send();
            if (!retryReason({ status: response.status }, policy) || attempt >= policy.maxAttempts) return response;
            failure = Object.assign(new Error(`Text API returned HTTP ${response.status}: ${await response.text()}`),
                { status: response.status, response });
        } catch (error) {
            failure = error;
            if (!retryReason(error, policy) && (['AbortError', 'TimeoutError'].includes(error.name)
                || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(error.code) || error.type === 'request-timeout')) error.outcomeUnknown = true;
        }
        const reason = retryReason(failure, policy);
        if (!reason || attempt >= policy.maxAttempts) throw failure;
        const waitMs = retryDelay(policy, attempt, response?.headers?.get?.('retry-after') || failure.retryAfter);
        if (waitMs > policy.maxDelayMs || (context.deadlineAt && Date.now() + waitMs >= context.deadlineAt)) throw failure;
        context.onRetry?.(failure, { attempt, nextAttempt: attempt + 1, waitMs, reason });
        await sleep(waitMs);
        if (context.deadlineAt && Date.now() >= context.deadlineAt) throw Object.assign(new Error('Text generation deadline exceeded'), { cause: failure });
    }
}
async function strictGenerationWithRetry(generate, policy, context = {}) {
    const failedAttempts = [];
    try {
        const response = await postWithRetry(async () => {
            try { return { status: 200, result: await generate() }; }
            catch (error) {
                const last = error.attempts?.at(-1);
                if (last) Object.assign(error, { status: last.httpStatus, code: last.code,
                    retryAfter: last.retryAfter,
                    outcomeUnknown: last.outcomeUnknown, response: last.httpStatus ? { status: last.httpStatus } : undefined });
                throw error;
            }
        }, policy, { ...context, onRetry: (error, retry) => {
            failedAttempts.push(...(error.attempts || []));
            context.onRetry?.(error, retry);
        } });
        const result = response.result;
        return failedAttempts.length ? { ...result, meta: { ...result.meta,
            attempts: [...failedAttempts, ...(result.meta?.attempts || [])] } } : result;
    } catch (error) { error.attempts = [...failedAttempts, ...(error.attempts || [])]; throw error; }
}
module.exports = { requestRetryPolicy, postWithRetry, strictGenerationWithRetry };
