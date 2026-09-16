'use strict';
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { createClipResourceAdaptiveScheduler } = require('./resource_scheduler');
const { createIncrementalRender } = require('./incremental_render');
const { runClipPipeline } = require('./clip_pipeline');

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
    const pipelineOptions = { scheduler, mediaConcurrency: scheduler.enabled ? scheduler.maxConcurrency : config.clipConcurrency,
        enhancementConcurrency: Number(config.enhancementConcurrency) || 3,
        onError: (error, index) => {
            metadata.aiStatus.renderErrors ||= [];
            metadata.aiStatus.renderErrors.push({ index: index + 1, title: clips[index].title,
                start: clips[index].start, end: clips[index].end, error: error.message });
        } };
    const streaming = config.streamReviewRendering === true && !options.planOnly
        && (!config.enhancements?.enabled || config.enhancements.workflow === 'pacing');
    let started = new Date();
    if (streaming) {
        const pacingScanBudget = { remainingSeconds: config.enhancements?.pacing?.maxScannedSeconds || 120 };
        const incremental = createIncrementalRender({ outputRoot, source, config, initialClips: clips, pipelineOptions, label: base || 'PLAN',
            prepare: batch => hooks.prepare(batch, { ...options, pacingScanBudget }), render: hooks.render });
        metadata.progressPath = incremental.progressPath;
        savePlan(clips.map(clip => ({ ...clip, publicCopyPending: true, uploadReady: false })), 'reviewing');
        let reviewError;
        try { await hooks.review(clips, { onBatchReviewed: incremental.submitBatch }); }
        catch (error) { reviewError = error; }
        const produced = await incremental.finish();
        if (reviewError) throw reviewError;
        clips = produced.clips; results = produced.results;
        if (produced.summaries.length) {
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
            results = await runClipPipeline(clips.map((clip, index) => execution => hooks.render(clip, index, execution)), pipelineOptions);
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
