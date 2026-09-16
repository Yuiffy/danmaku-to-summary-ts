export {};
const { runClipPipeline, createLimiter } = require('./clip_pipeline');
const deferred = () => { let resolve: (x?: unknown) => void; const promise = new Promise(r => { resolve = r; }); return { promise, resolve: resolve! }; };
test('a waiting AI request releases the media slot so following clips render', async () => {
    const held = deferred(), laterRendered = deferred();
    const events: string[] = [];
    const result = runClipPipeline([
        async execution => { events.push('render1'); await execution.finishMedia(); events.push('ai1'); await held.promise; return 1; },
        async execution => { events.push('render2'); laterRendered.resolve(); await execution.finishMedia(); return 2; }
    ], { mediaConcurrency: 1, enhancementConcurrency: 1 });
    await laterRendered.promise;
    expect(events).toContain('render2');
    expect(events.indexOf('render1')).toBeLessThan(events.indexOf('render2'));
    held.resolve();
    expect(await result).toEqual([1, 2]);
});
test('bounds GPU use across render and enhancement, preserves ordering and releases failed jobs', async () => {
    const limiter = createLimiter(1); let active = 0, peak = 0;
    const scheduler = { enabled: true, acquire: async () => {
        const lease = await limiter.acquire(); peak = Math.max(peak, ++active);
        return { profile: { ffmpegThreads: 1 }, release: () => { active--; lease.release(); } };
    } };
    const errors = jest.fn();
    const result = await runClipPipeline([1, 2, 3].map(id => async execution => {
        await execution.finishMedia();
        return execution.withMedia(async profile => { expect(profile.ffmpegThreads).toBe(1); if (id === 2) throw Error('bad cover'); return id; });
    }), { scheduler, mediaConcurrency: 1, enhancementConcurrency: 3, onError: errors });
    expect(result).toEqual([1, 3]); expect(peak).toBe(1); expect(active).toBe(0); expect(errors).toHaveBeenCalledTimes(1);
});
