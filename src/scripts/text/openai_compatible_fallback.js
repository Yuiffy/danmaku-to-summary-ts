// zai(智谱GLM)/deepSeek 等OpenAI兼容兜底文本生成(单模型, chatCompletions)
// 供 ai_text_generator 的 daiYu fallbackChain 使用
// 依赖注入: 由 ai_text_generator 在加载时 bindDeps 注入共享工具, 避免模块循环依赖
const crypto = require('crypto');
const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
const configLoader = require('../config-loader');

let generatorDeps = null;
function bindDeps(d) { generatorDeps = d; }
const deps = () => {
    if (!generatorDeps) throw new Error('openai_compatible_fallback 未初始化: 需由 ai_text_generator bindDeps 注入');
    return generatorDeps;
};

const FALLBACK_DEFAULTS = {
    zai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash' },
    deepSeek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }
};

async function generateTextWithOpenAICompatibleFallback(providerName, providerConfig, apiKey, prompt, options = {}) {
    const config = configLoader.getConfig();
    if (!apiKey || apiKey.trim() === '') {
        throw new Error(`${providerName} API未配置,请检查secret.json中的apiKey`);
    }
    const defaults = FALLBACK_DEFAULTS[providerName] || {};
    const baseUrl = String(providerConfig.baseUrl || defaults.baseUrl).replace(/\/+$/, '');
    const apiUrl = `${baseUrl}/chat/completions`;
    const model = String(options.primaryModel || providerConfig.model || defaults.model || '').trim() || defaults.model;
    // GLM flash / deepseek-flash 是思考模型, reasoning计入completion tokens, 默认给足余量
    const effectiveMaxTokens = options.maxTokens
        ?? providerConfig.textMaxTokens
        ?? Math.max(Number(providerConfig.maxTokens) || 0, 8000);
    let agent = null;
    if (providerConfig.proxy) {
        console.log(`   使用代理: ${providerConfig.proxy}`);
        agent = new HttpsProxyAgent(providerConfig.proxy);
    }
    const attempts = Array.isArray(options.attempts) ? [...options.attempts] : [];
    const attemptState = deps().createTextAttemptState('chatCompletions');
    const timeoutMs = deps().resolveTextRequestTimeout(options, config.timeouts?.aiApiTimeout || 60000);
    console.log(`🤖 调用${providerName} API生成文本(模型 ${model})...`);
    attemptState.requestStarted = true;
    try {
        const requestBody = {
            model,
            messages: deps().buildOpenAITextMessages(prompt, null, options.images),
            temperature: providerConfig.temperature ?? 0.7,
            max_tokens: effectiveMaxTokens
        };
        console.log(`[WAIT] 正在通过${providerName} API生成文本... (模型 ${model}, 超时: ${Math.round(timeoutMs / 1000)}s)`);
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            agent,
            timeout: timeoutMs,
            signal: AbortSignal.timeout(timeoutMs)
        });
        attemptState.response = response;
        if (!response.ok) {
            const errorText = await response.text();
            const error = new Error(`${providerName} API返回错误 ${response.status}: ${errorText}`);
            error.status = response.status;
            throw error;
        }
        const data = await response.json();
        attemptState.data = data;
        const usage = data.usage || null;
        const finishReason = deps().getTuZiFinishReason(data.choices?.[0]);
        let text = data.choices?.[0]?.message?.content;
        console.log(
            `   finish_reason: ${finishReason || 'unknown'}, `
            + `usage: ${usage ? JSON.stringify(usage) : 'unknown'}`
        );
        if (!text || text.trim().length === 0) {
            throw new Error(`${providerName} API返回空结果`);
        }
        if (options.minOutputChars && text.trim().length < options.minOutputChars) {
            throw new Error(`Text result is shorter than ${options.minOutputChars} characters`);
        }
        if (deps().isIncompleteTextState(finishReason)) {
            throw new Error(`${providerName} API输出未完成 (finish_reason=${finishReason}, max_tokens=${effectiveMaxTokens})`);
        }
        text = deps().unwrapSharedLiveOutput(text, options.sharedOutputTask);
        if (options.minOutputChars && text.trim().length < options.minOutputChars) {
            throw new Error(`Text result is shorter than ${options.minOutputChars} characters`);
        }
        deps().assertGeneratedOutput(text, options, data, {
            provider: providerName,
            requestId: response.headers?.get?.('x-request-id') || null,
            promptSha256: crypto.createHash('sha256').update(prompt).digest('hex')
        });
        const successfulAttempt = {
            provider: providerName,
            rawUsage: usage,
            model,
            status: 'success',
            requestStarted: true,
            finishReason: finishReason || 'unknown',
            apiModeUsed: 'chatCompletions',
            promptTokens: usage?.prompt_tokens ?? undefined,
            cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? undefined,
            completionTokens: usage?.completion_tokens ?? undefined,
            reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? undefined,
            totalTokens: usage?.total_tokens ?? undefined,
            maxTokens: effectiveMaxTokens
        };
        successfulAttempt.requestId = response.headers?.get?.('x-request-id') || null;
        successfulAttempt.responseId = data.id || null;
        attempts.push(successfulAttempt);
        deps().logAiUsage(successfulAttempt);
        console.log(`✅ ${providerName} API调用成功`);
        return deps().createGenerationResult(text, {
            provider: providerName,
            model,
            fallback: options.fallback || attempts.some(attempt => attempt.provider === 'daiYu'),
            attempts,
            finishReason: finishReason || 'unknown',
            usage,
            maxTokens: effectiveMaxTokens
        });
    } catch (error) {
        deps().recordFailedTextAttempt(attempts, providerName, model, error, attemptState);
        throw deps().buildTextModelFailureError(attempts, providerName);
    }
}

function generateTextWithZai(prompt, options = {}) {
    const config = configLoader.getConfig();
    return generateTextWithOpenAICompatibleFallback(
        'zai', config.ai?.text?.zai || {}, configLoader.getZaiTextApiKey(), prompt, options
    );
}

function generateTextWithDeepSeek(prompt, options = {}) {
    const config = configLoader.getConfig();
    return generateTextWithOpenAICompatibleFallback(
        'deepSeek', config.ai?.text?.deepSeek || {}, configLoader.getDeepSeekTextApiKey(), prompt, options
    );
}

module.exports = { generateTextWithZai, generateTextWithDeepSeek, generateTextWithOpenAICompatibleFallback, runDaiYuFallbackChain, bindDeps };

/**
 * daiYu 全部候选失败后的兑底链调度: 优先 fallbackChain(新), 否则兼容旧 fallbackProvider 单级兑底
 * 无可用兑底或全部失败时抛出聚合错误(daiYuFailure 保留在最前)
 */
async function runDaiYuFallbackChain({ prompt, options, daiYuFailure, attempts, daiYuConfig, reasoningEffort, wordLimit, config }) {
    const chain = [];
    const rawChain = Array.isArray(daiYuConfig.fallbackChain) ? daiYuConfig.fallbackChain : null;
    if (rawChain) {
        for (const entry of rawChain) {
            const provider = String(entry && entry.provider || '').trim();
            if (!['tuZi', 'zai', 'deepSeek'].includes(provider)) continue;
            chain.push({
                provider,
                model: String(entry.model || '').trim(),
                apiMode: entry.apiMode
            });
        }
    } else {
        const legacyProvider = String(daiYuConfig.fallbackProvider || '').trim().toLowerCase();
        if (legacyProvider === 'tuzi' && configLoader.isTuZiTextConfigured()) {
            chain.push({
                provider: 'tuZi',
                model: String(daiYuConfig.fallbackProviderModel || 'gpt-6-luna').trim() || 'gpt-6-luna',
                apiMode: deps().normalizeDaiYuApiMode(
                    daiYuConfig.fallbackProviderApiMode
                    || (config && config.ai && config.ai.text && config.ai.text.tuZi && config.ai.text.tuZi.apiMode)
                )
            });
        }
    }
    const fallbackFailures = [];
    for (const entry of chain) {
        console.warn(
            '⚠️  daiYu全部候选失败，兑底链转向 ' + entry.provider + '/' + (entry.model || '默认') + (entry.apiMode ? ' (' + entry.apiMode + ')' : '')
        );
        try {
            if (entry.provider === 'tuZi') {
                if (!configLoader.isTuZiTextConfigured()) throw new Error('tuZi未配置');
                return await deps().generateTextWithTuZi(prompt, {
                    ...options,
                    fallback: true,
                    attempts,
                    primaryModel: entry.model || undefined,
                    reasoningEffort,
                    fallbackModelsEnabled: false,
                    wordLimit,
                    timeoutMs: options.timeoutMs,
                    maxTokens: options.maxTokens,
                    apiMode: entry.apiMode ? deps().normalizeDaiYuApiMode(entry.apiMode) : undefined
                });
            }
            if (entry.provider === 'zai') {
                if (!configLoader.isZaiTextConfigured()) throw new Error('zai未配置');
                return await generateTextWithZai(prompt, {
                    ...options,
                    fallback: true,
                    attempts,
                    primaryModel: entry.model || undefined,
                    timeoutMs: options.timeoutMs,
                    maxTokens: options.maxTokens
                });
            }
            if (entry.provider === 'deepSeek') {
                if (!configLoader.isDeepSeekTextConfigured()) throw new Error('deepSeek未配置');
                return await generateTextWithDeepSeek(prompt, {
                    ...options,
                    fallback: true,
                    attempts,
                    primaryModel: entry.model || undefined,
                    timeoutMs: options.timeoutMs,
                    maxTokens: options.maxTokens
                });
            }
        } catch (fallbackError) {
            fallbackFailures.push(entry.provider + '/' + (entry.model || '默认') + ': ' + fallbackError.message);
            console.error('❌ 兑底 ' + entry.provider + '/' + (entry.model || '默认') + ' 失败: ' + fallbackError.message);
            if (fallbackError.attempts && fallbackError.attempts !== attempts) {
                for (const a of fallbackError.attempts) {
                    if (!attempts.includes(a)) attempts.push(a);
                }
            }
        }
    }
    if (fallbackFailures.length) {
        const failure = new Error(
            daiYuFailure.message + ' | 兑底链全部失败: ' + fallbackFailures.join(' | ')
        );
        failure.attempts = attempts;
        throw failure;
    }
    throw daiYuFailure;
}
