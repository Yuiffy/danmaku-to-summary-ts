'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { createLimiter, createClipPipeline } = require('./clip_pipeline');
const { fileDigest } = require('./actor_artifact_binding');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Each reviewed batch is durable before rendering. Only a complete final manifest is registered for upload. */
function createIncrementalRender({ outputRoot, source, config, initialClips, pipelineOptions, prepare, render, label = 'PLAN' }) {
    const directory = path.join(outputRoot, 'temp', 'reviewed_batches');
    fs.mkdirSync(directory, { recursive: true });
    const progressPath = path.join(outputRoot, `${label}_PROGRESS.json`);
    const lockPath = progressPath + '.lock';
    if (fs.existsSync(lockPath)) {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid incremental render lock owner');
        try { process.kill(owner.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') fs.unlinkSync(lockPath); else throw error; }
    }
    const sourceStat = fs.statSync(source.mediaPath);
    const sourceKey = { media: path.resolve(source.mediaPath), bytes: sourceStat.size, mtimeMs: sourceStat.mtimeMs,
        subtitles: hash(fs.readFileSync(source.srtPath, 'utf8')), audience: source.xmlPath ? hash(fs.readFileSync(source.xmlPath, 'utf8')) : null };
    const progress = { version: 1, status: 'reviewing', source: sourceKey, startedAt: new Date().toISOString(),
        total: initialClips.length, entries: initialClips.map((clip, index) => ({ index, start: clip.start, end: clip.end, status: 'awaiting_review' })) };
    const pipeline = createClipPipeline(pipelineOptions), preparation = createLimiter(1);
    const lock = fs.openSync(lockPath, 'wx'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    let released = false;
    const release = () => { if (!released) { released = true; fs.closeSync(lock); fs.unlinkSync(lockPath); } };
    const queued = new Set(), tasks = [], reviewed = [...initialClips], summaries = [], results = new Map();
    const save = () => writeJsonAtomic(progressPath, { ...progress, updatedAt: new Date().toISOString() });
    try { save(); } catch (error) { release(); throw error; }
    const submitBatch = async items => {
        if (!items.length) return;
        for (const item of items) {
            if (queued.has(item.index)) throw new Error(`Duplicate reviewed index ${item.index}`);
            queued.add(item.index); reviewed[item.index] = item.clip;
        }
        const batchKey = hash({ version: 1, sourceKey, config, items });
        const batchPath = path.join(directory, `${batchKey}.json`);
        if (!fs.existsSync(batchPath)) writeJsonAtomic(batchPath, { version: 1, source, sourceKey, items, batchKey });
        items.forEach(item => Object.assign(progress.entries[item.index], { status: 'reviewed', snapshot: batchPath })); save();
        const task = (async () => {
            let prepared;
            const lease = await preparation.acquire();
            try { prepared = await prepare(items.map(item => item.clip)); }
            finally { lease.release(); }
            if (!Array.isArray(prepared.clips) || prepared.clips.length !== items.length) throw new Error('Batch preparation changed the clip count');
            if (prepared.summary) summaries.push({ ...prepared.summary, indices: items.map(item => item.index),
                selected: (prepared.summary.selected || []).map(row => ({ ...row, id: items[row.id - 1].index + 1 })) });
            await Promise.all(prepared.clips.map(async (clip, localIndex) => {
                const index = items[localIndex].index;
                if (clip.start !== items[localIndex].clip.start || clip.end !== items[localIndex].clip.end) throw new Error('Reviewed window changed before rendering');
                reviewed[index] = clip;
                const key = hash({ batchKey, index, clip });
                const receiptPath = path.join(directory, `${key}.rendered.json`);
                let result;
                try {
                    const saved = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
                    if (saved.key === key && saved.result.output?.burnedSubtitles && !saved.result.output.mediaError
                        && ['metadataPath', 'mediaPath', 'srtPath'].every(name => typeof saved.digests?.[name] === 'string')) {
                        const matches = await Promise.all(Object.entries(saved.digests).map(async ([name, digest]) =>
                            await fileDigest(saved.result.output[name]) === digest));
                        if (matches.every(Boolean)) result = saved.result;
                    }
                } catch { /* Incomplete/stale outputs are regenerated under the same stable index. */ }
                if (!result) {
                    Object.assign(progress.entries[index], { status: 'rendering' }); save();
                    result = await pipeline.submit(execution => render(clip, index, execution), index);
                    if (!result) {
                        const metadataPath = path.join(outputRoot, `failed_${index + 1}_${key.slice(0, 16)}.json`);
                        result = { version: 1, mode: 'own_stream_fun_review', status: 'render_failed', source,
                            window: { index: index + 1, start: clip.start, end: clip.end, duration: clip.end - clip.start },
                            copy: { title: clip.title || `待复核候选 ${index + 1}`, description: clip.description || '', coverText: clip.coverText || '' },
                            grounding: clip.grounding, attributionReview: clip.attributionReview, publicCopyPending: true, uploadReady: false,
                            output: { metadataPath, mediaPath: null, srtPath: null, coverPath: null, burnedSubtitles: false,
                                mediaError: `Rendering failed for clip ${index + 1}; inspect batch diagnostics` } };
                        writeJsonAtomic(metadataPath, result);
                    }
                    if (!result.output.mediaError && (!result.output.burnedSubtitles || !result.output.mediaPath
                        || !fs.existsSync(result.output.mediaPath) || !fs.statSync(result.output.mediaPath).size)) {
                        result = { ...result, uploadReady: false, output: { ...result.output, mediaError: 'Missing, empty or unburned rendered video' } };
                        writeJsonAtomic(result.output.metadataPath, result);
                    }
                    const digests = {};
                    for (const name of ['metadataPath', 'mediaPath', 'srtPath', 'coverPath']) {
                        if (result.output[name] && fs.existsSync(result.output[name])) digests[name] = await fileDigest(result.output[name]);
                    }
                    writeJsonAtomic(receiptPath, { version: 1, key, result, digests });
                }
                results.set(index, result);
                Object.assign(progress.entries[index], { status: result.output.mediaError ? 'failed' : result.uploadReady ? 'rendered_for_review' : 'needs_review',
                    metadataPath: result.output.metadataPath, completedAt: new Date().toISOString() }); save();
                console.log(`[CLIP_PROGRESS] ${JSON.stringify({ index: index + 1, ready: result.uploadReady, mediaPath: result.output.mediaPath })}`);
            }));
        })().catch(error => {
            items.forEach(item => { if (!results.has(item.index)) Object.assign(progress.entries[item.index], { status: 'failed', error: error.message }); });
            save(); return { error };
        });
        tasks.push(task);
    };
    return { submitBatch, progressPath, async finish() {
        try {
        const completed = await Promise.all(tasks); await pipeline.drain();
        const errors = completed.filter(value => value?.error).map(value => value.error);
        const finalStat = fs.statSync(source.mediaPath);
        if (finalStat.size !== sourceKey.bytes || finalStat.mtimeMs !== sourceKey.mtimeMs
            || hash(fs.readFileSync(source.srtPath, 'utf8')) !== sourceKey.subtitles
            || (source.xmlPath && hash(fs.readFileSync(source.xmlPath, 'utf8')) !== sourceKey.audience)) errors.push(new Error('Source changed during incremental rendering'));
        progress.status = errors.length || queued.size !== initialClips.length ? 'incomplete' : 'complete'; save();
        if (errors.length || queued.size !== initialClips.length) throw new Error(`Incremental rendering incomplete: ${errors.map(error => error.message).join('; ')}`);
        return { clips: reviewed, results: [...results].sort((a, b) => a[0] - b[0]).map(([, result]) => result), summaries };
        } finally { release(); }
    } };
}
module.exports = { createIncrementalRender };
