jest.mock('node-fetch', () => jest.fn());
jest.mock('./config-loader', () => ({
  getConfig: jest.fn(),
  getDaiYuApiKey: jest.fn(),
  isDaiYuTextConfigured: jest.fn(),
  getTuZiTextApiKey: jest.fn(),
  isTuZiTextConfigured: jest.fn(),
  getByPath: jest.fn(),
}));

const fetchMock = require('node-fetch') as jest.Mock;
const configLoader = require('./config-loader');
const liveGenerationContext = require('./live_generation_context');
const {
  generateTextWithDaiYu,
  generateTextWithTuZi,
} = require('./ai_text_generator');

describe('daiYu model routing', () => {
  const legacyModel = ['gpt', '5.4', 'mini'].join('-');
  const config = {
    ai: {
      text: {
        daiYu: {
          enabled: true,
          model: legacyModel,
          fallbackModels: [legacyModel],
          temperature: 0.7,
          maxTokens: 1000,
          thinking: { enabled: true, budgetTokens: 1024 },
        },
      },
    },
    timeouts: { aiApiTimeout: 5000 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    configLoader.getConfig.mockReturnValue(config);
    configLoader.getDaiYuApiKey.mockReturnValue('test-key');
    configLoader.isDaiYuTextConfigured.mockReturnValue(true);
    configLoader.getTuZiTextApiKey.mockReturnValue('test-key');
    configLoader.isTuZiTextConfigured.mockReturnValue(true);
    configLoader.getByPath.mockReturnValue(100);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'LUNA_OK' },
          finish_reason: 'stop',
        }],
        usage: {},
      }),
    });
  });

  test('normalizes a legacy daiYu configuration before sending the request', async () => {
    const result = await generateTextWithDaiYu('只回复 LUNA_OK');

    expect(result.text).toBe('LUNA_OK');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.model).toBe('gpt-5.6-luna');
  });

  test('allows short structured tasks to lower output and thinking budgets', async () => {
    await generateTextWithDaiYu('只回复 LUNA_OK', {
      maxTokens: 2000,
      thinkingBudgetTokens: 2048,
    });

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.max_tokens).toBe(2000);
    expect(request.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
    });
  });

  test('uses native Responses fields and preserves the stable cache prefix', async () => {
    const responsesConfig = structuredClone(config);
    responsesConfig.ai.text.daiYu.apiMode = 'responses';
    responsesConfig.ai.text.daiYu.thinking.reasoningEffort = 'high';
    responsesConfig.ai.text.sharedPromptCache = {
      enabled: true,
      explicitRolloutPercent: 100,
      ttl: '30m',
    };
    configLoader.getConfig.mockReturnValue(responsesConfig);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'resp_native',
        status: 'completed',
        output: [{
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: 'RESPONSES_OK' }],
        }],
        usage: {
          input_tokens: 12000,
          input_tokens_details: { cached_tokens: 10000, cache_write_tokens: 2000 },
          output_tokens: 900,
          output_tokens_details: { reasoning_tokens: 700 },
          total_tokens: 12900,
        },
      }),
    });
    const prompt = [
      liveGenerationContext.SHARED_PROMPT_CACHE_START,
      '全量直播事实',
      liveGenerationContext.SHARED_PROMPT_CACHE_END,
      '当前任务规则',
    ].join('\n');

    const result = await generateTextWithDaiYu(prompt);

    expect(result.text).toBe('RESPONSES_OK');
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/v1/responses');
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request).toEqual(expect.objectContaining({
      model: 'gpt-5.6-luna',
      max_output_tokens: 1000,
      stream: false,
      store: false,
      reasoning: { effort: 'high' },
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    }));
    expect(request).not.toHaveProperty('messages');
    expect(request).not.toHaveProperty('max_tokens');
    expect(request).not.toHaveProperty('thinking');
    expect(request).not.toHaveProperty('temperature');
    expect(request.input[0].content[0]).toEqual(expect.objectContaining({
      type: 'input_text',
      text: expect.stringContaining('全量直播事实'),
    }));
    expect(request.input[0].content[0]).not.toHaveProperty('prompt_cache_breakpoint');
    expect(request.input[0].content[1]).toEqual({
      type: 'input_text',
      text: '\n当前任务规则',
    });
    expect(result.meta.attempts[result.meta.attempts.length - 1]).toEqual(expect.objectContaining({
      apiModeRequested: 'responses',
      apiModeUsed: 'responses',
      explicitPromptCache: 'prefix_routed',
      cachedTokens: 10000,
      cacheWriteTokens: 2000,
    }));
  });

  test('falls back to Chat Completions when the Responses protocol is rejected', async () => {
    const responsesConfig = structuredClone(config);
    responsesConfig.ai.text.daiYu.apiMode = 'responses';
    configLoader.getConfig.mockReturnValue(responsesConfig);
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'unsupported responses payload',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: { content: 'CHAT_FALLBACK_OK' },
            finish_reason: 'stop',
          }],
          usage: {},
        }),
      });

    const result = await generateTextWithDaiYu('只回复 CHAT_FALLBACK_OK');

    expect(result.text).toBe('CHAT_FALLBACK_OK');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/v1/responses');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8080/v1/chat/completions');
    const fallbackRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(fallbackRequest.messages[0]).toEqual({
      role: 'user',
      content: '只回复 CHAT_FALLBACK_OK',
    });
    expect(fallbackRequest.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 1024,
    });
    expect(result.meta.attempts[result.meta.attempts.length - 1]).toEqual(expect.objectContaining({
      apiModeRequested: 'responses',
      apiModeUsed: 'chatCompletions',
      apiModeFallbackReason: expect.stringContaining('HTTP 400'),
    }));
  });

  test('can isolate a one-shot structured task from configured fallback models', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'temporary failure',
    });

    await expect(generateTextWithDaiYu('只回复 JSON', {
      fallbackModelsEnabled: false,
    })).rejects.toThrow('gpt-5.6-luna');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('logs daiYu cache and token usage after a successful response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'LUNA_OK' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 10000,
          prompt_tokens_details: { cached_tokens: 8192, cache_write_tokens: 1024 },
          completion_tokens: 1200,
          completion_tokens_details: { reasoning_tokens: 800 },
          total_tokens: 11200,
        },
      }),
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await generateTextWithDaiYu('只回复 LUNA_OK');
      const usageLine = logSpy.mock.calls
        .map(call => String(call[0]))
        .find(line => line.startsWith('[AI_USAGE] '));

      expect(usageLine).toBeDefined();
      expect(JSON.parse(usageLine.slice('[AI_USAGE] '.length))).toEqual(expect.objectContaining({
        provider: 'daiYu',
        model: 'gpt-5.6-luna',
        promptTokens: 10000,
        cachedTokens: 8192,
        uncachedPromptTokens: 1808,
        cacheWriteTokens: 1024,
        completionTokens: 1200,
        reasoningTokens: 800,
        totalTokens: 11200,
        cacheHitRatio: 0.8192,
      }));
    } finally {
      logSpy.mockRestore();
    }
  });

  test('logs TuZi token usage with the same structured line', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'TUZI_OK' },
          finish_reason: 'stop',
        }],
        usage: {
          input_tokens: 4000,
          input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 500 },
          output_tokens: 300,
          output_tokens_details: { reasoning_tokens: 200 },
          total_tokens: 4300,
        },
      }),
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await generateTextWithTuZi('只回复 TUZI_OK', {
        primaryModel: 'qwen2.5-72b-instruct',
      });
      const usageLine = logSpy.mock.calls
        .map(call => String(call[0]))
        .find(line => line.startsWith('[AI_USAGE] '));

      expect(usageLine).toBeDefined();
      expect(JSON.parse(usageLine.slice('[AI_USAGE] '.length))).toEqual(expect.objectContaining({
        provider: 'tuZi',
        model: 'qwen2.5-72b-instruct',
        promptTokens: 4000,
        cachedTokens: 1000,
        uncachedPromptTokens: 3000,
        cacheWriteTokens: 500,
        completionTokens: 300,
        reasoningTokens: 200,
        totalTokens: 4300,
        cacheHitRatio: 0.25,
      }));
    } finally {
      logSpy.mockRestore();
    }
  });

  test('routes a legacy GPT-5 model from the tuZi compatibility entry to Luna', async () => {
    const result = await generateTextWithTuZi('只回复 LUNA_OK', {
      primaryModel: legacyModel,
    });

    expect(result.text).toBe('LUNA_OK');
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.model).toBe('gpt-5.6-luna');
  });
});
