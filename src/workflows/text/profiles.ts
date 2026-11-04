export type TextModelProfile = 'flash' | 'pro';
export interface TextModelRoute {
    provider: 'daiYu' | 'zai' | 'deepSeek' | 'tuZi';
    model: string;
    apiMode: 'responses' | 'chatCompletions';
}
type Root = { ai?: { text?: { defaultProfile?: TextModelProfile; daiYu?: { model?: string };
    profiles?: Partial<Record<TextModelProfile, { routes: TextModelRoute[] }>> } } };
export const DEFAULT_TEXT_PROFILES: Record<TextModelProfile, { routes: TextModelRoute[] }> = {
    flash: { routes: [
        { provider: 'daiYu', model: 'gpt-6-luna', apiMode: 'responses' },
        { provider: 'zai', model: 'glm-5.3-flash', apiMode: 'chatCompletions' },
        { provider: 'deepSeek', model: 'deepseek-flash', apiMode: 'chatCompletions' },
        { provider: 'tuZi', model: 'gpt-6-luna', apiMode: 'responses' }
    ] },
    pro: { routes: [
        { provider: 'daiYu', model: 'gpt-6.1-sol', apiMode: 'responses' },
        { provider: 'zai', model: 'glm-5.3', apiMode: 'chatCompletions' },
        { provider: 'deepSeek', model: 'deepseek-flash', apiMode: 'chatCompletions' }
    ] }
};

/** An explicit tier owns its routes; fixed-model callers opt out of the default tier. */
export function selectTextProfile(root: Root, options: { modelProfile?: TextModelProfile; profileResolved?: boolean;
    strictEvaluation?: boolean; allowProviderFallback?: boolean; primaryModel?: string }): TextModelProfile | undefined {
    if (options.profileResolved) return undefined;
    if (options.modelProfile) return options.modelProfile;
    const text = root.ai?.text;
    if (!options.strictEvaluation && options.allowProviderFallback !== false
        && (!options.primaryModel || options.primaryModel === text?.daiYu?.model)) return text?.defaultProfile;
    return undefined;
}

/** Pure route policy; credentials and provider IO stay in the existing adapters. */
export function resolveTextProfile(root: Root, name: TextModelProfile): TextModelRoute[] {
    if (name !== 'flash' && name !== 'pro') throw new Error(`Unknown text model profile: ${String(name)}`);
    const routes = root.ai?.text?.profiles?.[name]?.routes ?? DEFAULT_TEXT_PROFILES[name].routes;
    if (!Array.isArray(routes) || !routes.length) throw new Error(`Empty text model profile: ${name}`);
    return routes.map(route => {
        if (!route || !['daiYu', 'zai', 'deepSeek', 'tuZi'].includes(route.provider)
            || typeof route.model !== 'string' || !/^[a-zA-Z0-9._-]+$/u.test(route.model)
            || !['responses', 'chatCompletions'].includes(route.apiMode)
            || ['zai', 'deepSeek'].includes(route.provider) && route.apiMode !== 'chatCompletions') {
            throw new Error(`Invalid text model profile route: ${name}`);
        }
        return { provider: route.provider, model: route.model, apiMode: route.apiMode };
    });
}

interface Attempt { provider?: string; model?: string; apiModeUsed?: string; status?: string; outcomeUnknown?: boolean; finishReason?: string; [key: string]: unknown }
interface Generation { text: string; meta?: { attempts?: Attempt[]; [key: string]: unknown }; [key: string]: unknown }
interface ProfileFailure extends Error { attempts?: Attempt[]; outcomeUnknown?: boolean }

/** A bounded profile never appends the legacy provider fallback or switches on an unknown outcome. */
export async function runTextProfile(root: Root, name: TextModelProfile,
    request: (route: TextModelRoute) => Promise<Generation>,
    options: { deadlineAt?: number; now?: () => number; apiMode?: 'chatCompletions'; attempts?: Attempt[]; fallback?: boolean } = {}): Promise<Generation> {
    const routes = resolveTextProfile(root, name).map(route => ({ ...route, apiMode: options.apiMode || route.apiMode }));
    const attempts: Attempt[] = [...(options.attempts || [])], failures: string[] = [];
    const now = options.now || Date.now;
    for (const [index, route] of routes.entries()) {
        try {
            if (options.deadlineAt !== undefined && now() >= options.deadlineAt) throw new Error('Text model profile deadline exceeded');
            const result = await request(route);
            if (!result.text?.trim()) throw new Error('Text model profile returned empty output');
            return { ...result, meta: { ...result.meta, attempts: [...attempts, ...(result.meta?.attempts || [])],
                modelProfile: name, modelProfileRoutes: routes, provider: route.provider, model: route.model,
                fallback: Boolean(options.fallback) || index > 0 || result.meta?.fallback === true } };
        } catch (cause) {
            const error = cause as ProfileFailure;
            attempts.push(...(error.attempts || [{ provider: route.provider, model: route.model, status: 'failure', requestStarted: false }]));
            failures.push(`${route.provider}/${route.model}: ${error.message}`);
            const pending = error.outcomeUnknown || attempts.some(attempt => attempt.outcomeUnknown
                || ['queued', 'in_progress'].includes(String(attempt.finishReason || '').toLowerCase()));
            if (pending || options.deadlineAt !== undefined && now() >= options.deadlineAt) {
                throw Object.assign(new Error(failures.join(' | ')), { attempts, outcomeUnknown: Boolean(pending) });
            }
        }
    }
    throw Object.assign(new Error(`${name} text model profile exhausted: ${failures.join(' | ')}`), { attempts });
}

/** Freeze the effective image/text route list into media cache signatures. Raw audio has a separate route. */
export function resolveMediaProfile<T extends { modelProfile?: TextModelProfile }>(root: Root, settings: T) {
    if (!settings.modelProfile) return settings;
    const routes = resolveTextProfile(root, settings.modelProfile).map(route => ({ ...route, apiMode: 'chatCompletions' as const }));
    return { ...settings, provider: routes[0].provider, model: routes[0].model,
        apiMode: 'openai_chat', modelProfileRoutes: routes };
}

/** Bind an accepted preflight response to the configured route, including its protocol. */
export function matchesTextProfile(result: Generation, routes: TextModelRoute[], reasoningEffort: string): boolean {
    const actual = result.meta?.attempts?.at(-1);
    if (!actual || actual.status !== 'success') return false;
    const route = routes.find(item => item.provider === actual.provider && item.model === actual.model);
    return Boolean(route && actual.apiModeUsed === route.apiMode
        && (!['daiYu', 'tuZi'].includes(route.provider) || actual.reasoningEffortSent === reasoningEffort
            && (!actual.reasoningEffortReturned || actual.reasoningEffortReturned === reasoningEffort)));
}
