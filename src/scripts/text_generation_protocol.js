'use strict';
const crypto = require('crypto');
const liveGenerationContext = require('./live_generation_context');

function resolveTextRequestTimeout(options, fallbackMs = 60000) {
    const timeoutMs = Number(options.timeoutMs) || fallbackMs;
    const remaining = options.deadlineAt ? Number(options.deadlineAt) - Date.now() : timeoutMs;
    if (remaining <= 0) throw new Error('Text generation deadline exceeded');
    return Math.max(1, Math.floor(Math.min(timeoutMs, remaining)));
}

function parseGenerateTextOptions(rawArgs = []) {
    let promptSource;
    let promptCacheRolloutPercent;
    const requestOptions = {};
    const numericOptions = { '--timeout-ms': 'timeoutMs', '--total-timeout-ms': 'totalTimeoutMs', '--min-output-chars': 'minOutputChars' };

    for (let index = 0; index < rawArgs.length; index++) {
        const arg = rawArgs[index];
        if (numericOptions[arg]) {
            const value = Number(rawArgs[++index]);
            if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${arg}`);
            requestOptions[numericOptions[arg]] = Math.floor(value);
        } else if (arg === '--prompt-cache-rollout-percent') {
            promptCacheRolloutPercent = Number(rawArgs[++index]);
        } else if (arg.startsWith('--prompt-cache-rollout-percent=')) {
            promptCacheRolloutPercent = Number(arg.slice('--prompt-cache-rollout-percent='.length));
        } else if (promptSource === undefined) {
            promptSource = arg;
        } else {
            throw new Error(`未知 --generate-text 参数: ${arg}`);
        }
    }

    if (promptCacheRolloutPercent !== undefined && !Number.isFinite(promptCacheRolloutPercent)) {
        throw new Error('--prompt-cache-rollout-percent 必须是数字');
    }
    return { promptSource, promptCacheRolloutPercent, ...requestOptions };
}

function getMachineReadableGenerationMeta(generated = {}) {
    const generationMeta = generated.meta || {};
    return {
        provider: generationMeta.provider,
        model: generationMeta.model,
        fallback: Boolean(generationMeta.fallback),
        attempts: generationMeta.attempts || [],
        textSha256: crypto.createHash('sha256').update(String(generated.text || '').trim(), 'utf8').digest('hex')
    };
}

function getSharedPromptCacheInfo(prompt) {
    const text = String(prompt || '');
    if (!text.startsWith(liveGenerationContext.SHARED_PROMPT_CACHE_START)) {
        return {};
    }
    const endIndex = text.indexOf(liveGenerationContext.SHARED_PROMPT_CACHE_END);
    if (endIndex < 0) {
        return {};
    }
    const prefix = text.slice(
        0,
        endIndex + liveGenerationContext.SHARED_PROMPT_CACHE_END.length
    );
    return {
        sharedPromptCacheKey: crypto.createHash('sha256').update(prefix, 'utf8').digest('hex'),
        sharedPromptPrefixChars: Array.from(prefix).length
    };
}

function getExplicitPromptCachePlan(
    prompt,
    config = {},
    model = 'gpt-5.6-luna',
    rolloutPercentOverride = undefined,
    staticPrefix = undefined
) {
    const info = getSharedPromptCacheInfo(prompt);
    const cacheConfig = config.ai?.text?.sharedPromptCache || {};
    const configuredRolloutPercent = rolloutPercentOverride !== undefined
        ? rolloutPercentOverride
        : cacheConfig.explicitRolloutPercent;
    const rolloutPercent = Math.max(0, Math.min(100, Number(configuredRolloutPercent) || 0));
    const modelEligible = /^gpt-5\.6(?:[.-]|$)/i.test(String(model || ''));
    const sourceRoute = info.sharedPromptCacheKey && cacheConfig.enabled !== false && modelEligible
        ? { requestKey: `live:${info.sharedPromptCacheKey.slice(0, 48)}` }
        : {};
    // Static task prefixes only add routing; they never select an explicit role or layout.
    if (!info.sharedPromptCacheKey && cacheConfig.enabled !== false && modelEligible
        && typeof staticPrefix === 'string' && staticPrefix.trim() && String(prompt || '').startsWith(staticPrefix)) {
        return { enabled: false, rolloutPercent, modelEligible,
            requestKey: `task:${crypto.createHash('sha256').update(staticPrefix, 'utf8').digest('hex').slice(0, 48)}`,
            staticPromptPrefixChars: Array.from(staticPrefix).length };
    }
    if (!info.sharedPromptCacheKey || cacheConfig.enabled === false || !modelEligible || rolloutPercent <= 0) {
        return { enabled: false, rolloutPercent, modelEligible, ...info, ...sourceRoute };
    }

    const bucket = parseInt(info.sharedPromptCacheKey.slice(0, 8), 16) % 10000;
    const enabled = bucket < Math.round(rolloutPercent * 100);
    if (!enabled) {
        return { enabled: false, rolloutPercent, rolloutBucket: bucket, modelEligible, ...info, ...sourceRoute };
    }

    const text = String(prompt || '');
    const prefixEnd = text.indexOf(liveGenerationContext.SHARED_PROMPT_CACHE_END) + liveGenerationContext.SHARED_PROMPT_CACHE_END.length;
    return {
        enabled: true,
        rolloutPercent,
        rolloutBucket: bucket,
        modelEligible,
        ...sourceRoute,
        prefix: text.slice(0, prefixEnd),
        suffix: text.slice(prefixEnd),
        ttl: cacheConfig.ttl === '30m' ? '30m' : '30m',
        ...info
    };
}

function isPromptCacheParameterError(errorText) {
    let error;
    try { const parsed = JSON.parse(errorText); error = parsed?.error || parsed; } catch { /* Some gateways return plain text. */ }
    const fields = ['prompt_cache_key', 'prompt_cache_options', 'prompt_cache_breakpoint'];
    if (typeof error?.param === 'string' && error.param) {
        return error.param.split(/\W+/u).some(part => fields.includes(part));
    }
    const message = String(error?.message || errorText || '');
    return /\bprompt_cache_(?:key|options|breakpoint)\b/u.test(message)
        && /unsupported|unknown|unrecognized|invalid|not (?:supported|allowed)|不支持|未知参数/iu.test(message);
}

function getPromptCacheRequestDiagnostics(body) {
    const messages = body.input || body.messages;
    if (!Array.isArray(messages)) return {};
    const prefixMessages = [];
    for (const message of messages) {
        const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
        const prefixParts = [];
        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            const end = typeof part.text === 'string' ? part.text.indexOf(liveGenerationContext.SHARED_PROMPT_CACHE_END) : -1;
            if (end < 0) {
                prefixParts.push(part);
                continue;
            }
            const boundaryOffset = end + liveGenerationContext.SHARED_PROMPT_CACHE_END.length;
            prefixParts.push({ ...part, text: part.text.slice(0, boundaryOffset) });
            prefixMessages.push({ role: message.role, content: prefixParts });
            const boundary = boundaryOffset < part.text.length ? 'inline'
                : index < parts.length - 1 ? 'content_block' : 'message';
            const requestPrefix = { model: body.model, instructions: body.instructions, messages: prefixMessages,
                reasoning: body.reasoning, thinking: body.thinking, reasoningEffort: body.reasoning_effort,
                tools: body.tools, parallelToolCalls: body.parallel_tool_calls, text: body.text,
                contextManagement: body.context_management, cacheKey: body.prompt_cache_key,
                cacheOptions: body.prompt_cache_options, boundary };
            return { promptCacheRequestFingerprint: crypto.createHash('sha256').update(JSON.stringify(requestPrefix), 'utf8').digest('hex'),
                promptCacheRequestKey: body.prompt_cache_key || null, promptCacheSourceBoundary: boundary };
        }
        prefixMessages.push({ role: message.role, content: prefixParts });
    }
    return {};
}

function withoutPromptCacheHints(body) {
    const stripPart = part => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
        const { prompt_cache_breakpoint, ...rest } = part;
        return rest;
    };
    const stripMessage = message => message && Array.isArray(message.content)
        ? { ...message, content: message.content.map(stripPart) } : message;
    const { prompt_cache_key, prompt_cache_options, ...plain } = body;
    if (Array.isArray(plain.messages)) plain.messages = plain.messages.map(stripMessage);
    if (Array.isArray(plain.input)) plain.input = plain.input.map(stripMessage);
    return plain;
}

module.exports = { resolveTextRequestTimeout, parseGenerateTextOptions, getMachineReadableGenerationMeta,
    getSharedPromptCacheInfo, getExplicitPromptCachePlan, getPromptCacheRequestDiagnostics,
    isPromptCacheParameterError, withoutPromptCacheHints };
