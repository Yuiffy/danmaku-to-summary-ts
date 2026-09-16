import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { StageConfig, runStage, calculateCost, validateStage } from './stage';

describe('stage accounting and admission', () => {
    const config: StageConfig = { provider: 'daiYu', model: 'fixture', apiMode: 'responses', reasoningEffort: 'high',
        maxTokens: 1000, maxInputTokens: 2000, timeoutMs: 1000,
        capabilities: { reasoningEfforts: ['high'], images: false },
        price: { confirmed: true, version: 'fixture-only', inputCnyPerMillion: 1000, cachedInputCnyPerMillion: 100, outputCnyPerMillion: 2000 } };
    const context = { roomId: 'room', sessionId: 'session', stage: 'qa' };
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-budget-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const budget = () => ({ ledgerPath: path.join(dir, 'ledger.json'), globalCny: 10, roomCny: 10, sessionCny: 10, holdoutReserveCny: 4 });
    const result = (usage: any = { input_tokens: 100, output_tokens: 100 }) => ({ text: '{"clips":[]}', meta: { usage,
        attempts: [{ provider: 'daiYu', model: 'fixture', apiModeUsed: 'responses', reasoningEffortSent: 'high' }] } });

    test('reserves concurrent requests before sending and protects holdout funds', async () => {
        let complete: (value: any) => void = () => {};
        const generate = jest.fn(() => new Promise<any>(resolve => { complete = resolve; }));
        const first = runStage(config, budget(), context, 'facts', [], generate);
        while (!generate.mock.calls.length) await new Promise(resolve => setTimeout(resolve, 1));
        await expect(runStage(config, budget(), context, 'facts', [], generate)).rejects.toThrow('exhausted');
        expect(generate).toHaveBeenCalledTimes(1);
        complete(result());
        await first;
        expect(JSON.parse(fs.readFileSync(budget().ledgerPath, 'utf8')).rows[0]).toMatchObject({ status: 'success', reservedCny: 4, costCny: 0.3 });
    });

    test.each(['empty', 'truncated', 'timeout', 'pending'])('accounts for %s results without zero-cost retries', async kind => {
        const failed = kind === 'empty' ? { ...result(), text: '' } : null;
        const generate = jest.fn(async () => {
            if (failed) return failed;
            throw Object.assign(new Error(kind), { attempts: [{ rawUsage: kind === 'timeout' ? null : { input_tokens: 100, output_tokens: 100 },
                usageFinal: kind !== 'pending' }] });
        });
        await expect(runStage(config, budget(), context, 'facts', [], generate)).rejects.toThrow();
        const row = JSON.parse(fs.readFileSync(budget().ledgerPath, 'utf8')).rows[0];
        expect(row.status).toBe('failure');
        expect(row.costCny).toBe(['timeout', 'pending'].includes(kind) ? null : 0.3);
        expect(row.chargedCny).toBe(['timeout', 'pending'].includes(kind) ? 4 : 0.3);
    });

    test('reasoning is not billed twice and missing usage is not zero', () => {
        expect(calculateCost({ input_tokens: 100, input_tokens_details: { cached_tokens: 50 }, output_tokens: 100,
            output_tokens_details: { reasoning_tokens: 80 } }, config.price)).toBe(0.255);
        expect(calculateCost({}, config.price)).toBeNull();
    });

    test('configured transient retries create separate ledger rows and retain failed request usage uncertainty', async () => {
        const generate = jest.fn().mockRejectedValueOnce(Object.assign(Error('upstream 502'), { attempts: [
            { provider: 'daiYu', model: 'fixture', status: 'failure', httpStatus: 502, requestId: 'failed-1', usageUnknown: true }
        ] })).mockResolvedValueOnce(result());
        const value = await runStage({ ...config, retry: { maxAttempts: 2, baseDelayMs: 0, jitterRatio: 0 } },
            { ...budget(), mode: 'log_only' }, context, 'facts', [], generate);
        expect(generate).toHaveBeenCalledTimes(2);
        expect(generate.mock.calls[1][2]).toMatchObject({ primaryModel: 'fixture', apiMode: 'responses', strictEvaluation: true });
        const rows = JSON.parse(fs.readFileSync(budget().ledgerPath, 'utf8')).rows;
        expect(rows.map(row => row.status)).toEqual(['failure', 'success']);
        expect(value.meta?.retryLedgerIds).toEqual([rows[0].id]);
        expect(value.meta?.retryUsageUnknown).toBe(true);
        expect(rows[0].response.requestId).toBe('failed-1');
    });

    test('unconfirmed prices, unsupported reasoning and failed image inputs never send', async () => {
        const generate = jest.fn();
        await expect(runStage({ ...config, price: { ...config.price!, confirmed: false } }, budget(), context, 'facts', [], generate)).rejects.toThrow('pricing');
        expect(() => validateStage({ ...config, reasoningEffort: 'low' }, 'facts')).toThrow('Unverified');
        expect(() => validateStage(config, 'facts', ['data:image/png;base64,YQ=='])).toThrow('Image capability');
        expect(() => validateStage(config, 'x'.repeat(3000))).toThrow('input');
        expect(generate).not.toHaveBeenCalled();
    });

    test('unknown returned capability is marked rather than claimed verified', async () => {
        await runStage(config, budget(), context, 'facts', [], async () => result());
        const row = JSON.parse(fs.readFileSync(budget().ledgerPath, 'utf8')).rows[0];
        expect(row.response.capabilityVerified).toBe(false);
        expect(row.request).toMatchObject({ model: 'fixture', reasoningEffort: 'high' });
    });

    test('different returned model requires reconciliation and prevents further paid work', async () => {
        const generate = jest.fn(async () => {
            const value = result();
            value.meta.attempts[0]['responseModel'] = 'other-model';
            return value;
        });
        await expect(runStage(config, budget(), context, 'facts', [], generate)).rejects.toThrow('different model');
        await expect(runStage(config, budget(), context, 'facts', [], generate)).rejects.toThrow('reconciliation');
        expect(generate).toHaveBeenCalledTimes(1);
    });

    test('the same limit is shared across Node processes', async () => {
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, JSON.stringify({ config, budget: { ...budget(), globalCny: 4, holdoutReserveCny: 0 }, context }));
        const worker = path.resolve(__dirname, '../../..', 'tests/fixtures/clip-budget-worker.cjs');
        const run = () => new Promise<string>((resolve, reject) => execFile(process.execPath, [worker, file], {
            windowsHide: true, timeout: 10000, encoding: 'utf8', env: process.env
        }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
        const results = await Promise.all([run(), run()]);
        expect(results.sort()).toEqual(['admitted', 'blocked']);
        expect(JSON.parse(fs.readFileSync(budget().ledgerPath, 'utf8')).rows).toHaveLength(1);
    });

    test('log-only mode records full usage without prices or monetary limits', async () => {
        const accounting = { mode: 'log_only' as const, ledgerPath: budget().ledgerPath };
        const generate = jest.fn(async () => result());
        await runStage({ ...config, price: undefined }, accounting, context, 'facts', [], generate);
        await runStage({ ...config, price: undefined }, { ...accounting, globalCny: 0 }, context, 'facts', [], generate);
        const rows = JSON.parse(fs.readFileSync(accounting.ledgerPath, 'utf8')).rows;
        expect(generate).toHaveBeenCalledTimes(2);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ accountingMode: 'log_only', status: 'success', reservedCny: null,
            chargedCny: null, costCny: null, usageUnknown: false, costUnknown: true, costUnknownReason: 'unconfirmed_price',
            rawUsage: { input_tokens: 100, output_tokens: 100 } });
        expect(rows[1].attempt).toBe(2);
    });

    test('log-only failures stay logged without treating unknown usage as free or blocking later work', async () => {
        const accounting = { mode: 'log_only' as const, ledgerPath: budget().ledgerPath };
        await expect(runStage(config, accounting, context, 'facts', [], async () => { throw new Error('timeout'); })).rejects.toThrow('timeout');
        await runStage(config, accounting, context, 'facts', [], async () => result());
        const rows = JSON.parse(fs.readFileSync(accounting.ledgerPath, 'utf8')).rows;
        expect(rows[0]).toMatchObject({ status: 'failure', costCny: null, chargedCny: null, usageUnknown: true });
        expect(rows[1]).toMatchObject({ status: 'success', costCny: 0.3 });
        await expect(runStage(config, budget(), context, 'facts', [], async () => result())).rejects.toThrow('reconciliation');
    });

    test('log-only mode does not relax request capability or routing checks', async () => {
        const accounting = { mode: 'log_only' as const, ledgerPath: budget().ledgerPath };
        const generate = jest.fn(async () => result());
        await expect(runStage({ ...config, reasoningEffort: 'unknown' }, accounting, context, 'facts', [], generate)).rejects.toThrow('Unsupported');
        await expect(runStage(config, accounting, context, 'facts', ['data:image/png;base64,YQ=='], generate)).rejects.toThrow('Image');
        expect(generate).not.toHaveBeenCalled();
    });
});
