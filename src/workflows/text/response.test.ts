import { extractOpenAITextResponse, getOpenAITextFinishReason, TextResponse,
  getPromptTokenUsage, getCompletionTokenUsage, buildAiUsageMetrics, normalizeUsageMetric } from './response';

const message = (phase: string | null, text: string) => ({ type: 'message', role: 'assistant', phase,
  content: [{ type: 'output_text', text }] });

test.each([undefined, null, '', '  ', false, true, NaN, Infinity, -1, {}, []])('does not convert an unknown or invalid usage value into zero: %p', value => {
  expect(normalizeUsageMetric(value)).toBeNull();
});

test('retains valid numeric aliases, reported zero and partial usage', () => {
  expect(getPromptTokenUsage({ prompt_tokens: '', input_tokens: '150', cached_prompt_tokens: '0' }))
    .toEqual({ promptTokens: 150, cachedTokens: 0, cacheWriteTokens: undefined });
  expect(getCompletionTokenUsage({ completion_tokens: ' ', output_tokens: 0, reasoning_tokens: '5' }))
    .toEqual({ completionTokens: 0, reasoningTokens: 5 });
  expect(getPromptTokenUsage({ input_tokens: 'invalid' }).promptTokens).toBeUndefined();
});

test('retains comparable request fingerprints in cache usage logs without changing token accounting', () => {
  expect(buildAiUsageMetrics({ promptTokens: 10000, cachedTokens: 8000, completionTokens: 150,
    promptCacheRequestFingerprint: 'fingerprint', promptCacheRequestKey: 'live:source',
    promptCacheSourceBoundary: 'content_block', reasoningEffortSent: 'high', responseModel: 'gpt-5.6-luna' }))
    .toMatchObject({ promptTokens: 10000, cachedTokens: 8000, uncachedPromptTokens: 2000, completionTokens: 150,
      promptCacheRequestFingerprint: 'fingerprint', promptCacheRequestKey: 'live:source',
      promptCacheSourceBoundary: 'content_block', reasoningEffortSent: 'high', responseModel: 'gpt-5.6-luna' });
});

test('failure usage logs distinguish unknown use and never disguise it as success', () => {
  expect(buildAiUsageMetrics({ status: 'failure', requestStarted: true, httpStatus: 502, usageUnknown: true, requestId: 'failed-request' }))
    .toMatchObject({ status: 'failure', requestStarted: true, httpStatus: 502, usageUnknown: true,
      promptTokens: null, completionTokens: null, requestId: 'failed-request' });
  expect(buildAiUsageMetrics({ status: 'failure', requestStarted: true, usageUnknown: false, promptTokens: 100, completionTokens: 25 }))
    .toMatchObject({ usageUnknown: false, promptTokens: 100, completionTokens: 25 });
  expect(buildAiUsageMetrics({ status: 'success', promptTokens: 100, completionTokens: 25 })).not.toHaveProperty('status');
});

test('selects the final answer from the observed commentary/final response shape', () => {
  expect(extractOpenAITextResponse({ output: [message('commentary', 'PHASE_PROGRESS'),
    message('final_answer', 'PHASE_FINAL_OK')] })).toBe('PHASE_FINAL_OK');
});

test('finish status follows the final message and does not mistake earlier progress for unfinished final text', () => {
  const response = { output: [{ ...message('commentary', 'Progress'), status: 'in_progress' },
    { ...message('final_answer', 'Complete'), status: 'completed' }] };
  expect(getOpenAITextFinishReason(response)).toBe('completed');
  expect(getOpenAITextFinishReason({ ...response, status: 'in_progress' })).toBe('in_progress');
  expect(getOpenAITextFinishReason({ ...response, incomplete_details: { reason: 'max_output_tokens' } })).toBe('max_output_tokens');
});

test('explicit final messages take precedence over aggregated or compatibility text', () => {
  expect(extractOpenAITextResponse({ output_text: 'PHASE_PROGRESS\nPHASE_FINAL_OK',
    choices: [{ message: { content: 'Other aggregate' } }],
    output: [message('commentary', 'PHASE_PROGRESS'), message('final_answer', 'PHASE_FINAL_OK')] }))
    .toBe('PHASE_FINAL_OK');
});

test('retains all final content parts and does not strip legitimate first-person text', () => {
  expect(extractOpenAITextResponse({ output: [message('final_answer', 'I will first quote the source.'),
    message('commentary', 'Progress'), message('final_answer', 'The second part.')] }))
    .toBe('I will first quote the source.\nThe second part.');
});

test('never treats commentary as a final answer when the final output is absent or refused', () => {
  const progress = message('commentary', 'Still working');
  expect(extractOpenAITextResponse({ output_text: 'Still working', output: [progress] })).toBe('');
  expect(extractOpenAITextResponse({ output_text: 'Still working', output: [progress, {
    type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'refusal', refusal: 'Unavailable' }]
  }] })).toBe('');
});

test('supports a legacy unphased final message beside an explicit progress message', () => {
  expect(extractOpenAITextResponse({ output: [message('commentary', 'Progress'), message(null, 'Legacy final')] }))
    .toBe('Legacy final');
});

test('preserves legacy response and Chat Completions extraction without phase metadata', () => {
  expect(extractOpenAITextResponse({ output: [message(null, 'Part one'), message(null, 'Part two')] }))
    .toBe('Part one\nPart two');
  expect(extractOpenAITextResponse({ output_text: 'Aggregate', output: [message(null, 'Other')] })).toBe('Aggregate');
  expect(extractOpenAITextResponse({ choices: [{ message: { content: 'Chat' } }] })).toBe('Chat');
});

test('does not publish a non-assistant message marked as final', () => {
  expect(extractOpenAITextResponse({ output: [{ ...message('final_answer', 'Input'), role: 'user' },
    message('commentary', 'Progress')] })).toBe('');
});

test.each([{}, 'unexpected', 1, false, null])('handles non-array output without breaking legacy fields (%p)', output => {
  const response = { output_text: 'Valid final', output } as unknown as TextResponse;
  expect(extractOpenAITextResponse(response)).toBe('Valid final');
  expect(getOpenAITextFinishReason(response)).toBeNull();
  expect(getOpenAITextFinishReason({ ...response, status: 'completed' })).toBe('completed');
});

test('does not treat invalid false-valued roles or phases as an omitted field', () => {
  const progress = message('commentary', 'Progress');
  expect(extractOpenAITextResponse({ output: [progress, { ...message('final_answer', 'Invalid'), role: false }] })).toBe('');
  expect(extractOpenAITextResponse({ output: [progress, { ...message(null, 'Invalid'), phase: false }] })).toBe('');
});
