import { DEFAULT_TEXT_PROFILES, matchesTextProfile, resolveMediaProfile, resolveTextProfile, runTextProfile, selectTextProfile } from './profiles';

test('pro is bounded to Sol, full GLM and DeepSeek; flash retains its four routes', () => {
    expect(resolveTextProfile({}, 'pro').map(route => `${route.provider}/${route.model}`))
        .toEqual(['daiYu/gpt-6.1-sol', 'zai/glm-5.3', 'deepSeek/deepseek-flash']);
    expect(resolveTextProfile({}, 'flash').map(route => `${route.provider}/${route.model}`))
        .toEqual(['daiYu/gpt-6-luna', 'zai/glm-5.3-flash', 'deepSeek/deepseek-flash', 'tuZi/gpt-6-luna']);
    expect(() => resolveTextProfile({ ai: { text: { profiles: { pro: { routes: [] } } } } }, 'pro')).toThrow('Empty');
});

test('only ordinary default-model calls inherit flash; explicit profiles and pinned callers stay distinct', () => {
    const root = { ai: { text: { defaultProfile: 'flash' as const, daiYu: { model: 'gpt-6-luna' } } } };
    expect(selectTextProfile(root, {})).toBe('flash');
    expect(selectTextProfile(root, { primaryModel: 'gpt-6-luna' })).toBe('flash');
    expect(selectTextProfile(root, { primaryModel: 'gpt-6.1-sol' })).toBeUndefined();
    expect(selectTextProfile(root, { strictEvaluation: true })).toBeUndefined();
    expect(selectTextProfile(root, { allowProviderFallback: false })).toBeUndefined();
    expect(selectTextProfile(root, { modelProfile: 'pro', allowProviderFallback: false })).toBe('pro');
    expect(selectTextProfile(root, { modelProfile: 'pro', profileResolved: true })).toBeUndefined();
});

test('fallback collects all attempts and stops after the first accepted provider output', async () => {
    const request = jest.fn(async route => {
        if (route.provider === 'daiYu') throw Object.assign(new Error('unavailable'), {
            attempts: [{ ...route, status: 'failure', requestStarted: true, httpStatus: 503 }] });
        return { text: '{}', meta: { attempts: [{ ...route, status: 'success', apiModeUsed: route.apiMode }] } };
    });
    const result = await runTextProfile({}, 'pro', request);
    expect(request.mock.calls.map(([route]) => route.provider)).toEqual(['daiYu', 'zai']);
    expect(result.meta).toMatchObject({ modelProfile: 'pro', provider: 'zai', model: 'glm-5.3', fallback: true });
    expect(result.meta?.attempts).toHaveLength(2);
    expect(matchesTextProfile(result, DEFAULT_TEXT_PROFILES.pro.routes, 'high')).toBe(true);
    expect(matchesTextProfile(result, DEFAULT_TEXT_PROFILES.flash.routes, 'high')).toBe(false);
});

test('pending requests and exhausted deadlines never trigger another provider', async () => {
    const request = jest.fn(async () => { throw Object.assign(new Error('pending'), { attempts: [{ outcomeUnknown: true }] }); });
    await expect(runTextProfile({}, 'pro', request)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear();
    await expect(runTextProfile({}, 'pro', request, { deadlineAt: 10, now: () => 10 })).rejects.toThrow('deadline');
    expect(request).not.toHaveBeenCalled();
});

test('media freezes the selected route configuration into its cache signature', () => {
    const root = { ai: { text: { profiles: { pro: { routes: [{ provider: 'zai' as const, model: 'glm-5.3', apiMode: 'chatCompletions' as const }] } } } } };
    expect(resolveMediaProfile(root, { modelProfile: 'pro', timeoutMs: 1000 })).toMatchObject({
        provider: 'zai', model: 'glm-5.3', apiMode: 'openai_chat', timeoutMs: 1000,
        modelProfileRoutes: root.ai.text.profiles.pro.routes
    });
});

test('a profile preserves the previous provider failure when called as an existing fallback', async () => {
    const previous = { provider: 'gemini', model: 'fixture', status: 'failure' };
    const result = await runTextProfile({}, 'flash', async route => ({ text: 'ok', meta: {
        attempts: [{ provider: route.provider, model: route.model, status: 'success' }] }
    }), { attempts: [previous], fallback: true });
    expect(result.meta?.attempts?.[0]).toEqual(previous);
    expect(result.meta?.fallback).toBe(true);
});
