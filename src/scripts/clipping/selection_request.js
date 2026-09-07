'use strict';
const { withSelectionCache } = require('./selection_cache');
const { parseClipResponse, resolveEvidenceBoundaries, linkClipEvidence } = require('./subtitle_evidence');
const { summarizeTextAttempts, hasIncompleteTextGeneration } = require('../text_attempt_diagnostics');

function recordSelectionDiagnostic(diagnostics, context, result = null, error = null) {
    if (!diagnostics) return;
    const rawAttempts = error?.attempts || result?.meta?.attempts;
    const attempts = Array.isArray(rawAttempts) ? rawAttempts : [];
    const last = attempts.at(-1) || {};
    const cacheHit = result?.meta?.selectionCache?.hit === true;
    const joinedFailure = error?.selectionCache?.joined === true;
    const reused = cacheHit || joinedFailure || error?.selectionCache?.hit === true;
    const originalUsage = summarizeTextAttempts(attempts);
    const zero = reused ? Object.fromEntries(Object.keys(originalUsage.knownUsage).map(field => [field, 0])) : null;
    const usage = reused ? { ...zero, knownUsage: zero, usageUnknown: false, attemptCount: 0, requestCount: 0 } : originalUsage;
    diagnostics.requests ||= [];
    diagnostics.requests.push({ ...context, ...usage, status: error ? 'failure' : 'success', cacheHit,
        ...(joinedFailure ? { joinedRequest: true, joinedGenerationId: error?.selectionCache?.generationId || null } : {}),
        model: result?.meta?.model || last.model || context.model || null,
        provider: last.provider || context.provider, apiModeUsed: last.apiModeUsed || null,
        requestId: reused ? null : last.requestId || null, responseId: reused ? null : last.responseId || null,
        reasoningEffortSent: last.reasoningEffortSent || null, responseModel: last.responseModel || null,
        attempts: reused ? [] : attempts,
        ...(error ? { error: String(error.message || error).slice(0, 300) } : {}),
        ...(reused ? { reusedGeneration: { ...originalUsage, attempts,
            requestId: last.requestId || null, responseId: last.responseId || null } } : {}) });
}

async function requestSelectionText(prompt, requestOptions, config, rootConfig, info, phase, diagnostics, validate) {
    const stageName = phase.startsWith('recall-') ? 'recall' : 'rerank';
    const stage = config.ai?.stages?.[stageName];
    if (stage && require('./enhancement_runner').enhancementEnabled({ enabled: true, roomIds: config.ai.stageRoomIds }, info?.roomId)) {
        const started = Date.now();
        try {
            const result = await require('./enhancement_runner').requestStage(stage, config.ai.stageBudget, info, phase, prompt);
            recordSelectionDiagnostic(diagnostics, { phase, elapsedMs: Date.now() - started, provider: stage.provider, model: stage.model }, result);
            return result;
        } catch (error) {
            recordSelectionDiagnostic(diagnostics, { phase, elapsedMs: Date.now() - started, provider: stage.provider, model: stage.model }, null, error);
            throw error;
        }
    }
    const generator = require('../ai_text_generator');
    const provider = rootConfig.ai?.text?.provider || 'gemini';
    const textConfig = rootConfig.ai?.text || {};
    const settings = name => {
        const { apiKey, proxy, ...rest } = textConfig[name] || {};
        return rest;
    };
    const startedAt = Date.now();
    // A routing-only hint must not invalidate already verified model output.
    const { staticPromptCachePrefix, ...semanticRequestOptions } = requestOptions;
    const record = (result, error = null) => recordSelectionDiagnostic(diagnostics,
        { phase, promptChars: prompt.length, elapsedMs: Date.now() - startedAt, provider, model: requestOptions.primaryModel }, result, error);
    let result;
    try {
        result = await withSelectionCache({
            directory: config.ai?.selectionCacheEnabled === false ? null : info?.selectionCacheDirectory,
            phase, prompt,
            signature: { provider, requestProtocolVersion: generator.TEXT_REQUEST_PROTOCOL_VERSION || 1,
                requestOptions: semanticRequestOptions, daiYu: settings('daiYu'), tuZi: settings('tuZi'), gemini: settings('gemini') },
            validate
        }, () => provider === 'tuZi'
            ? generator.generateTextWithTuZi(prompt, requestOptions)
            : provider === 'daiYu'
                ? generator.generateTextWithDaiYu(prompt, requestOptions)
                : generator.generateTextWithGemini(prompt, { wordLimit: requestOptions.wordLimit }));
        if (hasIncompleteTextGeneration(result?.meta)) {
            throw Object.assign(new Error('Text generation did not complete'), { attempts: result.meta?.attempts || [],
                selectionCache: result.meta?.selectionCache });
        }
    } catch (error) {
        record(null, error);
        throw error;
    }
    record(result);
    return result;
}

function validSelectionResponse(result, evidence, candidateIds = null, config = {}, allowedCueIds = null, danmaku = [], allowedDanmakuIds = new Set()) {
    try {
        return parseClipResponse(result.text).every(clip => {
            if (candidateIds && !candidateIds.has(String(clip.candidateIndex))) return false;
            const bounds = resolveEvidenceBoundaries(clip, evidence);
            if (!bounds) return false;
            if (allowedCueIds && (!allowedCueIds.has(bounds.startCueId) || !allowedCueIds.has(bounds.endCueId))) return false;
            if (bounds.end - bounds.start < (Number(config.minClipSeconds) || 0)
                || bounds.end - bounds.start > (Number(config.maxClipSeconds) || Infinity) + 5) return false;
            const label = clip.event || clip.title;
            if (typeof label !== 'string' || !label.trim()) return false;
            const linked = linkClipEvidence(clip, bounds, evidence, danmaku, { cueIds: allowedCueIds, danmakuIds: allowedDanmakuIds });
            return !linked.issues.some(issue => /^(?:unknown_|unseen_|subtitle_outside_clip|danmaku_outside_clip)/u.test(issue));
        });
    } catch { return false; }
}

module.exports = { requestSelectionText, validSelectionResponse };
