'use strict';
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { createClipResourceAdaptiveScheduler } = require('./resource_scheduler');
const { createIncrementalRender } = require('./incremental_render');
const { runClipPipeline, createClipPipeline } = require('./clip_pipeline');

async function produceOwnClips(context, hooks) {
    const { options, config, rootConfig, parsed, danmaku, evidence, info, outputRoot, diagnostics, metadata } = context;
    let clips = context.clips, results = [], experiment;
    const base = options.planPath ? path.basename(options.planPath, path.extname(options.planPath)).replace(/[<>:"/\\|?*]/g, '_') : null;
    const planPath = path.join(outputRoot, base ? `${base}_ALIGNED.json` : 'PLAN.json');
    const reviewPath = path.join(outputRoot, base ? `REVIEW_${base}.md` : 'REVIEW.md');
    Object.assign(metadata, { planPath, reviewPath, uploadManifestPath: path.join(outputRoot, base ? `${base}_UPLOAD_MANIFEST.json` : 'UPLOAD_MANIFEST.json') });
    const source = { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath || null };
    const savePlan = (current, status) => {
        metadata.aiStatus.requests = diagnostics.requests || [];
        if (diagnostics.attribution) metadata.aiStatus.attribution = diagnostics.attribution;
        writeJsonAtomic(planPath, { version: 1, generatedAt: new Date().toISOString(), status, source,
            config: { maxCandidates: config.maxCandidates, maxClips: config.maxClips, minClipSeconds: config.minClipSeconds,
                maxClipSeconds: config.maxClipSeconds, aiDurationPolicy: 'content_complete', chunkSeconds: config.chunkSeconds, aiConcurrency: config.aiConcurrency,
                clipConcurrency: config.clipConcurrency, clipFfmpegThreads: config.clipFfmpegThreads,
                aiStrategy: config.ai?.strategy, aiModel: config.ai?.model,
                viewingAnglesVersion: 1, recallMaxClipsPerChunk: config.ai?.recallMaxClipsPerChunk,
                selectionPolicy: config.selectionPolicy,
                maxCandidateLines: config.ai?.maxCandidateLines, subtitleEvidenceFormat: `complete_grouped_v${evidence.version}`,
                subtitleTruncation: false, maxCandidateDanmakuLines: config.ai?.maxCandidateDanmakuLines, parallel: config.parallel,
                rankThenEdit: config.ai?.rankThenEdit || null, streamReviewRendering: config.streamReviewRendering === true,
                attribution: config.attribution },
            aiStatus: metadata.aiStatus, ...(experiment?.summary ? { precisionExperiment: experiment.summary } : {}),
            ...(parsed.participantContext ? { participantContext: parsed.participantContext } : {}), clips: current });
    };
    const scheduler = createClipResourceAdaptiveScheduler({ ownConfig: config, rootConfig });
    const enhancementsEnabled = require('./enhancement_runner').enhancementEnabled(config.enhancements, info.roomId);
    const creative = enhancementsEnabled && config.enhancements.workflow === 'creative';
    const pipelineOptions = { scheduler, mediaConcurrency: scheduler.enabled ? scheduler.maxConcurrency : config.clipConcurrency,
        enhancementConcurrency: Number(config.enhancementConcurrency) || 3,
        onError: (error, index) => {
            metadata.aiStatus.renderErrors ||= [];
            metadata.aiStatus.renderErrors.push({ index: index + 1, title: clips[index].title,
                start: clips[index].start, end: clips[index].end, error: error.message });
        } };
    const streaming = config.streamReviewRendering === true && !options.planOnly
        && (!enhancementsEnabled || config.enhancements.workflow === 'pacing' || creative);
    let started = new Date();
    if (streaming) {
        const pacingScanBudget = { remainingSeconds: config.enhancements?.pacing?.maxScannedSeconds || 120 };
        const incremental = createIncrementalRender({ outputRoot, source, config, initialClips: clips, pipelineOptions, label: base || 'PLAN',
            // Global creative selection happens after ordinary baselines, never in each review batch.
            prepare: batch => creative ? { clips: batch.map(clip => ({ ...clip, precisionExperiment: undefined })) }
                : hooks.prepare(batch, { ...options, pacingScanBudget }),
            render: (clip, index, execution) => hooks.render(clip, index, { ...execution, deferEnhancement: creative }) });
        metadata.progressPath = incremental.progressPath;
        savePlan(clips.map(clip => ({ ...clip, publicCopyPending: true, uploadReady: false })), 'reviewing');
        let reviewError;
        try { await hooks.review(clips, { onBatchReviewed: incremental.submitBatch }); }
        catch (error) { reviewError = error; }
        const produced = await incremental.finish();
        if (reviewError) throw reviewError;
        clips = produced.clips; results = produced.results;
        if (creative) {
            experiment = await hooks.prepare(clips, options); clips = experiment.clips;
            if (experiment.summary) metadata.precisionExperiment = experiment.summary;
            results = results.map(result => ({ ...result, precisionExperiment: clips[result.window.index - 1].precisionExperiment }));
            results.forEach(result => writeJsonAtomic(result.output.metadataPath, result.precisionExperiment?.selected
                ? { ...result, uploadReady: false, qaRequired: true, qaResult: { version: 1, status: 'pending' }, creativeResult: { status: 'pending' } }
                : result));
            const selected = results.filter(result => result.precisionExperiment?.selected);
            if (selected.length) {
                metadata.precisionDelivery = { version: 1, phase: 'ordinary_ready', selected: selected.map(result => ({
                    index: result.window.index, title: result.copy.title, start: result.window.start, end: result.window.end,
                    reason: result.precisionExperiment.reason })) };
                savePlan(clips, 'precision_pending');
                await hooks.ordinaryReady?.(results.filter(result => !result.precisionExperiment?.selected));
                const pipeline = createClipPipeline(pipelineOptions);
                for (const baseline of selected) {
                    const index = baseline.window.index - 1;
                    const enhanced = await pipeline.submit(execution => hooks.enhance(baseline, clips[index], index, execution), index);
                    const result = enhanced || { ...baseline, precisionExperiment: { ...baseline.precisionExperiment, selected: false, attempted: true },
                        creativeResult: { status: 'kept_original', reason: '精切任务异常，保留已完成的普通版' } };
                    writeJsonAtomic(result.output.metadataPath, result);
                    results[index] = result;
                }
                metadata.precisionDelivery.phase = 'precision_complete';
            }
        } else if (produced.summaries.length) {
            experiment = { summary: { version: 1, workflow: config.enhancements?.workflow, scope: 'review_batches',
                total: clips.length, maxSelected: Math.min(config.enhancements.experiment.maxClips,
                    Math.floor(clips.length * config.enhancements.experiment.ratio)), batches: produced.summaries,
                selected: produced.summaries.flatMap(summary => summary.selected || []) } };
            experiment.summary.reason = experiment.summary.selected.length ? 'verified_pause_candidates' : 'no_verified_pauses';
        }
        savePlan(clips, 'complete');
    } else {
        clips = await hooks.review(clips);
        experiment = await hooks.prepare(clips, options); clips = experiment.clips;
        savePlan(clips, 'complete');
        if (!options.planOnly) {
            started = new Date();
            const selected = clips.map((clip, index) => ({ clip, index })).filter(row => row.clip.precisionExperiment?.selected);
            if (enhancementsEnabled && config.enhancements?.workflow === 'creative' && selected.length) {
                const pipeline = createClipPipeline(pipelineOptions);
                metadata.precisionExperiment = experiment.summary;
                metadata.precisionDelivery = { version: 1, phase: 'ordinary_ready', selected: selected.map(({ clip, index }) =>
                    ({ index: index + 1, title: clip.title, start: clip.start, end: clip.end, reason: clip.precisionExperiment.reason })) };
                savePlan(clips, 'precision_pending');
                const ordinary = clips.map((clip, index) => ({ clip, index })).filter(row => !row.clip.precisionExperiment?.selected);
                results = (await Promise.all(ordinary.map(({ clip, index }) => pipeline.submit(execution => hooks.render(clip, index, execution), index)))).filter(Boolean);
                await hooks.ordinaryReady?.(results);
                await Promise.all(selected.map(({ clip, index }) => pipeline.submit(execution => hooks.render(clip, index, execution), index)));
                results = await pipeline.drain();
                metadata.precisionDelivery.phase = 'precision_complete';
                savePlan(clips, 'complete');
            } else results = await runClipPipeline(clips.map((clip, index) => execution => hooks.render(clip, index, execution)), pipelineOptions);
        }
    }
    if (experiment?.summary) metadata.precisionExperiment = experiment.summary;
    if (options.planOnly) {
        fs.writeFileSync(reviewPath, hooks.planReview(clips, metadata), 'utf8');
        console.log(`Plan only: ${planPath}`);
    } else {
        const ended = new Date();
        metadata.processingStats = { ...hooks.stats(results, ended - started, started.toISOString(), ended.toISOString()),
            overlapsAttributionReview: streaming };
    }
    return { clips, results, planPath, reviewPath };
}
module.exports = { produceOwnClips };
