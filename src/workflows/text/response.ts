export interface TextChoice {
    finish_reason?: string; finishReason?: string; native_finish_reason?: string;
    message?: { content?: unknown };
}
export interface TextResponse {
    choices?: TextChoice[];
    output_text?: unknown;
    output?: Array<{ status?: string; [key: string]: unknown }>;
    incomplete_details?: { reason?: string };
    incompleteDetails?: { reason?: string };
    status?: string;
}
export interface TokenUsage {
    [key: string]: unknown;
    prompt_tokens_details?: Record<string, unknown>;
    promptTokensDetails?: Record<string, unknown>;
    input_tokens_details?: Record<string, unknown>;
    inputTokensDetails?: Record<string, unknown>;
    completion_tokens_details?: Record<string, unknown>;
    completionTokensDetails?: Record<string, unknown>;
    output_tokens_details?: Record<string, unknown>;
    outputTokensDetails?: Record<string, unknown>;
}

export function normalizeTuZiTextMaxTokens(model: unknown, configuredMaxTokens: unknown, wordLimit: number = 100) {
    const requested = Number.isFinite(Number(configuredMaxTokens))
        ? Math.max(1, Math.floor(Number(configuredMaxTokens)))
        : Math.max(800, Math.ceil(Number(wordLimit || 100) * 4));
    const modelName = String(model || '').toLowerCase();
    const upstreamLimit = modelName.includes('gemini') ? 65536 : 100000;
    return Math.min(requested, upstreamLimit);
}

export function getTuZiFinishReason(choice?: TextChoice | null) {
    return choice?.finish_reason || choice?.finishReason || choice?.native_finish_reason || null;
}

export function extractOpenAITextParts(value: unknown): string[] {
    if (typeof value === 'string') {
        return value.trim() ? [value] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap(extractOpenAITextParts);
    }
    if (!value || typeof value !== 'object') {
        return [];
    }

    const item = value as Record<string, unknown>;
    const itemType = String(item.type || '').toLowerCase();
    if (itemType === 'text' || itemType === 'output_text') {
        const text = typeof item.text === 'object' ? (item.text as Record<string, unknown> | null)?.value : item.text;
        if (typeof text === 'string' && text.trim()) {
            return [text];
        }
    }
    return extractOpenAITextParts(item.content);
}

export function extractOpenAITextResponse(data: TextResponse | null | undefined) {
    if (!data || typeof data !== 'object') {
        return '';
    }

    const messages = Array.isArray(data.output) ? data.output.filter(item => item?.type === 'message') : [];
    if (messages.some(item => item.phase === 'commentary' || item.phase === 'final_answer')) {
        const assistant = messages.filter(item => item.role == null || item.role === 'assistant');
        const final = assistant.filter(item => item.phase === 'final_answer');
        const selected = final.length ? final : assistant.filter(item => item.phase == null);
        // A missing or refused final answer must not fall back to progress text.
        return selected.flatMap(item => extractOpenAITextParts(item.content))
            .map(part => part.trim()).filter(Boolean).join('\n');
    }

    const choice = data.choices?.[0];
    const chatParts = extractOpenAITextParts(choice?.message?.content);
    if (chatParts.length > 0) {
        return chatParts.map(part => part.trim()).filter(Boolean).join('\n');
    }

    const responseParts = extractOpenAITextParts(data.output_text);
    const fallbackParts = responseParts.length > 0
        ? responseParts
        : extractOpenAITextParts(data.output);
    return fallbackParts.map(part => part.trim()).filter(Boolean).join('\n');
}

export function getOpenAITextFinishReason(data?: TextResponse | null) {
    const output = Array.isArray(data?.output) ? data.output : [];
    const finalMessages = output.filter(item => item?.type === 'message' && item.phase === 'final_answer'
        && (item.role == null || item.role === 'assistant'));
    if (finalMessages.length) {
        return data?.incomplete_details?.reason || data?.incompleteDetails?.reason || data?.status
            || [...finalMessages].reverse().find(item => item.status)?.status
            || getTuZiFinishReason(data?.choices?.[0]) || null;
    }
    const chatReason = getTuZiFinishReason(data?.choices?.[0]);
    if (chatReason) {
        return chatReason;
    }
    return data?.incomplete_details?.reason
        || data?.incompleteDetails?.reason
        || data?.status
        || (Array.isArray(data?.output) ? data.output.find(item => item?.status)?.status : null)
        || null;
}

function firstUsageMetric(...values: unknown[]) {
    for (const value of values) {
        const normalized = normalizeUsageMetric(value);
        if (normalized !== null) return normalized;
    }
    return undefined;
}

export function getPromptTokenUsage(usage?: TokenUsage | null) {
    if (!usage || typeof usage !== 'object') {
        return { promptTokens: undefined, cachedTokens: undefined, cacheWriteTokens: undefined };
    }
    return {
        promptTokens: firstUsageMetric(usage.prompt_tokens, usage.promptTokens, usage.input_tokens, usage.inputTokens),
        cachedTokens: firstUsageMetric(usage.prompt_tokens_details?.cached_tokens, usage.promptTokensDetails?.cachedTokens,
            usage.input_tokens_details?.cached_tokens, usage.inputTokensDetails?.cachedTokens,
            usage.cached_prompt_tokens, usage.cachedPromptTokens, usage.cache_read_input_tokens, usage.cacheReadInputTokens),
        cacheWriteTokens: firstUsageMetric(usage.prompt_tokens_details?.cache_write_tokens, usage.promptTokensDetails?.cacheWriteTokens,
            usage.input_tokens_details?.cache_write_tokens, usage.inputTokensDetails?.cacheWriteTokens,
            usage.cache_write_tokens, usage.cacheWriteTokens, usage.cache_creation_input_tokens, usage.cacheCreationInputTokens)
    };
}

export function getCompletionTokenUsage(usage?: TokenUsage | null) {
    if (!usage || typeof usage !== 'object') {
        return { completionTokens: undefined, reasoningTokens: undefined };
    }
    return {
        completionTokens: firstUsageMetric(usage.completion_tokens, usage.completionTokens, usage.output_tokens, usage.outputTokens),
        reasoningTokens: firstUsageMetric(usage.completion_tokens_details?.reasoning_tokens, usage.completionTokensDetails?.reasoningTokens,
            usage.output_tokens_details?.reasoning_tokens, usage.outputTokensDetails?.reasoningTokens, usage.reasoning_tokens, usage.reasoningTokens)
    };
}

export function normalizeUsageMetric(value: unknown) {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

export function buildAiUsageMetrics(attempt: Record<string, unknown> = {}) {
    const promptTokens = normalizeUsageMetric(attempt.promptTokens);
    const cachedTokens = normalizeUsageMetric(attempt.cachedTokens);
    const uncachedPromptTokens = promptTokens !== null && cachedTokens !== null
        ? Math.max(0, promptTokens - cachedTokens)
        : null;
    return {
        provider: attempt.provider || null,
        model: attempt.model || null,
        promptTokens,
        cachedTokens,
        uncachedPromptTokens,
        cacheWriteTokens: normalizeUsageMetric(attempt.cacheWriteTokens),
        completionTokens: normalizeUsageMetric(attempt.completionTokens),
        reasoningTokens: normalizeUsageMetric(attempt.reasoningTokens),
        totalTokens: normalizeUsageMetric(attempt.totalTokens),
        cacheHitRatio: promptTokens !== null && promptTokens > 0 && cachedTokens !== null
            ? Number((cachedTokens / promptTokens).toFixed(4))
            : null,
        apiModeRequested: attempt.apiModeRequested || null,
        apiModeUsed: attempt.apiModeUsed || null,
        apiModeFallbackReason: attempt.apiModeFallbackReason || null,
        sharedPromptCacheKey: attempt.sharedPromptCacheKey || null,
        explicitPromptCache: attempt.explicitPromptCache || null,
        ...(attempt.status === 'failure' ? { status: 'failure', usageUnknown: attempt.usageUnknown !== false,
            requestStarted: typeof attempt.requestStarted === 'boolean' ? attempt.requestStarted : null,
            ...(attempt.usageFinal !== undefined ? { usageFinal: attempt.usageFinal } : {}),
            ...(attempt.outcomeUnknown ? { outcomeUnknown: true } : {}),
            httpStatus: normalizeUsageMetric(attempt.httpStatus), ...(attempt.stage ? { stage: attempt.stage } : {}) } : {}),
        ...(attempt.requestId ? { requestId: attempt.requestId } : {}),
        ...(attempt.responseId ? { responseId: attempt.responseId } : {})
    };
}

export function logAiUsage(attempt: Record<string, unknown>) {
    console.log(`[AI_USAGE] ${JSON.stringify(buildAiUsageMetrics(attempt))}`);
}
