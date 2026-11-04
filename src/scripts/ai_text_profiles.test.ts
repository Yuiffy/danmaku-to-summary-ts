export {};
jest.mock('node-fetch', () => jest.fn());
jest.mock('./config-loader', () => ({ getConfig: jest.fn(), getDaiYuApiKey: () => 'daiyu-key',
    isDaiYuTextConfigured: () => true, getZaiTextApiKey: () => 'zai-key', isZaiTextConfigured: () => true,
    getDeepSeekTextApiKey: () => 'deepseek-key', isDeepSeekTextConfigured: () => true,
    getTuZiTextApiKey: () => 'tuzi-key', isTuZiTextConfigured: () => true, getByPath: () => 100 }));
const fetch = require('node-fetch');
const loader = require('./config-loader');
const generator = require('./ai_text_generator');
const profiles = require('./workflow-runtime').loadWorkflow('text/profiles');
const preflight = require('./clipping/preflight_runner');
const root = { ai: { text: { defaultProfile: 'flash', profiles: profiles.DEFAULT_TEXT_PROFILES,
    daiYu: { model: 'gpt-6-luna', baseUrl: 'http://localhost:8080', thinking: { reasoningEffort: 'high' } },
    zai: { baseUrl: 'https://example.invalid/zai', model: 'glm-5.3-flash' },
    deepSeek: { baseUrl: 'https://example.invalid/deepseek/v1' },
    tuZi: { model: 'gpt-6-luna', apiMode: 'responses' } } }, timeouts: { aiApiTimeout: 5000 } };
const fail = () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => 'unavailable' });
const chat = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"clips":[]}' }, finish_reason: 'stop' }], usage: {} }) });

beforeEach(() => { fetch.mockReset(); loader.getConfig.mockReturnValue(root); });

test('pro sends the exact requested models in order and its DeepSeek success passes preflight validation', async () => {
    fetch.mockResolvedValueOnce(fail()).mockResolvedValueOnce(fail()).mockResolvedValueOnce(chat());
    const settings = preflight.preflightRequestOptions({ review: { modelProfile: 'pro', reasoningEffort: 'high' } }, root);
    const result = await generator.generateTextWithDaiYu('Return source-bound clips.', settings);
    expect(fetch.mock.calls.map(call => JSON.parse(call[1].body).model)).toEqual(['gpt-6.1-sol', 'glm-5.3', 'deepseek-flash']);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['http://localhost:8080/v1/responses',
        'https://example.invalid/zai/chat/completions', 'https://example.invalid/deepseek/v1/chat/completions']);
    expect(result.meta.attempts.map(attempt => attempt.provider)).toEqual(['daiYu', 'zai', 'deepSeek']);
    expect(preflight.requestMatches(result, settings)).toBe(true);
    expect(preflight.requestMatches({ ...result, meta: { ...result.meta,
        attempts: [{ provider: 'tuZi', model: 'gpt-6-luna', status: 'success', apiModeUsed: 'responses' }] } }, settings)).toBe(false);
});

test('default flash keeps the luna/GLM flash/DeepSeek/luna chain', async () => {
    fetch.mockResolvedValueOnce(fail()).mockResolvedValueOnce(fail()).mockResolvedValueOnce(fail())
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'completed', output_text: 'Complete response.', usage: {} }) });
    const result = await generator.generateTextWithDaiYu('Facts.');
    expect(fetch.mock.calls.map(call => JSON.parse(call[1].body).model))
        .toEqual(['gpt-6-luna', 'glm-5.3-flash', 'deepseek-flash', 'gpt-6-luna']);
    expect(result.meta).toMatchObject({ modelProfile: 'flash', provider: 'tuZi', fallback: true });
});

test('a strict pinned stage stays pinned; explicit pro exhaustion never appends luna or tuZi', async () => {
    fetch.mockResolvedValue(fail());
    await expect(generator.generateTextWithDaiYu('Facts.', { strictEvaluation: true, primaryModel: 'gpt-6-luna', apiMode: 'responses' })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    await expect(generator.generateTextWithDaiYu('Facts.', { modelProfile: 'pro' })).rejects.toThrow('profile exhausted');
    expect(fetch.mock.calls.map(call => JSON.parse(call[1].body).model)).toEqual(['gpt-6.1-sol', 'glm-5.3', 'deepseek-flash']);
});

test('pending Sol output prevents a second provider request', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'in_progress', id: 'pending' }) });
    await expect(generator.generateTextWithDaiYu('Facts.', { modelProfile: 'pro' })).rejects.toMatchObject({ outcomeUnknown: true });
    expect(fetch).toHaveBeenCalledTimes(1);
});

test('flash fallback receives the same shared comic envelope as the primary request', async () => {
    fetch.mockResolvedValueOnce(fail()).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ result: { task: 'comic', payload: 'Complete comic script.' } }) } }], usage: {} }) });
    const result = await generator.generateTextWithDaiYu('Original source and task.', { sharedOutputTask: 'comic' });
    expect(result.text).toBe('Complete comic script.');
    const glm = JSON.parse(fetch.mock.calls[1][1].body);
    expect(JSON.stringify(glm.messages)).toContain('Shared output protocol v1');
    expect(glm.response_format).toEqual({ type: 'json_object' });
});
