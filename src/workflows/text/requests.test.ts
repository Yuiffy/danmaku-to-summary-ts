import { buildDaiYuResponsesRequest, buildDaiYuChatCompletionsRequest, LIVE_TEXT_SYSTEM_PROMPT, TEXT_REQUEST_PROTOCOL_VERSION } from './requests';
const { getExplicitPromptCachePlan } = require('../../scripts/text_generation_protocol');
const context = require('../../scripts/live_generation_context');

test('selected cache routing preserves the existing role and full source without unsupported Responses fields', () => {
  const prompt = `${context.SHARED_PROMPT_CACHE_START}\nExact source facts.\n${context.SHARED_PROMPT_CACHE_END}\nTask instructions.`;
  const config = { ai: { text: { sharedPromptCache: { enabled: true, explicitRolloutPercent: 0 } } } };
  const selected = getExplicitPromptCachePlan(prompt, config, 'gpt-5.6-luna', 100);
  const options = { model: 'gpt-5.6-luna', prompt, maxTokens: 100000, thinkingEnabled: true, reasoningEffort: 'high' };
  const second = buildDaiYuResponsesRequest({ ...options, cachePlan: selected });
  expect(second.instructions).toBe(LIVE_TEXT_SYSTEM_PROMPT);
  expect(second.input[0].content.map(part => part.text).join('')).toBe(prompt);
  expect(second).toHaveProperty('prompt_cache_key');
  expect(second).not.toHaveProperty('prompt_cache_options');
  expect(JSON.stringify(second.input)).not.toContain('prompt_cache_breakpoint');
  expect(second.reasoning).toEqual({ effort: 'high' });
  expect(second.max_output_tokens).toBe(100000);
});

test('preserves the uncached request role and payload after the unsuccessful role experiment', () => {
  const options = { model: 'gpt-5.6-luna', prompt: 'An ordinary clip task.', maxTokens: 100000,
    thinkingEnabled: true, reasoningEffort: 'high', thinkingBudgetTokens: 10000 };
  const responses = buildDaiYuResponsesRequest(options);
  expect(responses).toEqual({ model: options.model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: options.prompt }] }],
    max_output_tokens: 100000, stream: false, store: false, reasoning: { effort: 'high' } });
  const chat = buildDaiYuChatCompletionsRequest(options);
  expect(chat.messages).toEqual([{ role: 'user', content: options.prompt }]);
  expect(chat.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
  expect(TEXT_REQUEST_PROTOCOL_VERSION).toBe(5);
});

test('implicit routing preserves the original input layout and task role outside explicit rollout', () => {
    const prompt = `${context.SHARED_PROMPT_CACHE_START}\nExact facts.\n${context.SHARED_PROMPT_CACHE_END}\nTask.`;
    const cachePlan = getExplicitPromptCachePlan(prompt, {}, 'gpt-5.6-luna', 0);
    expect(cachePlan.enabled).toBe(false);
    expect(cachePlan).not.toHaveProperty('prefix');
    const body = buildDaiYuResponsesRequest({ model: 'gpt-5.6-luna', prompt, maxTokens: 1000, cachePlan });
    expect(body).not.toHaveProperty('instructions');
    expect(body.prompt_cache_key).toMatch(/^live:[a-f0-9]{48}$/u);
    expect(body).not.toHaveProperty('prompt_cache_options');
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]);
    const chat = buildDaiYuChatCompletionsRequest({ model: 'gpt-5.6-luna', prompt, maxTokens: 1000, cachePlan });
    expect(chat.messages).toEqual([{ role: 'user', content: prompt }]);
    expect(chat).not.toHaveProperty('prompt_cache_key');
});

test.each(['disabled', 'unsupported', 'no-prefix'])('does not add a route or split when %s', mode => {
  const prompt = mode === 'no-prefix' ? 'Ordinary task.'
    : `${context.SHARED_PROMPT_CACHE_START}\nExact facts.\n${context.SHARED_PROMPT_CACHE_END}\nTask.`;
  const model = mode === 'unsupported' ? 'unsupported-model' : 'gpt-5.6-luna';
  const config = { ai: { text: { sharedPromptCache: { enabled: mode !== 'disabled' } } } };
  const cachePlan = getExplicitPromptCachePlan(prompt, config, model, 0);
  const body = buildDaiYuResponsesRequest({ model, prompt, maxTokens: 1000, cachePlan });
  expect(body).not.toHaveProperty('prompt_cache_key');
  expect(body).not.toHaveProperty('instructions');
  expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]);
});

test('different task suffixes keep the same implicit prefix and route without adding a system role', () => {
  const prefix = `${context.SHARED_PROMPT_CACHE_START}\nExact shared facts.\n${context.SHARED_PROMPT_CACHE_END}`;
  const bodies = ['Goodnight task.', 'Comic task.'].map(task => {
    const prompt = prefix + '\n\n' + task;
    const cachePlan = getExplicitPromptCachePlan(prompt, {}, 'gpt-5.6-luna', 0);
    return buildDaiYuResponsesRequest({ model: 'gpt-5.6-luna', prompt, cachePlan, maxTokens: 100000,
      thinkingEnabled: true, reasoningEffort: 'high' });
  });
  expect(bodies[0].prompt_cache_key).toBe(bodies[1].prompt_cache_key);
  expect(bodies[0].input).not.toEqual(bodies[1].input);
  bodies.forEach(body => {
    expect(body.input[0].content).toHaveLength(1);
    expect(body.input[0].content[0].text.startsWith(prefix + '\n\n')).toBe(true);
    expect(body).not.toHaveProperty('instructions');
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.max_output_tokens).toBe(100000);
  });
});

test.each(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra'])('forwards max without silently downgrading %s', model => {
  const body = buildDaiYuResponsesRequest({ model, prompt: 'Review the clip.', maxTokens: 16000,
    thinkingEnabled: true, reasoningEffort: 'max' });
  expect(body.reasoning).toEqual({ effort: 'max' });
});
