'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { loadWorkflow } = require('../workflow-runtime');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { createClipResourceAdaptiveScheduler } = require('./resource_scheduler');

// Both producers supply their parsed source and media facade; no parent CLI imports.
async function applyStyles(results, context) {
    const { config, rootConfig, info, topic, parsed, danmaku, options } = context;
    const styles = config.editorialStyles;
    if (!styles?.enabled || options.planOnly) return results;
    const workflow = loadWorkflow('clipping/editorialSelection');
    const settings = { ...rootConfig.ownStreamClips?.enhancements, ...config.enhancements };
    const scheduler = createClipResourceAdaptiveScheduler({ ownConfig: config, rootConfig });
    const withMedia = async work => { const lease = await scheduler.acquire(); try { return await work(lease.profile); } finally { lease.release(); } };
    const ffmpegPath = options.ffmpegPath || rootConfig.ffmpegPath || 'ffmpeg';
    const ffprobe = topic.resolveFfprobePath(ffmpegPath);
    const mediaIO = loadWorkflow('clipping/editorialMedia').editorialMediaIO(config, ffprobe,
        args => withMedia(profile => topic.runFfmpeg(args, { ...config, ffmpegPath, threads: profile?.ffmpegThreads })));
    const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const request = (phase, prompt) => {
        if (rootConfig.ai?.text?.enabled === false || config.ai?.enabled === false) throw new Error('AI is disabled');
        return require('./enhancement_runner').requestStage({ ...settings.stageDefaults, ...settings.stages?.selection }, settings.budget,
            { ...info, sessionId: info.sessionId || options.srtPath, outputContract: { key: 'choices', type: 'array' } }, phase, prompt);
    };
    return workflow.applyEditorialChoices(results, styles, {
        candidate: async (artifact, id) => {
            const binding = { baselineMediaSha256: digest(artifact.output.mediaPath), baselineSubtitlesSha256: digest(artifact.output.srtPath),
                baselineMetadataSha256: digest(artifact.output.metadataPath) };
            return { id, title: artifact.copy.title, binding, duration: (await mediaIO.probe(artifact.output.mediaPath)).duration,
                subtitles: loadWorkflow('clipping/editorialStyle').parseSrt(fs.readFileSync(artifact.output.srtPath, 'utf8')) };
        },
        request: async prompt => (await request('editorial-style-selection', prompt)).text,
        highlight: async (baseline, plan) => {
            const revision = await loadWorkflow('clipping/editorialRuntime').renderHighlightFirst({
                metadata: baseline.output.metadataPath,
                opManifest: path.resolve(__dirname, '../../..', workflow.chooseOpManifest(styles)),
                plan,
                output: path.join(path.dirname(baseline.output.metadataPath), `highlight-first-${randomUUID()}`)
            }, mediaIO);
            const current = { ...baseline, style: 'highlight_first', generatedAt: revision.generatedAt,
                sourceWindow: { ...baseline.window }, window: { ...baseline.window, duration: revision.output.duration },
                editorialTimeline: revision.editorialTimeline,
                qaRequired: true, qaResult: { version: 1, status: 'pending' },
                output: { ...baseline.output, ...revision.output,
                    copyPath: path.join(path.dirname(revision.output.metadataPath), 'COPY.md') } };
            delete current.publicationReview; delete current.publicationDecision; delete current.automaticQaRepair;
            // Same complete body and public copy, new artifact hashes; final content/OP QA still required.
            return require('./actor_artifact_binding').bindActorArtifacts(current);
        },
        precision: async (baseline, reason) => {
            if (rootConfig.ai?.text?.enabled === false || config.ai?.enabled === false) throw new Error('AI is disabled');
            const precisionExperiment = { version: 1, selected: true, reason, selectionMode: 'editorial_style' };
            const clip = { ...baseline.copy, ...(context.clips?.[baseline.window.index - 1] || {}), ...baseline.window,
                attributionRequired: baseline.attributionRequired, attributionReview: baseline.attributionReview,
                grounding: baseline.grounding, precisionExperiment };
            const precisionConfig = { ...config, enhancements: { ...settings, enabled: true, workflow: 'creative' } };
            let current = await require('./creative_runner').runCreativeEnhancement({ ...baseline, precisionExperiment }, {
                config: precisionConfig, info, parsed, danmaku, source: baseline.source, options: { ...options, config: rootConfig }, topic, clip,
                subtitleEvidence: context.evidence || require('./subtitle_evidence').buildSubtitleEvidence(parsed.segments),
                execution: { withMedia }
            }, { requestStage: require('./enhancement_runner').requestStage,
                probeMedia: (file, executable) => mediaIOProbe(file, executable || ffprobe) });
            if (current.creativeResult?.status === 'edited' && clip.attributionRequired) current = require('./precision_actor_review')
                .finalizePrecisionActors(current, clip, context.evidence || require('./subtitle_evidence').buildSubtitleEvidence(parsed.segments));
            return require('./actor_artifact_binding').bindActorArtifacts(current);
        },
        save: async artifact => {
            writeJsonAtomic(artifact.output.metadataPath, artifact);
            if (artifact.output.copyPath && topic.writeCopyMarkdown) topic.writeCopyMarkdown(artifact.copy, artifact, artifact.output.copyPath);
        }
    });
}

function mediaIOProbe(file, ffprobe) {
    return new Promise((resolve, reject) => require('child_process').execFile(ffprobe,
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
        { windowsHide: true, shell: false, timeout: 30000, encoding: 'utf8' }, (error, stdout) => {
            if (error) return reject(error);
            try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        }));
}

async function finishTopicStylesAndReview(results, context, io) {
    const styled = await applyStyles(results, { ...context, topic: io });
    results.splice(0, results.length, ...styled);
    if (!context.publicationActive) return;
    const finals = results.filter(result => !io.isPendingTopicResult(result));
    const reviewed = await require('./topic_automatic_publication').reviewTopicFinals(finals, {
        ...context, ffmpegTimeoutMs: context.config.ffmpegTimeoutMs
    }, io);
    finals.forEach((result, index) => { results[results.indexOf(result)] = reviewed[index]; });
}
module.exports = { applyStyles, finishTopicStylesAndReview };
