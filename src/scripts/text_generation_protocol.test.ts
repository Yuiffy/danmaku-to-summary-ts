const { isPromptCacheParameterError, withoutPromptCacheHints, getExplicitPromptCachePlan } = require('./text_generation_protocol');
const liveContext = require('./live_generation_context');
const { buildDaiYuResponsesRequest } = require('./workflow-runtime').loadWorkflow('text/requests');

test.each([0, 100])('static task routing never changes role or input layout at explicit rollout %s', rollout => {
  const prefix = 'Task rules.\n';
  const plan = getExplicitPromptCachePlan(prefix + 'Source A.', {}, 'gpt-5.6-luna', rollout, prefix);
  expect(plan.enabled).toBe(false);
  expect(plan.requestKey).toMatch(/^task:[a-f0-9]{48}$/);
  expect(plan.staticPromptPrefixChars).toBe(prefix.length);
  const options = { model: 'gpt-5.6-luna', prompt: prefix + 'Source A.', maxTokens: 100000, thinkingEnabled: true, reasoningEffort: 'high' };
  const routed = buildDaiYuResponsesRequest({ ...options, cachePlan: plan });
  const { prompt_cache_key, ...rest } = routed;
  expect(prompt_cache_key).toBe(plan.requestKey);
  expect(rest).toEqual(buildDaiYuResponsesRequest(options));
  expect(getExplicitPromptCachePlan(prefix + 'Source B.', {}, 'gpt-5.6-luna', rollout, prefix).requestKey).toBe(plan.requestKey);
  expect(getExplicitPromptCachePlan('Other rules.\nSource A.', {}, 'gpt-5.6-luna', rollout, 'Other rules.\n').requestKey).not.toBe(plan.requestKey);
});

test.each(['disabled', 'unsupported', 'mismatch', 'empty', 'whitespace'])('static routing is omitted for %s', mode => {
  const prompt = '   Task rules.\nSource.';
  const prefix = mode === 'mismatch' ? 'Different.' : mode === 'empty' ? '' : mode === 'whitespace' ? '   ' : '   Task rules.\n';
  const config = { ai: { text: { sharedPromptCache: { enabled: mode !== 'disabled' } } } };
  const model = mode === 'unsupported' ? 'other-model' : 'gpt-5.6-luna';
  expect(getExplicitPromptCachePlan(prompt, config, model, 100, prefix)).toEqual(getExplicitPromptCachePlan(prompt, config, model, 100));
});

test('an existing shared-fact prefix retains its original route and explicit role policy', () => {
  const prompt = `${liveContext.SHARED_PROMPT_CACHE_START}\nSource facts.\n${liveContext.SHARED_PROMPT_CACHE_END}\nTask.`;
  for (const rollout of [0, 100]) {
    expect(getExplicitPromptCachePlan(prompt, {}, 'gpt-5.6-luna', rollout, prompt.slice(0, 12)))
      .toEqual(getExplicitPromptCachePlan(prompt, {}, 'gpt-5.6-luna', rollout));
  }
});

test('identifies optional cache parameters without masking other parameter errors', () => {
  expect(isPromptCacheParameterError(JSON.stringify({ error: { param: 'input[0].content[0].prompt_cache_breakpoint' } }))).toBe(true);
  expect(isPromptCacheParameterError(JSON.stringify({ error: { param: 'prompt_cache_options.mode' } }))).toBe(true);
  expect(isPromptCacheParameterError('Unsupported parameter: prompt_cache_key')).toBe(true);
  expect(isPromptCacheParameterError(JSON.stringify({ error: { param: 'model', message: 'Invalid request using prompt_cache_key' } }))).toBe(false);
  expect(isPromptCacheParameterError('Quota exhausted while using prompt_cache_key')).toBe(false);
});

test.each(['input', 'messages'])('removes cache hints only and preserves %s, roles and media', key => {
  const part = { type: 'text', text: 'Keep the literal prompt_cache_key wording.', prompt_cache_breakpoint: { mode: 'explicit' } };
  const media = { type: 'image_url', image_url: { url: 'unchanged-image' } };
  const body = { model: 'same-model', instructions: 'Same role', reasoning: { effort: 'high' },
    prompt_cache_key: 'route', prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    [key]: [{ role: 'system', content: 'System role' }, { role: 'user', content: [part, media] }] };
  const plain = withoutPromptCacheHints(body);
  expect(plain).not.toHaveProperty('prompt_cache_key');
  expect(plain).not.toHaveProperty('prompt_cache_options');
  expect(plain.instructions).toBe(body.instructions);
  expect(plain.reasoning).toEqual(body.reasoning);
  expect(plain[key]).toEqual([{ role: 'system', content: 'System role' },
    { role: 'user', content: [{ type: 'text', text: part.text }, media] }]);
  expect(body[key][1].content[0]).toBe(part);
  expect(part).toHaveProperty('prompt_cache_breakpoint');
});
