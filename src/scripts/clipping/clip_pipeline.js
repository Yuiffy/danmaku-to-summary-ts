'use strict';

function createLimiter(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new Error('Invalid clip concurrency');
    let active = 0;
    const waiting = [];
    return { async acquire() {
        if (active >= limit) await new Promise(resolve => waiting.push(resolve)); else active++;
        let released = false;
        return { release() {
            if (released) return;
            released = true;
            const next = waiting.shift();
            if (next) next(); else active--;
        } };
    } };
}

/** Media leases end before network enhancement. Enhancement media reacquires the same GPU budget. */
function createClipPipeline({ scheduler, mediaConcurrency, enhancementConcurrency, onError }) {
    const fallbackMedia = createLimiter(mediaConcurrency);
    const enhancement = createLimiter(enhancementConcurrency);
    const acquireMedia = async () => scheduler?.enabled ? scheduler.acquire()
        : { ...await fallbackMedia.acquire(), profile: scheduler?.getProfile?.() || null };
    const pending = new Map();
    const execute = async (job, index) => {
        let media, ai;
        try {
            media = await acquireMedia();
            return await job({ profile: media.profile,
                async finishMedia(needsEnhancement = true) {
                    media.release(); media = null;
                    if (needsEnhancement) ai = await enhancement.acquire();
                },
                async withMedia(work) {
                    const lease = await acquireMedia();
                    try { return await work(lease.profile); } finally { lease.release(); }
                }
            });
        } catch (error) { onError?.(error, index); return null; }
        finally { media?.release(); ai?.release(); }
    };
    return { submit(job, index) {
        if (pending.has(index)) throw new Error(`Duplicate clip job index: ${index}`);
        const promise = execute(job, index); pending.set(index, promise); return promise;
    }, async drain() {
        return (await Promise.all([...pending].sort((a, b) => a[0] - b[0]).map(([, promise]) => promise))).filter(Boolean);
    } };
}
async function runClipPipeline(jobs, options) {
    const pipeline = createClipPipeline(options);
    jobs.forEach((job, index) => pipeline.submit(job, index));
    return pipeline.drain();
}
module.exports = { createLimiter, createClipPipeline, runClipPipeline };
