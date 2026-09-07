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

  test.each(['daiYu', 'tuZi'])('%s strict evaluation sends exactly one requested model/protocol/effort', async provider => {
    const generate = provider === 'daiYu' ? generateTextWithDaiYu : generateTextWithTuZi;
    const image = 'data:image/png;base64,YQ==';
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      status: 'completed', model: 'gpt-6-astra', output_text: 'COMPLETE', usage: { input_tokens: 5, output_tokens: 10 } }) });
    await generate('Facts', { primaryModel: 'gpt-6-astra', reasoningEffort: 'low', apiMode: 'responses',
      strictEvaluation: true, maxTokens: 1234, images: [image] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: 'gpt-6-astra', reasoning: { effort: 'low' }, max_output_tokens: 1234 });
    expect(body.input[0].content[1].image_url).toBe(image);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('strict evaluation does not retry rejected cache hints or fall back protocols/providers', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'unsupported prompt_cache_key' });
    const prompt = `${liveGenerationContext.SHARED_PROMPT_CACHE_START}\nFacts\n${liveGenerationContext.SHARED_PROMPT_CACHE_END}\nTask`;
    await expect(generateTextWithDaiYu(prompt, { strictEvaluation: true, primaryModel: 'gpt-5.6-luna',
      reasoningEffort: 'high', maxTokens: 100, apiMode: 'responses' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each(['daiYu', 'tuZi'])('%s retains reported usage when final text is empty, truncated or too short', async provider => {
    const generate = provider === 'daiYu' ? generateTextWithDaiYu : generateTextWithTuZi;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      for (const kind of ['empty', 'truncated', 'short', 'nonterminal', 'failed']) {
        fetchMock.mockReset();
        log.mockClear();
        const data = { id: 'rejected-response', model: 'gpt-5.6-luna',
          usage: { input_tokens: 100, output_tokens: 25, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 125 },
          ...(kind === 'empty' ? { status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'commentary',
            content: [{ type: 'output_text', text: 'Still working' }] }] }
            : kind === 'truncated' ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: 'Partial output' }
              : kind === 'nonterminal' ? { status: 'in_progress', output_text: 'Partial output' }
                : kind === 'failed' ? { status: 'failed', output_text: 'Partial output' }
                  : { status: 'completed', output_text: 'X' }) };
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'rejected-request' }, json: async () => data });
        let failure;
        try {
          await generate('Source text.', { primaryModel: 'gpt-5.6-luna', exactModel: true, apiMode: 'responses', strictResponses: true,
            fallbackModelsEnabled: false, allowProviderFallback: false, transientMaxAttempts: 1, minOutputChars: kind === 'short' ? 10 : undefined });
        } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(failure.attempts.at(-1)).toMatchObject({ provider, status: 'failure', requestStarted: true, usageUnknown: kind === 'nonterminal',
          promptTokens: 100, completionTokens: 25, reasoningTokens: 20, totalTokens: 125,
          httpStatus: 200, requestId: 'rejected-request', responseId: 'rejected-response' });
        const usageLine = log.mock.calls.map(([line]) => String(line)).find(line => line.startsWith('[AI_USAGE] '));
        expect(JSON.parse(usageLine.slice('[AI_USAGE] '.length))).toMatchObject({ status: 'failure', usageUnknown: kind === 'nonterminal',
          promptTokens: 100, completionTokens: 25 });
      }
    } finally { log.mockRestore(); }
  });

  test.each(['daiYu', 'tuZi'])('%s preserves an HTTP failure ID and distinguishes it from a local deadline', async provider => {
    const generate = provider === 'daiYu' ? generateTextWithDaiYu : generateTextWithTuZi;
    const options = { primaryModel: 'gpt-5.6-luna', exactModel: true, apiMode: 'responses', strictResponses: true,
      fallbackModelsEnabled: false, allowProviderFallback: false, transientMaxAttempts: 1 };
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, headers: { get: () => 'failed-http' }, text: async () => 'Upstream unavailable' });
    let failure;
    try { await generate('Source.', options); } catch (error) { failure = error; }
    expect(failure.attempts.at(-1)).toMatchObject({ requestStarted: true, usageUnknown: true, httpStatus: 502, requestId: 'failed-http' });
    expect(failure.attempts.at(-1)).not.toHaveProperty('promptTokens');
    fetchMock.mockClear();
    try { await generate('Source.', { ...options, deadlineAt: Date.now() - 1 }); } catch (error) { failure = error; }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(failure.attempts.at(-1)).toMatchObject({ requestStarted: false, usageUnknown: false, promptTokens: 0, completionTokens: 0 });
  });

  test('records the first HTTP request when Responses compatibility falls back to Chat', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, headers: { get: () => 'responses-failed' }, text: async () => 'Unsupported responses payload' })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'chat-success' }, json: async () => ({
        id: 'chat-result', choices: [{ finish_reason: 'stop', message: { content: 'COMPAT_OK' } }], usage: { prompt_tokens: 80, completion_tokens: 7 } }) });
    const result = await generateTextWithDaiYu('Source.', { apiMode: 'responses', fallbackModelsEnabled: false, allowProviderFallback: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.meta.attempts).toHaveLength(2);
    expect(result.meta.attempts[0]).toMatchObject({ status: 'failure', stage: 'responses_compatibility',
      requestId: 'responses-failed', requestStarted: true, usageUnknown: true, httpStatus: 400 });
    expect(result.meta.attempts[1]).toMatchObject({ status: 'success', apiModeUsed: 'chatCompletions',
      requestStarted: true, requestId: 'chat-success', promptTokens: 80, completionTokens: 7 });
  });

  test('an explicitly pending response does not start another model or provider request', async () => {
    const pendingConfig = structuredClone(config);
    pendingConfig.ai.text.daiYu.fallbackModels = ['gpt-5.6-sol'];
    pendingConfig.ai.text.daiYu.fallbackProvider = 'tuZi';
    configLoader.getConfig.mockReturnValue(pendingConfig);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'pending-request' },
      json: async () => ({ id: 'pending-response', status: 'in_progress', output_text: 'Partial result', usage: { input_tokens: 100, output_tokens: 5 } }) });
    let failure;
    try { await generateTextWithDaiYu('Source.', { apiMode: 'responses' }); } catch (error) { failure = error; }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failure.attempts[0]).toMatchObject({ outcomeUnknown: true, usageUnknown: true, usageFinal: false,
      requestId: 'pending-request', responseId: 'pending-response', promptTokens: 100, completionTokens: 5 });
  });

  test('routes a declared static prefix without adding a role, splitting content or changing task text', async () => {
    const prefix = 'Task instructions.\n';
    const result = await generateTextWithDaiYu(prefix + 'First source.', { staticPromptCachePrefix: prefix,
      apiMode: 'responses', promptCacheRolloutPercent: 100 });
    await generateTextWithDaiYu(prefix + 'Second source.', { staticPromptCachePrefix: prefix,
      apiMode: 'responses', promptCacheRolloutPercent: 0 });
    const bodies = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(bodies[0].prompt_cache_key).toMatch(/^task:/);
    expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key);
    bodies.forEach((body, index) => {
      expect(body.instructions).toBeUndefined();
      expect(body.prompt_cache_options).toBeUndefined();
      expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: prefix + (index ? 'Second source.' : 'First source.') }] }]);
    });
    expect(result.meta.attempts.at(-1)).toMatchObject({ explicitPromptCache: 'implicit_routed',
      staticPromptPrefixChars: prefix.length, promptCacheRequestKey: bodies[0].prompt_cache_key });
  });

  test('static cache hint rejection retries the same request without changing its input', async () => {
    const prefix = 'Static task rules.\n';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400,
      text: async () => JSON.stringify({ error: { param: 'prompt_cache_key', message: 'Unsupported' } })
    }).mockResolvedValueOnce({ ok: true, status: 200,
      json: async () => ({ output_text: 'STATIC_OK', status: 'completed', usage: {} }) });
    const result = await generateTextWithDaiYu(prefix + 'Source.', { staticPromptCachePrefix: prefix,
      apiMode: 'responses', strictResponses: true, fallbackModelsEnabled: false, allowProviderFallback: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body), second = JSON.parse(fetchMock.mock.calls[1][1].body);
    const { prompt_cache_key, ...plain } = first;
    expect(second).toEqual(plain);
    expect(result.text).toBe('STATIC_OK');
    expect(result.meta.attempts[0]).toMatchObject({ usageUnknown: true, stage: 'prompt_cache_compatibility' });
    expect(result.meta.attempts.at(-1)).toMatchObject({ promptCacheRequestKey: null, explicitPromptCache: 'rejected' });
  });

  test('returns only final text while retaining the complete provider token usage', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [
      { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'PHASE_PROGRESS' }] },
      { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'PHASE_FINAL_OK' }] }
    ], usage: { input_tokens: 50, output_tokens: 18 } }) });
    const result = await generateTextWithDaiYu('Protocol test.', { apiMode: 'responses' });
    expect(result.text).toBe('PHASE_FINAL_OK');
    expect(result.meta.attempts[0].completionTokens).toBe(18);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([[0, 400], [100, 400], [0, 422], [100, 422]])('cache rejection at rollout %s / HTTP %s preserves Responses input, role and model', async (rollout, status) => {
    const routedConfig = structuredClone(config);
    routedConfig.ai.text['sharedPromptCache'] = { enabled: true, explicitRolloutPercent: rollout };
    configLoader.getConfig.mockReturnValue(routedConfig);
    const prompt = `${liveGenerationContext.SHARED_PROMPT_CACHE_START}\nSource facts.\n${liveGenerationContext.SHARED_PROMPT_CACHE_END}\nTask.`;
    fetchMock.mockResolvedValueOnce({ ok: false, status,
      headers: { get: () => 'cache-rejection-request' },
      text: async () => JSON.stringify({ error: { param: 'prompt_cache_key', message: 'Unsupported parameter' } })
    }).mockResolvedValueOnce({ ok: true, status: 200,
      json: async () => ({ status: 'completed', output_text: 'CACHE_RETRY_OK', usage: { input_tokens: 40, output_tokens: 7 } }) });
    const result = await generateTextWithDaiYu(prompt, { apiMode: 'responses', strictResponses: true,
      fallbackModelsEnabled: false, allowProviderFallback: false, promptCacheRolloutPercent: rollout });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(call => call[0].endsWith('/v1/responses'))).toBe(true);
    const before = JSON.parse(fetchMock.mock.calls[0][1].body);
    const after = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(before.prompt_cache_key).toMatch(/^live:/);
    const { prompt_cache_key, ...expected } = before;
    expect(after).toEqual(expected);
    expect(result.text).toBe('CACHE_RETRY_OK');
    expect(result.meta.attempts[0]).toMatchObject({ stage: 'prompt_cache_compatibility', status: 'failure', usageUnknown: true });
    expect(result.meta.attempts[0]).not.toHaveProperty('promptTokens');
    expect(result.meta.attempts.at(-1)).toMatchObject({ apiModeUsed: 'responses', explicitPromptCache: 'rejected', completionTokens: 7 });
  });

  test('Chat cache rejection strips hints without removing its explicit system role', async () => {
    const routedConfig = structuredClone(config);
    routedConfig.ai.text['sharedPromptCache'] = { enabled: true, explicitRolloutPercent: 100 };
    configLoader.getConfig.mockReturnValue(routedConfig);
    const prompt = `${liveGenerationContext.SHARED_PROMPT_CACHE_START}\nSource facts.\n${liveGenerationContext.SHARED_PROMPT_CACHE_END}\nTask.`;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400,
      text: async () => JSON.stringify({ error: { param: 'messages[1].content[0].prompt_cache_breakpoint' } })
    }).mockResolvedValueOnce({ ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'CHAT_CACHE_OK' }, finish_reason: 'stop' }], usage: {} }) });
    await generateTextWithDaiYu(prompt, { apiMode: 'chatCompletions', fallbackModelsEnabled: false, allowProviderFallback: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const before = JSON.parse(fetchMock.mock.calls[0][1].body);
    const after = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(after.messages[0]).toEqual(before.messages[0]);
    expect(after.messages[0].role).toBe('system');
    expect(after.messages[1].content.map(part => part.text).join('')).toBe(prompt);
    expect(after.messages[1].content.every(part => !part.prompt_cache_breakpoint)).toBe(true);
    expect(after.model).toBe(before.model);
    expect(after.thinking).toEqual(before.thinking);
    expect(after).not.toHaveProperty('prompt_cache_key');
    expect(after).not.toHaveProperty('prompt_cache_options');
  });

  test('does not mask an unrelated error or consume its body twice when routing is enabled', async () => {
    const prompt = `${liveGenerationContext.SHARED_PROMPT_CACHE_START}\nFacts.\n${liveGenerationContext.SHARED_PROMPT_CACHE_END}\nTask.`;
    const text = jest.fn().mockResolvedValue(JSON.stringify({ error: { param: 'model', message: 'Unknown model' } }));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text });
    await expect(generateTextWithDaiYu(prompt, { apiMode: 'responses', strictResponses: true,
      fallbackModelsEnabled: false, allowProviderFallback: false })).rejects.toThrow('Unknown model');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledTimes(1);
  });

  test('cache compatibility fallback cannot issue a request after the shared deadline', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const prompt = `${liveGenerationContext.SHARED_PROMPT_CACHE_START}\nFacts.\n${liveGenerationContext.SHARED_PROMPT_CACHE_END}\nTask.`;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => {
      now.mockReturnValue(1200);
      return JSON.stringify({ error: { param: 'prompt_cache_key', message: 'Unsupported' } });
    } });
    try {
      await expect(generateTextWithDaiYu(prompt, { apiMode: 'responses', deadlineAt: 1100,
        fallbackModelsEnabled: false, allowProviderFallback: false })).rejects.toThrow('deadline');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { now.mockRestore(); }
  });

  test.each(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra'])('preserves an exact %s max request and its audit metadata', async model => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ model,
      reasoning: { effort: 'max' }, status: 'completed', output_text: '{"ok":true}', usage: {} }) });
    const result = await generateTextWithDaiYu('Return JSON.', { primaryModel: model, exactModel: true,
      reasoningEffort: 'max', apiMode: 'responses', strictResponses: true, fallbackModelsEnabled: false,
      allowProviderFallback: false });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model, reasoning: { effort: 'max' } });
    expect(result.meta.attempts[0]).toMatchObject({ model, responseModel: model,
      reasoningEffortSent: 'max', reasoningEffortReturned: 'max' });
  });

  test('a strict Responses request never falls back to chat or another provider', async () => {
    const strictConfig = structuredClone(config);
    strictConfig.ai.text.daiYu.fallbackProvider = 'tuZi';
    configLoader.getConfig.mockReturnValue(strictConfig);
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'unsupported max' });
    await expect(generateTextWithDaiYu('Return JSON.', { primaryModel: 'gpt-5.6-sol', exactModel: true,
      reasoningEffort: 'max', apiMode: 'responses', strictResponses: true,
      fallbackModelsEnabled: false, allowProviderFallback: false })).rejects.toThrow('unsupported max');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/responses');
  });

  test('does not send another request after the shared text deadline expires', async () => {
    await expect(generateTextWithDaiYu('test', { deadlineAt: Date.now() - 1 }))
      .rejects.toMatchObject({ attempts: [expect.objectContaining({ status: 'failure', error: expect.stringContaining('deadline') })] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('bounds requests by the remaining deadline and preserves minimum script length', async () => {
    const deadlineAt = Date.now() + 3000;
    await expect(generateTextWithDaiYu('test', { deadlineAt, timeoutMs: 120000, minOutputChars: 40 }))
      .rejects.toThrow('shorter than 40');
    expect(fetchMock.mock.calls[0][1].timeout).toBeLessThanOrEqual(3000);
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
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
    }));
    expect(request).not.toHaveProperty('messages');
    expect(request).not.toHaveProperty('prompt_cache_options');
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
      explicitPromptCache: 'implicit_routed',
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

  test('falls back from daiYu to tuZi using Luna over Responses', async () => {
    const fallbackConfig = structuredClone(config);
    fallbackConfig.ai.text.daiYu.fallbackModels = [];
    fallbackConfig.ai.text.daiYu.fallbackProvider = 'tuZi';
    fallbackConfig.ai.text.daiYu.fallbackProviderModel = 'gpt-5.6-luna';
    fallbackConfig.ai.text.tuZi = {
      enabled: true,
      baseUrl: 'https://api.tu-zi.com',
      model: 'gpt-5.6-luna',
      fallbackModels: [],
      includeBuiltInFallbackModels: false,
      apiMode: 'responses',
      transientMaxAttempts: 1,
      maxTokens: 1000,
    };
    configLoader.getConfig.mockReturnValue(fallbackConfig);
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => 'upstream temporarily unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'completed',
          output: [{
            type: 'message',
            content: [{ type: 'output_text', text: 'TUZI_LUNA_OK' }],
          }],
          usage: {},
        }),
      });

    const result = await generateTextWithDaiYu('只回复 TUZI_LUNA_OK', {
      fallbackModelsEnabled: false,
    });

    expect(result.text).toBe('TUZI_LUNA_OK');
    expect(result.meta.provider).toBe('tuZi');
    expect(result.meta.fallback).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.tu-zi.com/v1/responses');
    const fallbackRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(fallbackRequest.model).toBe('gpt-5.6-luna');
    expect(fallbackRequest.input).toBe('只回复 TUZI_LUNA_OK');
    expect(result.meta.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'daiYu', status: 'failure' }),
      expect.objectContaining({ provider: 'tuZi', model: 'gpt-5.6-luna', status: 'success' }),
    ]));
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

  test('sends Luna directly through tuZi without routing back to daiYu', async () => {
    const result = await generateTextWithTuZi('只回复 LUNA_OK', {
      primaryModel: legacyModel,
    });

    expect(result.text).toBe('LUNA_OK');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.tu-zi.com/v1/chat/completions');
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.model).toBe('gpt-5.6-luna');
  });
});
