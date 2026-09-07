import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { normalizeOpenAIReasoningEffort, validateImageInputs } from '../text/requests';

export interface StageConfig {
    provider: 'daiYu' | 'tuZi'; model: string; apiMode: 'responses' | 'chatCompletions';
    reasoningEffort: string; maxTokens: number; maxInputTokens: number; timeoutMs: number;
    capabilities: { reasoningEfforts: string[]; images: boolean; imageTokenUpperBound?: number };
    price: { confirmed: boolean; version: string; inputCnyPerMillion: number;
        cachedInputCnyPerMillion: number; outputCnyPerMillion: number };
}
export interface BudgetConfig {
    ledgerPath: string; globalCny: number; roomCny: number; sessionCny: number;
    holdoutReserveCny?: number;
}
export interface StageContext { stage: string; roomId: string; sessionId: string; split?: 'screening' | 'holdout' }
export interface Generation {
    text: string; meta?: { usage?: unknown; attempts?: Array<Record<string, any>>; [key: string]: any };
}
export type Generate = (provider: StageConfig['provider'], prompt: string, options: Record<string, unknown>) => Promise<Generation>;
interface LedgerRow extends StageContext {
    id: string; attempt: number; startedAt: string; reservedCny: number; chargedCny: number;
    status: 'reserved' | 'success' | 'failure'; request: Record<string, unknown>;
    price: StageConfig['price']; elapsedMs?: number; rawUsage?: unknown; costCny?: number | null;
    usageUnknown?: boolean; response?: Record<string, unknown>; error?: string;
    reconciliationRequired?: boolean;
}
interface Ledger { version: 1; rows: LedgerRow[] }
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const roundUp = (value: number) => Math.ceil(value * 1e8) / 1e8;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function validateStage(config: StageConfig, prompt: string, images: string[] = [], live = true): number {
    if (!config || !['daiYu', 'tuZi'].includes(config.provider) || !config.model?.trim()
        || !['responses', 'chatCompletions'].includes(config.apiMode)) throw new Error('Explicit provider, model and protocol required');
    if (typeof config.reasoningEffort !== 'string' || !config.reasoningEffort.trim()) throw new Error('Explicit reasoning effort required');
    const effort = normalizeOpenAIReasoningEffort(config.reasoningEffort);
    if (!config.capabilities?.reasoningEfforts?.includes(effort)) throw new Error(`Unverified reasoning capability: ${config.model}/${effort}`);
    for (const key of ['maxTokens', 'maxInputTokens', 'timeoutMs'] as const) {
        if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`Invalid stage ${key}`);
    }
    validateImageInputs(images);
    if (images.length && (!config.capabilities.images || !finite(config.capabilities.imageTokenUpperBound)
        || config.capabilities.imageTokenUpperBound <= 0)) throw new Error('Image capability/token bound is not verified');
    // UTF-8 bytes deliberately overestimate text tokens; image encoding bytes are not token counts.
    const inputBound = Buffer.byteLength(prompt, 'utf8') + 512 + images.length * (config.capabilities.imageTokenUpperBound || 0);
    if (inputBound > config.maxInputTokens) throw new Error('Stage input exceeds reserved token bound');
    if (!config.price?.version || (live && config.price.confirmed !== true)
        || ![config.price.inputCnyPerMillion, config.price.cachedInputCnyPerMillion, config.price.outputCnyPerMillion].every(finite)) {
        throw new Error('Confirmed channel pricing required before paid requests');
    }
    return roundUp((config.maxInputTokens * Math.max(config.price.inputCnyPerMillion, config.price.cachedInputCnyPerMillion)
        + config.maxTokens * config.price.outputCnyPerMillion) / 1e6);
}

async function updateLedger<T>(config: BudgetConfig, update: (ledger: Ledger) => T): Promise<T> {
    if (!path.isAbsolute(config.ledgerPath)) throw new Error('Budget ledgerPath must be absolute and shared across workers');
    fs.mkdirSync(path.dirname(config.ledgerPath), { recursive: true });
    const lock = `${config.ledgerPath}.lock`;
    const deadline = Date.now() + 10000;
    let fd: number;
    while (true) {
        try { fd = fs.openSync(lock, 'wx'); break; } catch (error: any) {
            if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error(`Budget ledger unavailable: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
    const temporary = `${config.ledgerPath}.${randomUUID()}.tmp`;
    try {
        const ledger: Ledger = fs.existsSync(config.ledgerPath)
            ? JSON.parse(fs.readFileSync(config.ledgerPath, 'utf8')) : { version: 1, rows: [] };
        if (ledger.version !== 1 || !Array.isArray(ledger.rows)
            || ledger.rows.some(row => !finite(row.chargedCny) || !finite(row.reservedCny))) throw new Error('Invalid budget ledger');
        const result = update(ledger);
        fs.writeFileSync(temporary, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
        fs.renameSync(temporary, config.ledgerPath);
        return result;
    } finally {
        fs.closeSync(fd);
        fs.unlinkSync(lock);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

export function calculateCost(usage: any, price: StageConfig['price']): number | null {
    const input = usage?.input_tokens ?? usage?.prompt_tokens;
    const output = usage?.output_tokens ?? usage?.completion_tokens;
    const cached = usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
    if (![input, output, cached].every(finite) || cached > input) return null;
    // Reasoning tokens are already part of output_tokens/completion_tokens.
    return roundUp(((input - cached) * price.inputCnyPerMillion + cached * price.cachedInputCnyPerMillion
        + output * price.outputCnyPerMillion) / 1e6);
}

export async function runStage(config: StageConfig, budget: BudgetConfig, context: StageContext,
    prompt: string, images: string[], generate: Generate): Promise<Generation> {
    const reservation = validateStage(config, prompt, images);
    config = { ...config, reasoningEffort: normalizeOpenAIReasoningEffort(config.reasoningEffort) };
    if (![budget.globalCny, budget.roomCny, budget.sessionCny, budget.holdoutReserveCny ?? 0].every(finite)
        || (budget.holdoutReserveCny || 0) > budget.globalCny
        || !context.roomId || !context.sessionId || !context.stage) throw new Error('Explicit finite budgets and scope required');
    const request = { provider: config.provider, model: config.model, apiMode: config.apiMode,
        reasoningEffort: config.reasoningEffort, maxTokens: config.maxTokens, maxInputTokens: config.maxInputTokens,
        timeoutMs: config.timeoutMs, promptSha256: sha(prompt), imageSha256: images.map(sha) };
    const row = await updateLedger(budget, ledger => {
        if (ledger.rows.some(item => item.reconciliationRequired)) throw new Error('Budget reconciliation required before more paid requests');
        const sum = (predicate: (item: LedgerRow) => boolean) => ledger.rows.filter(predicate).reduce((n, item) => n + item.chargedCny, 0);
        const allowed = [
            [sum(() => true), budget.globalCny],
            [sum(item => item.roomId === context.roomId), budget.roomCny],
            [sum(item => item.roomId === context.roomId && item.sessionId === context.sessionId), budget.sessionCny],
            ...(context.split === 'holdout' ? [] : [[sum(item => item.split !== 'holdout'), budget.globalCny - (budget.holdoutReserveCny || 0)]])
        ];
        if (allowed.some(([used, limit]) => used + reservation > limit + 1e-9)) throw new Error('Concurrent stage budget exhausted');
        const entry: LedgerRow = { ...context, id: randomUUID(),
            attempt: ledger.rows.filter(item => item.roomId === context.roomId && item.sessionId === context.sessionId && item.stage === context.stage).length + 1,
            startedAt: new Date().toISOString(), reservedCny: reservation, chargedCny: reservation,
            status: 'reserved', request, price: config.price };
        ledger.rows.push(entry);
        return entry;
    });
    const started = Date.now();
    let result: Generation | undefined;
    let failure: any;
    try {
        result = await generate(config.provider, prompt, { primaryModel: config.model, reasoningEffort: config.reasoningEffort,
            apiMode: config.apiMode, maxTokens: config.maxTokens, timeoutMs: config.timeoutMs,
            deadlineAt: Date.now() + config.timeoutMs, images, strictEvaluation: true,
            exactModel: true, fallbackModelsEnabled: false, allowProviderFallback: false, strictResponses: true,
            transientMaxAttempts: 1, promptCacheRolloutPercent: 0 });
        if (!result?.text?.trim()) throw new Error('Empty stage output');
        const attempts = result.meta?.attempts || [];
        if (attempts.length !== 1 || attempts[0].provider !== config.provider || attempts[0].model !== config.model
            || attempts[0].apiModeUsed !== config.apiMode || attempts[0].reasoningEffortSent !== config.reasoningEffort) {
            throw new Error('Strict stage request parameters could not be verified');
        }
        if (attempts[0].responseModel && attempts[0].responseModel !== config.model) throw new Error('Strict stage returned a different model');
        if (attempts[0].reasoningEffortReturned && attempts[0].reasoningEffortReturned !== config.reasoningEffort) throw new Error('Strict stage returned a different reasoning effort');
    } catch (error) { failure = error; }
    const attempts = failure?.attempts || result?.meta?.attempts || [];
    const last = attempts.at(-1) || {};
    const usage = result?.meta?.usage || last.rawUsage || last.usage || null;
    const reconciliationRequired = attempts.length > 1 || Boolean(last.responseModel && last.responseModel !== config.model)
        || String(failure?.message || '').startsWith('Strict stage');
    const cost = reconciliationRequired || last.usageFinal === false || last.outcomeUnknown === true ? null : calculateCost(usage, config.price);
    await updateLedger(budget, ledger => {
        const current = ledger.rows.find(item => item.id === row.id);
        if (!current || current.status !== 'reserved') throw new Error('Missing budget reservation');
        Object.assign(current, { status: failure ? 'failure' : 'success', elapsedMs: Date.now() - started,
            rawUsage: usage, costCny: cost, chargedCny: cost ?? reservation, usageUnknown: cost === null,
            reconciliationRequired,
            response: { model: last.responseModel || null, reasoningEffort: last.reasoningEffortReturned || null,
                capabilityVerified: Boolean(last.responseModel && last.reasoningEffortReturned),
                requestId: last.requestId || null, responseId: last.responseId || null, attempts },
            ...(failure ? { error: String(failure.message || failure) } : {}) });
    });
    if (cost !== null && cost > reservation) throw new Error('Provider exceeded reserved usage; ledger reconciled, stop this run');
    if (failure) throw failure;
    return { ...result!, meta: { ...result!.meta, ledgerId: row.id, costCny: cost, usageUnknown: cost === null } };
}
