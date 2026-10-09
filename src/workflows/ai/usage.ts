import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { shortReviewReasons } from '../clipping/reviewDigest';

type Data = Record<string, unknown>;
const tokenFields = ['promptTokens', 'completionTokens', 'cachedTokens', 'cacheWriteTokens', 'reasoningTokens',
    'totalTokens', 'inputAudioTokens', 'inputImageTokens'] as const;
type TokenField = typeof tokenFields[number];
export type UsageEvent = Data & { phase: string; event: 'request' | 'cache' | 'local_asr' };
export interface UsageRun {
    id: string; kind: string; startedAt: string; finishedAt?: string; elapsedMs?: number; status: string;
    events: UsageEvent[]; error?: string; outcome?: Data; persistenceError?: string;
    notification?: { status: string; error?: string };
}
export interface UsageLedger {
    version: 1; mediaPath: string; kind: string; recording: Data; runs: UsageRun[];
    summary?: ReturnType<typeof summarizeUsage>;
}
interface Context { run: UsageRun; phase: string; changed: () => void }
const scope = new AsyncLocalStorage<Context>();
function metric(value: unknown): number | null {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}
function safeText(value: unknown): string { return String(value || '').slice(0, 500); }

/** Normalize both Gemini native and OpenAI chat usage without inventing missing fields. */
export function mediaUsage(usage: Data = {}): Data {
    const prompt = usage.prompt_tokens_details as Data | undefined;
    const output = usage.completion_tokens_details as Data | undefined;
    const modalities = Array.isArray(usage.promptTokensDetails) ? usage.promptTokensDetails as Data[] : null;
    const modality = (name: string) => {
        const rows = modalities?.filter(row => row.modality === name);
        return rows && rows.every(row => metric(row.tokenCount) !== null)
            ? rows.reduce((sum, row) => sum + Number(row.tokenCount), 0) : null;
    };
    return { promptTokens: metric(usage.promptTokenCount ?? usage.prompt_tokens),
        completionTokens: metric(usage.candidatesTokenCount ?? usage.completion_tokens),
        cachedTokens: metric(usage.cachedContentTokenCount ?? prompt?.cached_tokens),
        reasoningTokens: metric(usage.thoughtsTokenCount ?? output?.reasoning_tokens),
        totalTokens: metric(usage.totalTokenCount ?? usage.total_tokens),
        inputAudioTokens: modality('AUDIO'), inputImageTokens: modality('IMAGE') };
}

/** Called at the provider boundary, exactly once for each actual attempt. */
export function recordAiUsage(attempt: Data): void {
    const context = scope.getStore();
    if (!context) return;
    const identity = attempt.responseId || attempt.requestId;
    if (identity && context.run.events.some(event => event.event === 'request' && event.provider === attempt.provider
        && (event.responseId || event.requestId) === identity)) return;
    // Copy only accounting fields. Prompts, API keys, URLs and raw responses never enter this ledger.
    const event: UsageEvent = { event: 'request', phase: context.phase, at: new Date().toISOString(),
        provider: attempt.provider || null, model: attempt.model || null, status: attempt.status || 'success',
        requestStarted: attempt.requestStarted !== false, usageFinal: attempt.usageFinal ?? null,
        usageUnknown: attempt.usageUnknown === true || attempt.usageFinal === false
            || metric(attempt.promptTokens) === null || metric(attempt.completionTokens) === null,
        requestId: attempt.requestId || null, responseId: attempt.responseId || null,
        elapsedMs: metric(attempt.elapsedMs), httpStatus: metric(attempt.httpStatus),
        inputImages: metric(attempt.inputImages), inputAudioSeconds: metric(attempt.inputAudioSeconds),
        inputAudioFiles: metric(attempt.inputAudioFiles),
        ...Object.fromEntries(tokenFields.map(field => [field, metric(attempt[field])])) };
    context.run.events.push(event);
    context.changed();
}

export function withUsagePhase<T>(phase: string, work: () => T): T {
    const context = scope.getStore();
    return context ? scope.run({ ...context, phase }, work) : work();
}

export function recordUsageReuse(phase: string, kind = 'selection_cache'): void {
    const context = scope.getStore();
    if (!context) return;
    context.run.events.push({ event: 'cache', phase, kind, at: new Date().toISOString() });
    context.changed();
}

export function recordLocalAsrUsage(details: { audioSeconds: number; elapsedMs: number; reused: boolean; status: string }): void {
    const context = scope.getStore();
    if (!context) return;
    context.run.events.push({ event: 'local_asr', phase: context.phase, at: new Date().toISOString(), ...details });
    context.changed();
}

function sumKnown(rows: UsageEvent[], field: string): number | null {
    const values = rows.map(row => metric(row[field])).filter((value): value is number => value !== null);
    return rows.length === 0 ? 0 : values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}
function totals(events: UsageEvent[]) {
    const requests = events.filter(event => event.event === 'request' && event.requestStarted !== false);
    const knownTokens = Object.fromEntries(tokenFields.map(field => [field, sumKnown(requests, field)])) as Record<TokenField, number | null>;
    const missingTokens = Object.fromEntries(tokenFields.map(field => [field,
        requests.filter(row => metric(row[field]) === null || row.usageFinal === false).length])) as Record<TokenField, number>;
    return { requests: requests.length, failedRequests: requests.filter(row => row.status === 'failure').length,
        unknownUsageRequests: requests.filter(row => row.usageUnknown === true).length,
        cacheHits: events.filter(row => row.event === 'cache').length, knownTokens, missingTokens,
        inputImages: sumKnown(requests, 'inputImages'), inputAudioSeconds: sumKnown(requests, 'inputAudioSeconds'),
        missingMediaUsage: { inputImages: requests.filter(row => metric(row.inputImages) === null).length,
            inputAudioSeconds: requests.filter(row => metric(row.inputAudioSeconds) === null).length },
        localAsrRuns: events.filter(row => row.event === 'local_asr' && row.reused !== true).length,
        localAsrCacheHits: events.filter(row => row.event === 'local_asr' && row.reused === true).length,
        localAsrAudioSeconds: sumKnown(events.filter(row => row.event === 'local_asr' && row.reused !== true), 'audioSeconds') };
}
export function summarizeUsage(events: UsageEvent[]) {
    const groups = new Map<string, UsageEvent[]>();
    for (const event of events) {
        const key = JSON.stringify([event.phase, event.provider || null, event.model || null]);
        const selected = groups.get(key) || []; selected.push(event); groups.set(key, selected);
    }
    return { ...totals(events), stages: [...groups.values()].map(rows => ({ phase: rows[0].phase,
        provider: rows[0].provider || null, model: rows[0].model || null, ...totals(rows) })) };
}

export function usageMarkdown(ledger: UsageLedger, run: UsageRun, ledgerPath: string): string {
    const summary = summarizeUsage(run.events), all = summarizeUsage(ledger.runs.flatMap(item => item.events));
    const label = ({ games: '游戏切', songs: '歌切', watch: '同步视听切', activities: '歌切 / 同步视听切' } as Record<string, string>)[run.kind] || run.kind;
    const count = (value: number | null) => value === null ? '未知' : value.toLocaleString('en-US');
    const status = run.status === 'failed' ? '失败' : run.status === 'running' ? '进行中' : '处理结束';
    const lines = [`## ${label} AI 用量`, `${ledger.recording.streamerName || ledger.recording.roomId || ''} ${ledger.recording.recordedAt || path.basename(ledger.mediaPath)}`,
        `状态：${status}；耗时 ${((run.elapsedMs || 0) / 60000).toFixed(1)} 分钟`,
        `本次请求 ${summary.requests} 次（失败 ${summary.failedRequests}，用量不完整 ${summary.unknownUsageRequests}）；本地缓存复用 ${summary.cacheHits} 次`,
        `已知 token：输入 ${count(summary.knownTokens.promptTokens)}，输出 ${count(summary.knownTokens.completionTokens)}，缓存命中 ${count(summary.knownTokens.cachedTokens)}，推理 ${count(summary.knownTokens.reasoningTokens)}`,
        `已知图片输入 ${count(summary.inputImages)} 张；已知远程原音频 ${count(summary.inputAudioSeconds)} 秒；本地 ASR ${summary.localAsrRuns} 次 / ${count(summary.localAsrAudioSeconds)} 秒（复用 ${summary.localAsrCacheHits} 次）`];
    for (const stage of summary.stages) {
        if (!stage.requests && !stage.cacheHits && !stage.localAsrRuns && !stage.localAsrCacheHits) continue;
        lines.push(`- ${stage.phase}${stage.model ? ` / ${stage.model}` : ''}：请求 ${stage.requests}，失败 ${stage.failedRequests}，输入 ${count(stage.knownTokens.promptTokens)} / 输出 ${count(stage.knownTokens.completionTokens)}，未知 ${stage.unknownUsageRequests}，复用 ${stage.cacheHits}`);
    }
    if (ledger.runs.length > 1) lines.push(`该录播累计 ${all.requests} 次请求；已知输入 ${count(all.knownTokens.promptTokens)} / 输出 ${count(all.knownTokens.completionTokens)}；用量不完整 ${all.unknownUsageRequests} 次`);
    if (run.error) lines.push(`失败原因：${run.error}`);
    if (run.persistenceError) lines.push(`用量明细写入未确认：${run.persistenceError}`);
    if (run.outcome) lines.push(`结果：${safeText(run.outcome.status)}${run.outcome.submissions !== undefined ? `，${run.outcome.submissions} 个投稿包` : ''}${run.outcome.parts !== undefined ? `，${run.outcome.parts} 段` : ''}`);
    for (const result of Array.isArray(run.outcome?.publicationResults) ? run.outcome.publicationResults : []) lines.push(
        `- ${result.id ? `ID ${result.id} ` : ''}${safeText(result.title)}：${safeText(result.status)}`,
        ...(result.reviewBrief || (result.issues?.length ? [`理由：${shortReviewReasons(result.issues).join('；')}`] : [])).map((line: string) => safeText(line)));
    lines.push('仅累计服务商已返回的 token；未返回的字段保留未知，缓存 / 推理 token 为明细，不与输入输出重复相加。未按 token 估算账单。', `明细：${ledgerPath}`);
    return lines.join('\n');
}

interface UsageIO {
    read(file: string): unknown;
    write(file: string, value: unknown): void;
    now(): number;
    id(): string;
    warn(message: string): void;
}
const defaultIO: UsageIO = {
    read: file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null,
    write: (file, value) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.renameSync(temporary, file); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }, now: Date.now, id: randomUUID, warn: message => console.warn(message)
};
interface RunOptions {
    kind: string; directory: string; mediaPath: string; recording?: Data; webhookUrl?: string; notifyEnabled?: boolean;
    sendMarkdown?: (webhook: string, markdown: string, requestOptions?: { timeout: number }) => Promise<boolean>;
    io?: Partial<UsageIO>;
}

/** Run-local and cumulative durable usage. Notification failures never rerun paid generation. */
export async function runClipUsage<T extends Data>(options: RunOptions, work: () => Promise<T>): Promise<T & { aiUsagePath: string; aiUsage: ReturnType<typeof summarizeUsage> }> {
    const io = { ...defaultIO, ...options.io };
    const ledgerPath = path.join(options.directory, `AI_USAGE.${options.kind.replace(/[^a-z_-]/gu, '_')}.json`);
    const previous = io.read(ledgerPath) as UsageLedger | null;
    if (previous && (previous.version !== 1 || !Array.isArray(previous.runs) || previous.mediaPath !== options.mediaPath)) throw new Error('Invalid clip AI usage ledger');
    const ledger: UsageLedger = previous || { version: 1, mediaPath: options.mediaPath, kind: options.kind, recording: options.recording || {}, runs: [] };
    const started = io.now();
    const run: UsageRun = { id: io.id(), kind: options.kind, startedAt: new Date(started).toISOString(), status: 'running', events: [] };
    ledger.runs.push(run);
    // Fail before the first paid call if storage is unavailable. Later telemetry IO must not trigger paid retries.
    io.write(ledgerPath, ledger);
    const persist = () => {
        ledger.summary = summarizeUsage(ledger.runs.flatMap(item => item.events));
        try { io.write(ledgerPath, ledger); }
        catch (error) {
            run.persistenceError = safeText(error instanceof Error ? error.message : error);
            io.warn(`Clip AI usage persistence failed: ${ledgerPath}: ${run.persistenceError}`);
        }
    };
    let result: T | undefined, failure: unknown;
    try {
        result = await scope.run({ run, phase: 'setup', changed: persist }, work);
        run.status = 'completed';
        run.outcome = Object.fromEntries(['status', 'submissions', 'parts', 'events', 'pendingReview', 'reviewPath', 'planPath', 'publicationResults']
            .filter(key => result?.[key] !== undefined).map(key => [key, result?.[key]]));
    } catch (error) {
        failure = error; run.status = 'failed'; run.error = safeText(error instanceof Error ? error.message : error);
    }
    run.finishedAt = new Date(io.now()).toISOString(); run.elapsedMs = io.now() - started;
    persist();
    if (options.notifyEnabled !== false && options.webhookUrl && options.sendMarkdown) {
        run.notification = { status: 'sending' }; persist();
        try {
            const sent = await options.sendMarkdown(options.webhookUrl, usageMarkdown(ledger, run, ledgerPath), { timeout: 30000 });
            run.notification = { status: sent ? 'sent' : 'not_sent' };
        } catch (error) {
            run.notification = { status: 'unknown', error: safeText(error instanceof Error ? error.message : error) };
            io.warn(`Clip AI usage notification delivery unconfirmed: ${ledgerPath}`);
        }
    } else run.notification = { status: 'disabled' };
    persist();
    if (failure !== undefined) throw failure;
    return { ...result as T, aiUsagePath: ledgerPath, aiUsage: summarizeUsage(run.events) };
}
