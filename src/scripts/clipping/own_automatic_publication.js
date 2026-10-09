'use strict';
const topic = require('../topic_clipper');
const { createClipResourceAdaptiveScheduler } = require('./resource_scheduler');

// Extracted process adapters retain the original final-review behavior.
async function inspectFinals(results, { runtime, automatic, config, rootConfig, info, streamerName, options, mediaConfig, evidence, audience, persist }) {
    const scheduler = createClipResourceAdaptiveScheduler({ ownConfig: config, rootConfig });
    const settings = config.enhancements || {};
    const reviewContext = {
            config: automatic, roomId: String(info.roomId), streamerName, excludedCategories: config.selectionPolicy.excludedCategories,
            ffmpegPath: options.ffmpegPath || 'ffmpeg', ffprobePath: topic.resolveFfprobePath(options.ffmpegPath || 'ffmpeg'),
            aiEnabled: config.ai?.enabled !== false && rootConfig.ai?.text?.enabled !== false, persist,
            configuredPeople: require('./person_evidence').buildPersonEvidenceContext(rootConfig, info.roomId)
                .map(({ id, label, names }) => ({ id, label, names }))
        };
    const request = (artifact, phase, prompt, images) => require('./enhancement_runner').requestStage(
        { ...settings.stageDefaults, ...settings.stages?.qa }, settings.budget,
        { ...info, outputContract: { key: 'checks', type: 'object', allowDomainRejected: true } }, `${phase}-${artifact.window.index}`, prompt, images);
    const adapters = {
            parse: file => topic.parseTopicSrt(file).segments, evidence, audience,
            request: (artifact, prompt, images) => request(artifact, 'publication', prompt, images),
            withMedia: async work => { const lease = await scheduler.acquire(); try { return await work(lease.profile); } finally { lease.release(); } },
            runFfmpeg: (args, profile) => topic.runFfmpeg(args, { ...mediaConfig, ffmpegThreads: profile?.ffmpegThreads || config.clipFfmpegThreads })
        };
    const inspections = new Map(), prepared = [];
    const quality = require('../workflow-runtime').loadWorkflow('clipping/ownRequiredReview');
    for (const artifact of results) {
        let current = artifact;
        try {
            if (artifact.qaRequired && reviewContext.aiEnabled && quality.ownAutomaticReviewEligible(artifact, automatic)) {
                const retained = adapters.parse(artifact.output.srtPath);
                const speech = adapters.parse(artifact.source.srtPath)
                    .filter(row => row.end > artifact.window.start - 30 && row.start < artifact.window.end + 30);
                current = await quality.reviewOwnRequiredQa(artifact, automatic, { speech, retained,
                    excludedCategories: reviewContext.excludedCategories }, {
                    snapshot: runtime.publicationSnapshot,
                    inspect: async row => {
                        const snapshot = await runtime.publicationSnapshot(row);
                        const inspection = await runtime.inspectPublicationMedia(row, retained, reviewContext, adapters);
                        inspections.set(row.output.metadataPath, { snapshot, inspection });
                        return inspection;
                    },
                    request: (prompt, images) => request(artifact, 'quality-current', prompt, images)
                });
            }
        } catch (error) { current = { ...artifact, automaticQaRepairError: String(error.message || error) }; }
        prepared.push(current);
    }
    return runtime.reviewOwnPublications(prepared, reviewContext, { ...adapters,
        inspect: async (artifact, retained) => {
            const cached = inspections.get(artifact.output.metadataPath);
            if (cached && JSON.stringify(cached.snapshot) === JSON.stringify(await runtime.publicationSnapshot(artifact))) return cached.inspection;
            return runtime.inspectPublicationMedia(artifact, retained, reviewContext, adapters);
        }
    });
}

async function reviewArtifactCopy(current, issues, context) {
            const parsed = require('../asr/asr_backends').parseSrt(current.source.srtPath, 'own_stream_clip');
            parsed.segments = require('../asr/evidence_sidecar').loadAsrEvidence(current.source.srtPath, parsed.segments).segments;
            const danmaku = current.source.xmlPath ? await context.audience(current.source.xmlPath) : [];
            const participants = require('./participant_context');
            const roster = participants.loadRecordingParticipants(current.source.srtPath, current.source.mediaPath, current.roomId,
                topic.loadAsrSpeakerSidecarForMediaPath(current.source.srtPath));
            parsed.participantContext = participants.buildParticipantContext(context.rootConfig, context.info, parsed, danmaku, roster);
            const originalEvidence = context.evidence(parsed.segments), helpers = context.copyHelpers;
            const evidence = current.automaticSubtitleRepair
                ? require('../workflow-runtime').loadWorkflow('clipping/ownSubtitleRepairRuntime').projectSubtitleRepairEvidence(originalEvidence, current)
                : originalEvidence;
            const prefix = helpers.buildClipDescription({ streamerName: current.streamerName, streamTitle: current.streamTitle,
                recordedAt: current.recordedAt, start: current.window.start, end: current.window.end, description: '' });
            const original = { ...current.copy, description: current.copy.description.startsWith(prefix + '\n\n')
                ? current.copy.description.slice(prefix.length + 2) : current.copy.description };
            const clip = { ...original, ...current.window, attributionRequired: true, grounding: current.grounding,
                publicationRepairFeedback: { issues, instruction: '仅根据完整原话修正这些文案问题，保留条件语气和准确数字；不能更改字幕或窗口，不能为通过审核猜测。',
                    ...(current.automaticSubtitleRepair ? { localAudioChecks: { edits: current.automaticSubtitleRepair.edits,
                        checks: current.automaticSubtitleRepair.checks }, audioScope: '局部双模型结果仅用于标记疑词，不能据此推断人物身份。' } : {}) } };
            const [reviewed] = await require('./actor_review_runner').reviewClipActors([clip], parsed, danmaku, evidence,
                context.info, context.config, context.rootConfig, {});
            const copy = { ...current.copy, title: reviewed.title, coverText: reviewed.coverText,
                description: helpers.buildClipDescription({ streamerName: current.streamerName, streamTitle: current.streamTitle,
                    recordedAt: current.recordedAt, start: current.window.start, end: current.window.end, description: reviewed.description }) };
            const updated = require('./actor_review').finalizeActorReview({ ...current, copy, grounding: reviewed.grounding,
                publicCopyPending: Boolean(reviewed.publicCopyPending), uploadReady: !reviewed.publicCopyPending }, reviewed, copy, evidence);
            return require('./actor_artifact_binding').bindActorArtifacts(updated);
}

function renderCopyCover(current, context, options = {}) {
    return topic.generateClipCover(current.output.mediaPath,
            context.copyHelpers.buildCoverTitle(current.copy.title, current.copy.coverText),
            require('path').join(require('path').dirname(current.output.metadataPath), 'automatic_copy_revisions', require('crypto').randomUUID()),
            { streamerName: current.streamerName, clipDuration: current.window.duration,
                coverSourcePath: current.source.mediaPath, clipStart: current.window.start,
                textPosition: options.textPosition || 'center' });
}

async function repairPublicCopy(artifact, context, required = {}) {
    const repair = require('../workflow-runtime').loadWorkflow('clipping/ownPublicationRepair');
    if (!repair.copyRepairEligible(artifact, context.automatic)) return artifact;
    return repair.repairOwnPublicCopy(artifact, context.automatic, required, {
        snapshot: require('../workflow-runtime').loadWorkflow('clipping/publicationRuntime').publicationSnapshot,
        reviewCopy: (current, issues) => reviewArtifactCopy(current, issues, context),
        renderCover: (current, options) => renderCopyCover(current, context, options),
        reviewFinal: async current => (await inspectFinals([current], context))[0]
    });
}

async function repairSubtitles(artifact, context, required = {}) {
    const repair = require('../workflow-runtime').loadWorkflow('clipping/ownSubtitleRepairRuntime');
    if (!repair.subtitleRepairEligible(artifact)) return artifact;
    const asr = require('../asr/asr_backends'), settings = asr.getAsrConfig(context.rootConfig), backend = settings.fun_asr_nano;
    if (backend.python_path_map?.length) throw new Error('Local subtitle repair requires a native Python path');
    const scheduler = createClipResourceAdaptiveScheduler({ ownConfig: context.config, rootConfig: context.rootConfig });
    return repair.repairOwnSubtitles(artifact, context.automatic, required, {
        parse: file => asr.parseSrt(file).segments,
        write: require('./candidate_subtitles').writeRevision,
        python: asr.resolvePythonCommand(backend), scriptPath: require('path').resolve(__dirname, '../python/ordinary_subtitle_audio.py'),
        protectedNames: require('./person_evidence').buildPersonEvidenceContext(context.rootConfig, context.info.roomId)
            .flatMap(person => [person.label, ...(person.names || [])]).filter(Boolean),
        settings: { model: backend.model, sensevoiceModel: settings.sensevoice.model, vadModel: backend.vad_model || 'fsmn-vad',
            device: backend.device, use_itn: false, resource_guard: { ...backend.resource_guard, torch_num_threads: 2 },
            gpu_throttle: backend.gpu_throttle, ffmpeg: context.options.ffmpegPath || context.rootConfig.ffmpegPath || 'ffmpeg',
            ffmpegThreads: context.config.clipFfmpegThreads || 2 },
        render: (current, srt, directory) => repair.renderRepairedSubtitles(current, srt, directory, {
            mediaConfig: context.mediaConfig, cutMedia: topic.cutClipMedia,
            withMedia: async work => { const lease = await scheduler.acquire(); try { return await work(lease.profile); } finally { lease.release(); } }
        }),
        reviewCopy: async current => {
            const reviewed = await reviewArtifactCopy(current, current.publicationReview.issues, context);
            if (JSON.stringify(reviewed.copy) === JSON.stringify(current.copy) || reviewed.publicCopyPending) return reviewed;
            return { ...reviewed, output: { ...reviewed.output, coverPath: await renderCopyCover(reviewed, context) } };
        },
        reviewFinal: async current => (await inspectFinals([current], context))[0]
    });
}

async function reviewFinals(results, context) {
    const reviewed = await inspectFinals(results, context);
    for (let i = 0; i < reviewed.length; i++) {
        if (context.boundaryTools && context.config.ai?.enabled !== false && context.rootConfig.ai?.text?.enabled !== false) {
            try {
                let repair;
                try { repair = require('../workflow-runtime').loadWorkflow('clipping/ownBoundaryRepair'); }
                catch (error) { if (error.message !== 'Unknown compiled workflow: clipping/ownBoundaryRepair') throw error; }
                if (repair) reviewed[i] = await repair.repairOwnBoundary(reviewed[i], context.automatic, context.boundaryCues,
                    reviewed.filter((_, index) => index !== i), {
                        snapshot: context.runtime.publicationSnapshot,
                        request: async prompt => (await require('./selection_request').requestSelectionText(prompt,
                            { primaryModel: context.config.ai?.model, structuredOutputKey: 'actions', maxTokens: 2000 },
                            context.config, context.rootConfig, context.info, 'final-boundary-tools', null,
                            result => { try { return Array.isArray(JSON.parse(result.text).actions); } catch { return false; } })).text,
                        ...context.boundaryTools,
                        reviewFinal: async current => (await inspectFinals([current], { ...context, persist: false }))[0],
                        persist: current => { if (context.persist !== false) require('./candidate_subtitles').writeJsonAtomic(current.output.metadataPath, current); }
                    });
            } catch (error) { reviewed[i] = { ...reviewed[i], automaticBoundaryRepairError: String(error.message || error) }; }
        }
        try { reviewed[i] = await repairPublicCopy(reviewed[i], context); }
        catch (error) { reviewed[i] = { ...reviewed[i], automaticCopyRepairError: String(error.message || error) }; }
        try { reviewed[i] = await repairSubtitles(reviewed[i], context); }
        catch (error) { reviewed[i] = { ...reviewed[i], automaticSubtitleRepairError: String(error.message || error) }; }
        if (context.persist !== false && reviewed[i] !== results[i] && reviewed[i].output?.metadataPath) {
            require('./candidate_subtitles').writeJsonAtomic(reviewed[i].output.metadataPath, reviewed[i]);
        }
    }
    return reviewed;
}
module.exports = { reviewFinals, inspectFinals, repairPublicCopy, repairSubtitles, reviewArtifactCopy, renderCopyCover };
