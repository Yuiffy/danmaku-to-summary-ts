const { createTextAttemptState, resetTextAttempt, recordFailedTextAttempt, summarizeTextAttempts } = require('./text_attempt_diagnostics');
const { hasIncompleteTextGeneration } = require('./text_attempt_diagnostics');
const completionCases = require('../../tests/fixtures/text-completion-states.json');

describe('text failure accounting', () => {
  test.each(completionCases)('shares the explicit completion-state contract: $metadata', ({ metadata, incomplete }) => {
    expect(hasIncompleteTextGeneration(metadata)).toBe(incomplete);
  });
  test('keeps known use for a completed but rejected response and records each HTTP attempt once', () => {
    const state = createTextAttemptState('responses');
    state.requestStarted = true;
    state.response = { status: 200, headers: { get: () => 'request-known' } };
    state.data = { id: 'response-known', model: 'same-model', usage: { input_tokens: 100, output_tokens: 25, total_tokens: ' ', totalTokens: 125 } };
    const attempts = [];
    recordFailedTextAttempt(attempts, 'daiYu', 'same-model', new Error('Empty final response'), state);
    recordFailedTextAttempt(attempts, 'daiYu', 'same-model', new Error('Repeated handling'), state);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'failure', requestStarted: true, usageUnknown: false,
      promptTokens: 100, completionTokens: 25, totalTokens: 125, requestId: 'request-known', responseId: 'response-known' });
    expect(attempts[0]).not.toHaveProperty('cachedTokens');
  });

  test('distinguishes no request, unknown upstream use and partial reported use', () => {
    const state = createTextAttemptState('responses');
    const attempts = [];
    recordFailedTextAttempt(attempts, 'daiYu', 'model', new Error('Deadline before fetch'), state);
    expect(attempts[0]).toMatchObject({ requestStarted: false, usageUnknown: false, promptTokens: 0, completionTokens: 0 });
    resetTextAttempt(state, 'responses');
    state.requestStarted = true;
    state.response = { status: 502, headers: { get: () => 'failed-http' } };
    recordFailedTextAttempt(attempts, 'daiYu', 'model', new Error('Upstream unavailable'), state);
    expect(attempts[1]).toMatchObject({ requestStarted: true, usageUnknown: true, httpStatus: 502, requestId: 'failed-http' });
    expect(attempts[1]).not.toHaveProperty('promptTokens');
    resetTextAttempt(state, 'chatCompletions');
    state.requestStarted = true;
    state.data = { usage: { input_tokens: 50 } };
    recordFailedTextAttempt(attempts, 'daiYu', 'model', new Error('Partial use'), state);
    expect(attempts[2]).toMatchObject({ apiModeUsed: 'chatCompletions', promptTokens: 50, usageUnknown: true });
    expect(attempts[2]).not.toHaveProperty('completionTokens');
  });

  test('aggregates every attempt without treating unknown costs as zero', () => {
    const summary = summarizeTextAttempts([
      { status: 'failure', requestStarted: true, usageUnknown: true },
      { status: 'failure', requestStarted: true, promptTokens: 100, completionTokens: 25, usageUnknown: false },
      { status: 'success', requestStarted: true, promptTokens: 200, completionTokens: 50 },
    ]);
    expect(summary).toMatchObject({ requestCount: 3, attemptCount: 3, usageUnknown: true,
      promptTokens: null, completionTokens: null, knownUsage: { promptTokens: 300, completionTokens: 75 } });
    expect(summarizeTextAttempts([])).toMatchObject({ requestCount: null, usageUnknown: true, promptTokens: null });
    expect(summarizeTextAttempts([null, {}])).toMatchObject({ usageUnknown: true, promptTokens: null });
    expect(summarizeTextAttempts([{ requestStarted: true, usageUnknown: true, usageFinal: false, promptTokens: 100, completionTokens: 5 }]))
      .toMatchObject({ usageUnknown: true, promptTokens: null, completionTokens: null, knownUsage: { promptTokens: 100, completionTokens: 5 } });
  });
});
