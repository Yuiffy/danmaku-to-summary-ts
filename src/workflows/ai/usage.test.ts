import { logAiUsage } from '../text/response';
import { mediaUsage, recordAiUsage, recordLocalAsrUsage, recordUsageReuse, runClipUsage, UsageLedger, withUsagePhase } from './usage';

function fixture() {
    const files = new Map<string, unknown>();
    let now = 1000, id = 0;
    const notify = jest.fn<Promise<boolean>, [string, string, { timeout: number }?]>(async () => true);
    const options = { kind: 'games', directory: 'fixture', mediaPath: 'recording.flv', recording: { streamerName: '岁己' },
        webhookUrl: 'test-webhook', sendMarkdown: notify, io: {
            read: (file: string) => files.get(file) || null,
            write: (file: string, value: unknown) => { files.set(file, JSON.parse(JSON.stringify(value))); },
            now: () => now++, id: () => String(++id), warn: jest.fn()
        } };
    return { files, options, notify, ledger: () => [...files.values()][0] as UsageLedger };
}

test('provider attempts retain failures and partial usage while cache reuse adds no new charge, including restart', async () => {
    const f = fixture(), log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
        const result = await runClipUsage(f.options, async () => {
            await withUsagePhase('text-detection', async () => {
                logAiUsage({ provider: 'daiYu', model: 'text', status: 'success', promptTokens: 100, completionTokens: 20, cachedTokens: 50 });
                logAiUsage({ provider: 'daiYu', model: 'text', status: 'failure', requestStarted: true });
            });
            withUsagePhase('vision', () => recordAiUsage({ provider: 'tuZi', model: 'vision', status: 'failure', promptTokens: 80, completionTokens: 8,
                requestId: 'unique', inputImages: 5, inputAudioSeconds: 30, usageFinal: true }));
            // Seeing a known response twice is not another provider call.
            withUsagePhase('vision', () => recordAiUsage({ provider: 'tuZi', requestId: 'unique' }));
            recordUsageReuse('vision');
            recordLocalAsrUsage({ audioSeconds: 60, elapsedMs: 100, reused: false, status: 'success' });
            return { status: 'rendered', submissions: 1, parts: 3 };
        });
        expect(result.aiUsage).toMatchObject({ requests: 3, failedRequests: 2, unknownUsageRequests: 1, cacheHits: 1,
            knownTokens: { promptTokens: 180, completionTokens: 28, cachedTokens: 50 },
            missingTokens: { promptTokens: 1, cachedTokens: 2 }, inputImages: 5, localAsrRuns: 1 });
        expect(f.notify).toHaveBeenCalledTimes(1);
        expect(f.notify).toHaveBeenCalledWith('test-webhook', expect.any(String), { timeout: 30000 });
        expect(f.notify.mock.calls[0][1]).toContain('text-detection / text');
        expect(f.ledger().runs[0].notification).toEqual({ status: 'sent' });
        const second = await runClipUsage(f.options, async () => {
            recordUsageReuse('vision'); return { status: 'rendered', submissions: 1 };
        });
        expect(second.aiUsage.requests).toBe(0);
        expect(f.ledger().summary?.requests).toBe(3);
        expect(f.ledger().runs).toHaveLength(2);
    } finally { log.mockRestore(); }
});

test('failed generation persists and notifies its known and unknown cost without masking the original error', async () => {
    const f = fixture(), failure = new Error('boundary failed');
    f.notify.mockRejectedValueOnce(new Error('timeout'));
    await expect(runClipUsage(f.options, async () => {
        recordAiUsage({ status: 'failure', requestStarted: true }); throw failure;
    })).rejects.toBe(failure);
    expect(f.ledger().runs[0]).toMatchObject({ status: 'failed', error: 'boundary failed', notification: { status: 'unknown' } });
    expect(f.ledger().summary).toMatchObject({ requests: 1, knownTokens: { promptTokens: null, completionTokens: null }, unknownUsageRequests: 1 });
    expect(f.ledger().summary).toMatchObject({ inputImages: null, inputAudioSeconds: null,
        missingMediaUsage: { inputImages: 1, inputAudioSeconds: 1 } });
    expect(f.notify.mock.calls[0][1]).toContain('状态：失败');
});

test('concurrent recording scopes and phase changes do not mix usage or trigger network without a notifier', async () => {
    const a = fixture(), b = fixture();
    const [first, second] = await Promise.all([
        runClipUsage({ ...a.options, sendMarkdown: undefined }, () => withUsagePhase('one', async () => {
            await Promise.resolve(); recordAiUsage({ promptTokens: 10, completionTokens: 1 }); return { status: 'planned' };
        })),
        runClipUsage({ ...b.options, sendMarkdown: undefined }, () => withUsagePhase('two', async () => {
            recordAiUsage({ promptTokens: 20, completionTokens: 2 }); await Promise.resolve(); return { status: 'planned' };
        }))
    ]);
    expect(first.aiUsage.knownTokens.promptTokens).toBe(10);
    expect(second.aiUsage.knownTokens.promptTokens).toBe(20);
    expect(a.notify).not.toHaveBeenCalled(); expect(b.notify).not.toHaveBeenCalled();
});

test('native usage does not turn absent cache or token fields into zero', () => {
    expect(mediaUsage({ promptTokenCount: 100, candidatesTokenCount: 7, thoughtsTokenCount: 3,
        promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 70 }, { modality: 'IMAGE', tokenCount: 20 }] }))
        .toMatchObject({ promptTokens: 100, completionTokens: 7, reasoningTokens: 3, cachedTokens: null, inputAudioTokens: 70, inputImageTokens: 20 });
    expect(mediaUsage()).toMatchObject({ promptTokens: null, inputAudioTokens: null });
    expect(mediaUsage({ promptTokensDetails: [{ modality: 'AUDIO' }] }).inputAudioTokens).toBeNull();
});

test('a ledger write failure after a paid request cannot turn it into a retry or hide a stage failure', async () => {
    const f = fixture(); let writes = 0;
    const paid = jest.fn(async () => {
        recordAiUsage({ promptTokens: 25, completionTokens: 5 }); return { status: 'rendered' };
    });
    const result = await runClipUsage({ ...f.options, io: { ...f.options.io,
        write: () => { if (++writes > 1) throw new Error('disk full'); } } }, paid);
    expect(paid).toHaveBeenCalledTimes(1);
    expect(result.aiUsage.requests).toBe(1);
    expect(f.notify.mock.calls[0][1]).toContain('用量明细写入未确认：disk full');
});
