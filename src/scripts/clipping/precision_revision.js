'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { fileDigest, sourceSnapshot } = require('./source_snapshot');
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { loadWorkflow } = require('../workflow-runtime');

async function renderPrecisionRevision(options, dependencies = {}) {
    const id = Number(options.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('A positive numeric clip ID is required');
    const registry = JSON.parse(fs.readFileSync(options.registryPath, 'utf8'));
    const record = registry.clips?.[String(id)];
    if (!record?.metadataPath || !record.reviewPlanPath) throw new Error('Clip has no own-stream metadata/plan');
    if (['queued', 'rendering', 'uploading'].includes(record.status) || record.pendingRebuild) throw new Error('Clip has an active upload or subtitle revision');
    const metadataPath = path.resolve(record.metadataPath);
    const { lock, lockPath } = require('../render_topic_candidate').acquireCandidateLock(metadataPath, id);
    let directory;
    try {
        const before = fs.readFileSync(metadataPath, 'utf8'), original = JSON.parse(before);
        if (original.mode !== 'own_stream_fun_review' || !original.uploadReady || original.rebuildRequired
            || original.publicCopyPending || original.output?.mediaError || !original.output?.burnedSubtitles
            || (original.uploadId && original.uploadId !== id)) throw new Error('A reviewed ordinary own-stream clip is required');
        if (original.creativeResult?.status === 'edited' || original.editPlan?.removed?.length) {
            throw new Error('Use the original ordinary clip; an edited artifact cannot serve as the baseline');
        }
        const topic = dependencies.topic || require('../topic_clipper');
        const own = require('../own_stream_clipper');
        const rootConfig = dependencies.rootConfig || require('../config-loader').getConfig();
        const config = own.getOwnStreamClipsConfig(rootConfig);
        if (options.style) {
            if (!['accent', 'compact'].includes(options.style)) throw new Error('Unknown precision style');
            const previousStyle = config.enhancements.creative?.style || 'accent';
            config.enhancements = { ...config.enhancements, creative: { ...config.enhancements.creative,
                ...(options.style === 'compact' && previousStyle !== 'compact' ? { maxMoments: 24, maxZoom: 5 } : {}), style: options.style } };
        }
        if (options.avatarMode) {
            if (!['auto', 'circle', 'closeup'].includes(options.avatarMode)) throw new Error('Unknown avatar presentation');
            config.enhancements = { ...config.enhancements, creative: { ...config.enhancements.creative, avatarMode: options.avatarMode } };
        }
        if (options.coverTextPosition && !['center', 'bottom'].includes(options.coverTextPosition)) {
            throw new Error('Unknown cover text position');
        }
        if (config.enhancements?.workflow !== 'creative'
            || !require('./enhancement_runner').enhancementEnabled(config.enhancements, original.roomId)) {
            throw new Error('Creative enhancement is not enabled for this room');
        }
        const snapshot = sourceSnapshot(original);
        let insetPlan;
        if (options.insetPlanPath) {
            insetPlan = JSON.parse(fs.readFileSync(options.insetPlanPath, 'utf8'));
            if (insetPlan.version !== 1 || insetPlan.clipId !== id || insetPlan.sourceMetadataSha256 !== fileDigest(metadataPath)
                || !/^[a-f0-9]{64}$/.test(insetPlan.timelineSha256 || '')) throw new Error('Inset plan is not bound to this clip and original metadata');
            config.enhancements = { ...config.enhancements, creative: { ...config.enhancements.creative, avatarMode: 'circle' } };
        }
        let resumeDirectory;
        if (options.resumeFrom) {
            resumeDirectory = path.resolve(options.resumeFrom);
            const previous = JSON.parse(fs.readFileSync(path.join(resumeDirectory, 'clip.json'), 'utf8'));
            if (previous.precisionRevision?.clipId !== id
                || fs.readFileSync(path.join(resumeDirectory, 'original.json'), 'utf8') !== before
                || JSON.stringify(previous.precisionRevision.sourceSnapshot) !== JSON.stringify(snapshot)) {
                throw new Error('Resume source does not match this ID, baseline and original evidence');
            }
        }
        let soundLevelOverrides;
        if (options.soundLevelOverridesPath) {
            if (!resumeDirectory) throw new Error('Sound level overrides require a matching resume revision');
            const overrides = JSON.parse(fs.readFileSync(options.soundLevelOverridesPath, 'utf8'));
            const priorPlanPath = path.join(resumeDirectory, 'temp', 'clip-creative', 'creative-plan.json');
            if (overrides.version !== 1 || overrides.clipId !== id || overrides.planSha256 !== fileDigest(priorPlanPath)
                || !Array.isArray(overrides.sounds) || !overrides.sounds.length
                || overrides.sounds.some(row => !/^M[1-9][0-9]*$/.test(row.momentId)
                    || !Number.isFinite(row.levelDb) || row.levelDb < -12 || row.levelDb > 0)
                || new Set(overrides.sounds.map(row => row.momentId)).size !== overrides.sounds.length) {
                throw new Error('Sound level overrides are not bound to the previous plan');
            }
            const priorPlan = JSON.parse(fs.readFileSync(priorPlanPath, 'utf8')).plan;
            if (overrides.sounds.some(row => !priorPlan.effects.some(effect => effect.id === row.momentId && effect.sound))) {
                throw new Error('Sound level override does not target an existing effect');
            }
            soundLevelOverrides = overrides.sounds;
        }
        const parsed = topic.parseTopicSrt(original.source.srtPath);
        const evidence = buildSubtitleEvidence(parsed.segments);
        const plan = JSON.parse(fs.readFileSync(record.reviewPlanPath, 'utf8'));
        const clip = plan.clips?.find(row => row.start === original.window.start && row.end === original.window.end);
        if (!clip || (clip.attributionRequired && evidence.sourceSha256 !== original.attributionReview?.sourceSha256)
            || loadWorkflow('clipping/experiment').experimentEligibility(clip, evidence.sourceSha256)) {
            throw new Error('Source evidence or original attribution review is stale');
        }
        const digests = { video: fileDigest(original.output.mediaPath), subtitles: fileDigest(original.output.srtPath),
            cover: fileDigest(original.output.coverPath) };
        for (const [key, value] of Object.entries(original.attributionReview?.artifactDigests || {})) {
            if (digests[key] && value !== digests[key]) throw new Error(`Original ${key} changed since review`);
        }
        const subtitles = topic.parseTopicSrt(original.output.srtPath).segments;
        if (!subtitles.length || subtitles.some(cue => cue.start < 0 || cue.end <= cue.start
            || cue.end > original.window.duration + .001)) throw new Error('Invalid baseline subtitle timeline');
        const danmaku = await own.parseDanmakuXml(original.source.xmlPath);
        const parent = path.join(path.dirname(metadataPath), 'precision_revisions', String(id));
        fs.mkdirSync(parent, { recursive: true });
        directory = fs.mkdtempSync(path.join(parent, 'r-'));
        fs.writeFileSync(path.join(directory, 'original.json'), before, { flag: 'wx' });
        if (insetPlan) writeJsonAtomic(path.join(directory, 'inset-editorial-plan.json'), insetPlan);
        const outputMetadata = path.join(directory, 'clip.json'), revisionSrt = path.join(directory, 'clip.srt');
        fs.copyFileSync(original.output.srtPath, revisionSrt);
        const revision = { version: 1, clipId: id, createdAt: new Date().toISOString(), note: String(options.note || ''),
            originalMetadataPath: metadataPath, originalDigests: digests, sourceSnapshot: snapshot, style: config.enhancements.creative?.style || 'accent',
            avatarMode: config.enhancements.creative?.avatarMode || 'auto',
            ...(options.allowCoverFaceOverlap ? { coverFaceOverlapApproved: true } : {}),
            ...(resumeDirectory ? { resumeFrom: resumeDirectory } : {}), uploadAuthorized: false };
        const baseline = { ...original, uploadId: id, reviewIndex: record.reviewIndex,
            output: { ...original.output, metadataPath: outputMetadata, srtPath: revisionSrt },
            processing: { resourcePeaks: [] }, precisionRevision: revision,
            precisionExperiment: { ...original.precisionExperiment, selected: true, attempted: true, reason: 'explicit_local_precision_revision' } };
        delete baseline.creativeResult;
        delete baseline.creativePlan;
        delete baseline.enhancement;
        delete baseline.qaResult;
        delete baseline.qaRequired;
        const scheduler = require('./resource_scheduler').createClipResourceAdaptiveScheduler({ ownConfig: config, rootConfig });
        const execution = { async withMedia(work) {
            const lease = await scheduler.acquire();
            try {
                baseline.processing.resourceMode = lease.profile.mode;
                baseline.processing.ffmpegThreads = lease.profile.ffmpegThreads;
                return await work(lease.profile);
            } finally { lease.release(); }
        } };
        console.log(`PRECISION_STARTED: ${JSON.stringify({ id, directory })}`);
        const enhance = dependencies.enhance || require('./enhancement_runner').runEnhancements;
        let result = await enhance(baseline, { config, info: { roomId: original.roomId, recordedAt: original.recordedAt,
            sessionId: directory, selectionCacheDirectory: path.join(directory, 'temp') }, parsed, danmaku,
            source: { kind: 'video', mediaPath: original.source.mediaPath }, options: { ...original.source, config: rootConfig,
                creativeResumeDirectory: resumeDirectory, creativeInsetPlan: insetPlan, creativeSoundLevelOverrides: soundLevelOverrides,
                creativeCoverTextPosition: options.coverTextPosition,
                creativeAllowCoverFaceOverlap: options.allowCoverFaceOverlap === true },
            topic, clip, subtitleEvidence: evidence, execution });
        if (fs.readFileSync(metadataPath, 'utf8') !== before || JSON.stringify(sourceSnapshot(original)) !== JSON.stringify(snapshot)
            || fileDigest(original.output.mediaPath) !== digests.video || fileDigest(revisionSrt) !== digests.subtitles) {
            throw new Error('Source or baseline changed during precision rendering');
        }
        if (clip.attributionRequired && result.creativeResult?.status === 'edited' && result.qaResult?.status === 'passed') {
            result = require('./precision_actor_review').finalizePrecisionActors(result, clip, evidence);
            result = await require('./actor_artifact_binding').bindActorArtifacts(result);
        }
        const passed = result.creativeResult?.status === 'edited' && result.qaResult?.status === 'passed'
            && result.uploadReady && !result.publicCopyPending;
        result = { ...result, uploadReady: false, precisionRevision: { ...revision,
            completedAt: new Date().toISOString(), status: passed ? 'pending_review' : 'failed' } };
        writeJsonAtomic(outputMetadata, result);
        const summary = { id, status: result.precisionRevision.status, metadataPath: outputMetadata,
            mediaPath: result.output.mediaPath, srtPath: result.output.srtPath, coverPath: result.output.coverPath,
            effectCount: result.creativePlan?.effects.length || 0, duration: result.window.duration,
            removedSeconds: result.creativePlan?.timeline?.removedSeconds || 0, reason: result.creativeResult?.reason,
            qaStatus: result.qaResult?.status || null, uploadAuthorized: false };
        writeJsonAtomic(path.join(directory, 'RESULT.json'), summary);
        writeJsonAtomic(path.join(parent, 'latest.json'), summary);
        fs.writeFileSync(path.join(directory, 'REVIEW.md'), `# ID${id} 精切重渲染\n\n状态：${summary.status}\n\n视频：${summary.mediaPath}\n\n效果节点：${summary.effectCount}\n\n质检：${summary.qaStatus}\n\n原稿与线上投稿保留，新版待人工查看。\n`, 'utf8');
        return summary;
    } catch (error) {
        if (directory) writeJsonAtomic(path.join(directory, 'ERROR.json'), { id, error: error.message, uploadAuthorized: false });
        throw error;
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}

module.exports = { renderPrecisionRevision };
if (require.main === module) {
    const { values } = parseArgs({ options: { id: { type: 'string' }, registry: { type: 'string' }, note: { type: 'string' }, style: { type: 'string' }, 'avatar-mode': { type: 'string' }, 'inset-plan': { type: 'string' }, 'resume-from': { type: 'string' }, 'sound-level-overrides': { type: 'string' }, 'cover-text-position': { type: 'string' }, 'allow-cover-face-overlap': { type: 'boolean' } } });
    renderPrecisionRevision({ id: values.id, registryPath: values.registry, note: values.note, style: values.style,
        avatarMode: values['avatar-mode'], insetPlanPath: values['inset-plan'], resumeFrom: values['resume-from'], soundLevelOverridesPath: values['sound-level-overrides'], coverTextPosition: values['cover-text-position'], allowCoverFaceOverlap: values['allow-cover-face-overlap'] })
        .then(result => { console.log('PRECISION_RESULT: ' + JSON.stringify(result)); if (result.status !== 'pending_review') process.exitCode = 1; })
        .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
