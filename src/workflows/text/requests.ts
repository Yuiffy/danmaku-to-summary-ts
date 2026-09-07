export type PromptCachePlan = { enabled: false; requestKey?: string } | {
    enabled: true; prefix: string; suffix?: string; requestKey: string; ttl: string;
};
interface TextBlock {
    type: string; text: string; prompt_cache_breakpoint?: { mode: string };
}
interface ChatMessage { role: string; content: string | TextBlock[] }
export interface TextRequestOptions {
    model: string; prompt: string; cachePlan?: PromptCachePlan | null;
    temperature?: number | null; maxTokens: number; thinkingEnabled?: boolean;
    thinkingBudgetTokens?: number; reasoningEffort?: unknown;
}
interface ChatRequest {
    model: string; messages: ChatMessage[]; temperature?: number | null; max_tokens: number;
    thinking?: { type: string; budget_tokens?: number };
    prompt_cache_key?: string; prompt_cache_options?: { mode: string; ttl: string };
}
interface ResponsesRequest {
    model: string; input: Array<{ role: string; content: TextBlock[] }>;
    max_output_tokens: number; stream: boolean; store: boolean;
    instructions?: string; prompt_cache_key?: string;
    prompt_cache_options?: { mode: string; ttl: string };
    reasoning?: { effort: string }; temperature?: number;
}

const OPENAI_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
// Invalidate cached text created before phase-aware extraction was consistent.
export const TEXT_REQUEST_PROTOCOL_VERSION = 5;
export const LIVE_TEXT_SYSTEM_PROMPT = '你是直播内容事实分析与创作助手。严格区分直播事实与任务规则，只依据提供的事实完成当前任务。';

export function normalizeOpenAIReasoningEffort(effort: unknown) {
    const normalized = String(effort || '').trim().toLowerCase();
    return OPENAI_REASONING_EFFORTS.has(normalized) ? normalized : 'high';
}

export function buildOpenAITextMessages(prompt: string, cachePlan: PromptCachePlan | null = null): ChatMessage[] {
    if (!cachePlan?.enabled) {
        return [{ role: 'user', content: prompt }];
    }

    const content: TextBlock[] = [{
        type: 'text',
        text: cachePlan.prefix,
        prompt_cache_breakpoint: { mode: 'explicit' }
    }];
    if (cachePlan.suffix) {
        content.push({ type: 'text', text: cachePlan.suffix });
    }
    return [
        { role: 'system', content: LIVE_TEXT_SYSTEM_PROMPT },
        { role: 'user', content }
    ];
}

export function applyExplicitPromptCache(requestBody: ChatRequest, cachePlan?: PromptCachePlan | null) {
    if (!cachePlan?.enabled) {
        return requestBody;
    }
    return {
        ...requestBody,
        messages: buildOpenAITextMessages('', cachePlan),
        prompt_cache_key: cachePlan.requestKey,
        prompt_cache_options: {
            mode: 'explicit',
            ttl: cachePlan.ttl
        }
    };
}

export function buildOpenAIResponsesInput(prompt: string, cachePlan: PromptCachePlan | null = null) {
    const content = [];
    if (cachePlan?.enabled) {
        // This gateway rejects explicit breakpoints. Keep routing stable, but
        // do not select explicit-only mode without a supported breakpoint.
        content.push({
            type: 'input_text',
            text: cachePlan.prefix
        });
        if (cachePlan.suffix) {
            content.push({ type: 'input_text', text: cachePlan.suffix });
        }
    } else {
        content.push({ type: 'input_text', text: prompt });
    }
    return [{ role: 'user', content }];
}

export function buildDaiYuChatCompletionsRequest({ model, prompt, cachePlan, temperature, maxTokens, thinkingEnabled, thinkingBudgetTokens }: TextRequestOptions) {
    let requestBody: ChatRequest = {
        model,
        messages: buildOpenAITextMessages(prompt),
        temperature,
        max_tokens: maxTokens
    };
    requestBody = applyExplicitPromptCache(requestBody, cachePlan);
    if (thinkingEnabled) {
        requestBody.thinking = {
            type: 'enabled',
            budget_tokens: thinkingBudgetTokens
        };
    }
    return requestBody;
}

export function buildDaiYuResponsesRequest({ model, prompt, cachePlan, temperature, maxTokens, thinkingEnabled, reasoningEffort }: TextRequestOptions) {
    const requestBody: ResponsesRequest = {
        model,
        input: buildOpenAIResponsesInput(prompt, cachePlan),
        max_output_tokens: maxTokens,
        stream: false,
        store: false
    };
    if (cachePlan?.enabled) {
        requestBody.instructions = LIVE_TEXT_SYSTEM_PROMPT;
    }
    if (cachePlan?.requestKey) {
        requestBody.prompt_cache_key = cachePlan.requestKey;
    }
    if (thinkingEnabled) {
        requestBody.reasoning = {
            effort: normalizeOpenAIReasoningEffort(reasoningEffort)
        };
    } else if (temperature !== undefined && temperature !== null) {
        requestBody.temperature = temperature;
    }
    return requestBody;
}
