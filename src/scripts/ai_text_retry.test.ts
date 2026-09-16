jest.mock('node-fetch', () => jest.fn());
jest.mock('./config-loader', () => ({
  getConfig: jest.fn(), getDaiYuApiKey: () => 'test-key', isDaiYuTextConfigured: () => true,
  getTuZiTextApiKey: () => 'test-key', isTuZiTextConfigured: () => true, getByPath: () => 100
}));

const fetchMock = require('node-fetch');
const loader = require('./config-loader');
const { generateTextWithDaiYu } = require('./ai_text_generator');
const options = { primaryModel: 'gpt-5.6-luna', apiMode: 'responses', fallbackModelsEnabled: false,
  daiYuTransientMaxAttempts: 2, transientRetryDelayMs: 0 };
const failure = status => ({ ok: false, status, headers: { get: () => `request-${status}` },
  text: async () => 'Upstream request failed' });
const success = { ok: true, status: 200, json: async () => ({ status: 'completed', output_text: 'Completed output',
  usage: { input_tokens: 100, output_tokens: 10 } }) };

describe('daiYu opt-in transient retries', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    loader.getConfig.mockReturnValue({ ai: { text: {
      daiYu: { baseUrl: 'http://localhost:8080', model: 'gpt-5.6-luna', apiMode: 'responses',
        fallbackModels: [], fallbackProvider: 'tuZi', fallbackProviderModel: 'gpt-5.6-luna' },
      tuZi: { baseUrl: 'https://fallback.test', model: 'gpt-5.6-luna', apiMode: 'responses', transientMaxAttempts: 1 }
    } } });
  });

  test('retries an explicit upstream 502 on daiYu before using another provider', async () => {
    fetchMock.mockResolvedValueOnce(failure(502)).mockResolvedValueOnce(success);
    const result = await generateTextWithDaiYu('Source facts', options);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:8080/v1/responses', 'http://localhost:8080/v1/responses'
    ]);
    expect(result.meta.attempts.map(attempt => [attempt.provider, attempt.status])).toEqual([
      ['daiYu', 'failure'], ['daiYu', 'success']
    ]);
    expect(result.meta.attempts[0]).toMatchObject({ httpStatus: 502, requestId: 'request-502', usageUnknown: true });
  });

  test('uses the original provider fallback after the bounded primary retries', async () => {
    fetchMock.mockResolvedValueOnce(failure(502)).mockResolvedValueOnce(failure(502)).mockResolvedValueOnce(success);
    const result = await generateTextWithDaiYu('Source facts', options);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:8080/v1/responses', 'http://localhost:8080/v1/responses', 'https://fallback.test/v1/responses'
    ]);
    expect(result.meta.attempts.map(attempt => attempt.provider)).toEqual(['daiYu', 'daiYu', 'tuZi']);
  });

  test.each([400, 401, 403])('does not repeat a non-transient HTTP %s error', async status => {
    fetchMock.mockResolvedValueOnce(failure(status));
    await expect(generateTextWithDaiYu('Source facts', { ...options, strictResponses: true,
      allowProviderFallback: false })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not resubmit a locally aborted request that may still run upstream', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }));
    await expect(generateTextWithDaiYu('Source facts', { ...options, allowProviderFallback: false })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('keeps strict evaluation to one request even when retries are requested', async () => {
    fetchMock.mockResolvedValueOnce(failure(502));
    await expect(generateTextWithDaiYu('Source facts', { ...options, strictEvaluation: true,
      maxTokens: 1000 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not retry after the request deadline expires', async () => {
    const deadlineAt = Date.now() + 10000;
    fetchMock.mockImplementationOnce(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(deadlineAt + 1);
      return failure(502);
    });
    try {
      await expect(generateTextWithDaiYu('Source facts', { ...options, deadlineAt })).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { jest.restoreAllMocks(); }
  });
});
