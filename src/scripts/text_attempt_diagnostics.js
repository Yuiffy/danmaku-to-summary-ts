'use strict';
let responseHelpers;
function textResponseHelpers() {
    return responseHelpers ||= require('./workflow-runtime').loadWorkflow('text/response');
}
const USAGE_FIELDS = ['promptTokens', 'cachedTokens', 'cacheWriteTokens', 'completionTokens', 'reasoningTokens', 'totalTokens'];
const INCOMPLETE_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens', 'content_filter',
    'incomplete', 'failed', 'failure', 'cancelled', 'canceled', 'queued', 'in_progress']);

function isIncompleteTextState(value) {
    return INCOMPLETE_REASONS.has(String(value || '').toLowerCase());
}

function isPendingTextGeneration(data) {
    if (!data) return false;
    return ['queued', 'in_progress'].includes(String(data.status || textResponseHelpers().getOpenAITextFinishReason(data) || '').toLowerCase());
}

function hasIncompleteTextGeneration(meta = {}) {
    const attempts = Array.isArray(meta?.attempts) ? meta.attempts : [];
    const lastSuccess = [...attempts].reverse().find(attempt => attempt?.status === 'success');
    return isIncompleteTextState(meta?.status) || isIncompleteTextState(meta?.finishReason)
        || isIncompleteTextState(lastSuccess?.finishReason);
}

function createTextAttemptState(apiMode) {
    return { apiModeRequested: apiMode, apiModeUsed: apiMode, requestStarted: false, response: null, data: null, recorded: false };
}

function resetTextAttempt(state, apiMode) {
    Object.assign(state, { apiModeUsed: apiMode, requestStarted: false, response: null, data: null, recorded: false });
}

function recordFailedTextAttempt(attempts, provider, model, error, state, extra = {}) {
    if (state.recorded) return;
    const { getPromptTokenUsage, getCompletionTokenUsage, normalizeUsageMetric, logAiUsage, getOpenAITextFinishReason } = textResponseHelpers();
    const usage = state.data?.usage;
    const pending = isPendingTextGeneration(state.data);
    const counts = state.requestStarted ? {
        ...getPromptTokenUsage(usage), ...getCompletionTokenUsage(usage),
        totalTokens: normalizeUsageMetric(usage?.total_tokens) ?? normalizeUsageMetric(usage?.totalTokens)
    } : Object.fromEntries(USAGE_FIELDS.map(field => [field, 0]));
    const known = Object.fromEntries(Object.entries(counts).filter(([, value]) => Number.isFinite(value)));
    const attempt = { provider, model, status: 'failure', ...extra, ...known,
        requestStarted: state.requestStarted,
        usageUnknown: pending || !Number.isFinite(known.promptTokens) || !Number.isFinite(known.completionTokens),
        usageFinal: pending ? false : (!state.requestStarted || state.data ? true : null),
        ...(pending ? { outcomeUnknown: true } : {}),
        apiModeRequested: state.apiModeRequested, apiModeUsed: state.apiModeUsed,
        httpStatus: state.response?.status ?? error.status ?? null,
        requestId: state.response?.headers?.get?.('x-request-id') || error.requestId || null,
        responseId: state.data?.id || null, responseModel: state.data?.model || null,
        finishReason: getOpenAITextFinishReason(state.data),
        error: String(error.message || error).slice(0, 300) };
    attempts.push(attempt);
    state.recorded = true;
    logAiUsage(attempt);
}

function summarizeTextAttempts(attempts = []) {
    const { normalizeUsageMetric } = textResponseHelpers();
    const entries = Array.isArray(attempts) ? attempts.map(attempt => attempt && typeof attempt === 'object' ? attempt : {}) : [];
    const totals = {}, knownUsage = {};
    for (const field of USAGE_FIELDS) {
        const values = entries.map(attempt => normalizeUsageMetric(attempt[field])).filter(value => value !== null);
        const sum = values.length ? values.reduce((total, value) => total + value, 0) : null;
        knownUsage[field] = sum;
        totals[field] = values.length === entries.length && entries.every(attempt => attempt.usageFinal !== false) ? sum : null;
    }
    return { ...totals, knownUsage, attemptCount: entries.length,
        requestCount: entries.length && entries.every(attempt => typeof attempt.requestStarted === 'boolean')
            ? entries.filter(attempt => attempt.requestStarted).length : null,
        usageUnknown: !entries.length || entries.some(attempt => attempt.usageUnknown === true)
            || totals.promptTokens === null || totals.completionTokens === null };
}

module.exports = { createTextAttemptState, resetTextAttempt, recordFailedTextAttempt, summarizeTextAttempts,
    isIncompleteTextState, hasIncompleteTextGeneration, isPendingTextGeneration };
