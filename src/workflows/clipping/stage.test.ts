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

    test('unconfirmed prices, unsupported reasoning and failed image inputs never send', async () => {
        const generate = jest.fn();
        await expect(runStage({ ...config, price: { ...config.price, confirmed: false } }, budget(), context, 'facts', [], generate)).rejects.toThrow('pricing');
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
});
