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
    if (!record?.metadataPath) throw new Error('Clip has no metadata');
    if (['queued', 'rendering', 'uploading'].includes(record.status) || record.pendingRebuild) throw new Error('Clip has an active upload or subtitle revision');
    const metadataPath = path.resolve(record.metadataPath);
    const { lock, lockPath } = require('../render_topic_candidate').acquireCandidateLock(metadataPath, id);
    let directory;
    try {
        const before = fs.readFileSync(metadataPath, 'utf8'), registered = JSON.parse(before);
        let original = registered;
        const keywordTopic = original.publicationKind === 'keyword_topic'
            || ['local_review', 'topic_candidate_manual_cut'].includes(original.mode);
        // A user-named manual clip is a rendered, burned baseline the operator created
        // on purpose. It has no own-stream selection plan, so it may only enter a local
        // revision when the operator states that explicitly.
        const manualClip = original.mode === 'manual_clip_queue';
        const localClipNote = String(options.localClipNote || '').trim();
        if (manualClip && !localClipNote) throw new Error('A user-named manual clip requires --local-clip-note for a local precision revision');
        if (!keywordTopic && !manualClip && !record.reviewPlanPath) throw new Error('Clip has no own-stream metadata/plan');
        const singleHostNote = String(options.singleHostNote || '').trim();
        if ((!keywordTopic && !manualClip && original.mode !== 'own_stream_fun_review')
            || (keywordTopic && original.mode !== 'own_stream_fun_review'
                && original.publicationKind !== 'keyword_topic'
                && !['local_review', 'topic_candidate_manual_cut'].includes(original.mode))
            || !original.uploadReady && !singleHostNote || original.rebuildRequired
            || original.publicCopyPending && !singleHostNote || original.output?.mediaError || !original.output?.burnedSubtitles
            || (original.uploadId && original.uploadId !== id)) throw new Error('A reviewed ordinary own-stream clip is required');
        const successfulAutomatic = !keywordTopic && original.creativeResult?.status === 'edited';
        if (successfulAutomatic) {
            const saved = original.enhancement?.baseline;
            if (original.qaResult?.status !== 'passed' || original.audioQa?.status !== 'passed' || !saved?.window
                || !saved.copy || !saved.burnedSubtitles || saved.mediaPath === original.output.mediaPath
                || saved.srtPath === original.output.srtPath || saved.window.start !== original.editPlan?.sourceWindow.start
                || saved.window.end !== original.editPlan?.sourceWindow.end || original.sourceExpansion
                || Math.abs(saved.window.duration - (saved.window.end - saved.window.start)) > .002) {
                throw new Error('Successful precision clip has no current ordinary baseline');
            }
            const priorDigests = await loadWorkflow('clipping/enhancement').artifactDigests(original);
            if (Object.entries(priorDigests).some(([key, value]) => value !== original.qaResult.digests?.[key])) throw new Error('Reviewed precision artifacts changed');
            original = { ...original, window: saved.window, copy: saved.copy,
                output: { ...saved, metadataPath }, attributionReview: original.attributionReview?.previousReview || original.attributionReview };
            delete original.editPlan;
        } else if (original.editPlan?.removed?.length) {
            throw new Error('Use the original ordinary clip; an edited artifact cannot serve as the baseline');
        }
        const topic = dependencies.topic || require('../topic_clipper');
        const own = require('../own_stream_clipper');
        const rootConfig = dependencies.rootConfig || require('../config-loader').getConfig();
        const config = keywordTopic ? topic.getClipTopicsConfig(rootConfig)
            : own.getOwnStreamClipsConfig(rootConfig, original.roomId, original.recordedAt, Date.now(), true);
        if (keywordTopic) {
            config.enhancements = { ...(rootConfig.ownStreamClips?.enhancements || {}), ...(config.enhancements || {}),
                enabled: true, workflow: 'creative' };
        } else if (manualClip) {
            // The operator asked for this local revision; the room allowlist must not
            // silently turn an explicit request into a no-op.
            config.enhancements = { ...(rootConfig.ownStreamClips?.enhancements || {}), ...(config.enhancements || {}),
                enabled: true, workflow: 'creative' };
        }
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
        // Keyword candidates are explicit local revisions. Their metadata roomId is the
        // streamer UID, while own-stream room allowlists use numeric live-room IDs, so
        // applying the own-stream room gate here would reject an otherwise configured
        // creative revision before it reaches the shared renderer.
        const enhancementReady = config.enhancements?.workflow === 'creative'
            && (keywordTopic || manualClip ? config.enhancements.enabled === true
                : require('./enhancement_runner').enhancementEnabled(config.enhancements, original.roomId));
        if (!enhancementReady) {
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
        let clip;
        if (keywordTopic) {
            clip = { ...original.copy, ...original.window,
                attributionRequired: original.attributionRequired, attributionReview: original.attributionReview,
                // Topic grounding keeps discovery evidence for audit, but its full
                // audience row inventory must not turn every danmaku into a
                // protected span for an editorial creative cut.
                grounding: undefined };
        } else if (manualClip) {
            // Same rule for a user-named clip: the window and public copy are the
            // baseline, and no selection plan exists to inherit.
            clip = { ...original.copy, ...original.window,
                attributionRequired: original.attributionRequired === true, attributionReview: original.attributionReview,
                grounding: undefined };
        } else {
            const plan = JSON.parse(fs.readFileSync(record.reviewPlanPath, 'utf8'));
            clip = plan.clips?.find(row => row.start === original.window.start && row.end === original.window.end);
        }
        let attributionExemption;
        if (singleHostNote) {
            const reviewed = require('../review_rendered_clip');
            reviewed.assertRenderedRevision(original);
            if (reviewed.sourceEvidenceHash(original) !== evidence.sourceSha256) throw new Error('Original source evidence changed');
            const local = loadWorkflow('clipping/experiment').singleHostLocalCandidate(original, evidence.sourceSha256, snapshot, singleHostNote);
            clip = local.clip;
            attributionExemption = local.exemption;
            original = { ...original, uploadReady: true, publicCopyPending: false, attributionRequired: false, attributionExemption };
            delete original.attributionReview;
        } else if (original.renderedSubtitles) {
            if (JSON.stringify(original.renderedSubtitles.sourceSnapshot) !== JSON.stringify(snapshot)) {
                throw new Error('Rebuilt baseline source changed');
            }
            // A keyword candidate with explicit feedback acceptance is already
            // source-bound and user-directed. It may enter a local precision
            // revision without pretending that the ordinary baseline passed
            // the independent publication review required by unattended upload.
            // The acceptance is recorded on the rendered human review by
            // `rebuild`/`cut --feedback-authorized`; subtitle revisions keep it
            // on `renderedSubtitles.review`, so both places count.
            const feedbackAcceptedKeyword = keywordTopic
                && (original.renderedSubtitles?.review?.acceptanceMode === 'feedback'
                    || original.ownStreamHumanReview?.acceptanceMode === 'feedback');
            if (!feedbackAcceptedKeyword) {
                clip = loadWorkflow('clipping/experiment').rebuiltPrecisionCandidate(original, evidence.sourceSha256,
                    await loadWorkflow('clipping/publicationRuntime').publicationSnapshot(original));
            }
        }
        if (!clip || (clip.attributionRequired && evidence.sourceSha256 !== original.attributionReview?.sourceSha256)
            || loadWorkflow('clipping/experiment').experimentEligibility(clip, evidence.sourceSha256)) {
            throw new Error('Source evidence or original attribution review is stale');
        }
        const digests = { video: fileDigest(original.output.mediaPath), subtitles: fileDigest(original.output.srtPath),
            cover: fileDigest(original.output.coverPath) };
        const registeredDigests = successfulAutomatic ? { video: fileDigest(registered.output.mediaPath),
            subtitles: fileDigest(registered.output.srtPath), cover: fileDigest(registered.output.coverPath) } : digests;
        for (const [key, value] of Object.entries(original.attributionReview?.artifactDigests || {})) {
            if (digests[key] && value !== digests[key]) throw new Error(`Original ${key} changed since review`);
        }
        const subtitles = topic.parseTopicSrt(original.output.srtPath).segments;
        if (!subtitles.length || subtitles.some(cue => cue.start < 0 || cue.end <= cue.start
            || cue.end > original.window.duration + .001)) throw new Error('Invalid baseline subtitle timeline');
        // Older records only kept media/srt paths. DDTV writes the danmaku XML next to the
        // recording, so recover it from the media path instead of silently editing with an
        // empty audience (which made every quoted-chat request impossible).
        const resolveXml = () => {
            if (original.source.xmlPath) return original.source.xmlPath;
            if (!original.source.mediaPath) return null;
            const candidate = path.join(path.dirname(original.source.mediaPath),
                `${path.basename(original.source.mediaPath, path.extname(original.source.mediaPath))}.xml`);
            return fs.existsSync(candidate) ? candidate : null;
        };
        const xmlPath = resolveXml();
        const danmaku = xmlPath
            ? await (keywordTopic ? topic.parseDanmakuXml(xmlPath) : own.parseDanmakuXml(xmlPath))
            : [];
        const contextQuestion = options.contextDanmakuAt === undefined ? undefined
            : loadWorkflow('clipping/creativeContext').contextQuestion(Number(options.contextDanmakuAt), danmaku, original.window);
        const parent = path.join(path.dirname(metadataPath), 'precision_revisions', String(id));
        fs.mkdirSync(parent, { recursive: true });
        directory = fs.mkdtempSync(path.join(parent, 'r-'));
        fs.writeFileSync(path.join(directory, 'original.json'), before, { flag: 'wx' });
        if (successfulAutomatic && !resumeDirectory) {
            if (await require('./creative_source_expansion').creativeSourceIdentity({ mediaPath: original.source.mediaPath }, original.source) !== registered.creativePlan.sourceId) {
                throw new Error('Successful precision source changed');
            }
            resumeDirectory = path.join(directory, 'resume');
            const resumeScratch = path.join(resumeDirectory, 'temp', 'clip-creative');
            fs.mkdirSync(resumeScratch, { recursive: true });
            writeJsonAtomic(path.join(resumeDirectory, 'clip.json'), registered);
            const priorScratch = path.join(path.dirname(metadataPath), 'temp', `${path.basename(metadataPath, '.json')}-creative`);
            for (const file of fs.readdirSync(priorScratch)) {
                if (/^(story|moments|visual-plan)(?:-[\w-]+)?-response\.json$/.test(file)) fs.copyFileSync(path.join(priorScratch, file), path.join(resumeScratch, file));
            }
        }
        if (insetPlan) writeJsonAtomic(path.join(directory, 'inset-editorial-plan.json'), insetPlan);
        // An explicit rate plan uses absolute recording seconds and is bound to the
        // current baseline media, so a re-rendered baseline cannot inherit it.
        let speedWindows, cutAfterAbsolute, keepBeats = [], noStorySpeed = false, laughId, noDanmaku = [], subtitleFixes = [];
        let noSticker = false, radioDanmaku = null, keepTailAbsolute = null;
        if (options.speedPlanPath) {
            const plan = JSON.parse(fs.readFileSync(path.resolve(String(options.speedPlanPath)), 'utf8'));
            if (plan?.version !== 1 || Number(plan.clipId) !== id || !Array.isArray(plan.windows) || !plan.windows.length) {
                throw new Error('Speed plan must bind this clip ID and list at least one window');
            }
            if (plan.baselineMediaSha256 && plan.baselineMediaSha256 !== digests.video) {
                throw new Error('Speed plan belongs to a different baseline video');
            }
            speedWindows = plan.windows;
            keepBeats = plan.keepBeats === undefined ? [] : plan.keepBeats;
            if (!Array.isArray(keepBeats) || keepBeats.some(row => !Number.isFinite(Number(row?.start))
                || !Number.isFinite(Number(row?.end)) || Number(row.end) <= Number(row.start))) {
                throw new Error('Keep beats must be an array of finite ordered recording ranges');
            }
            noStorySpeed = plan.noStorySpeed === true;
            if (plan.laughId !== undefined) {
                laughId = String(plan.laughId);
                if (!/^[a-z][a-z0-9_]{1,60}$/.test(laughId)) throw new Error('Laugh ID must be a valid asset id');
            }
            if (plan.noDanmaku !== undefined) {
                noDanmaku = plan.noDanmaku;
                if (!Array.isArray(noDanmaku) || noDanmaku.some(row => !Array.isArray(row) || row.length !== 2
                    || !Number.isFinite(Number(row[0])) || !Number.isFinite(Number(row[1])) || Number(row[1]) <= Number(row[0]))) {
                    throw new Error('No-danmaku must be an array of [start, end] recording ranges');
                }
            }
            if (plan.subtitleFixes !== undefined) {
                subtitleFixes = plan.subtitleFixes;
                if (!Array.isArray(subtitleFixes) || subtitleFixes.length > 40 || subtitleFixes.some(row => !row
                    || typeof row.from !== 'string' || !row.from.trim() || typeof row.to !== 'string')) {
                    throw new Error('Subtitle fixes must pair a non-empty quoted text with its corrected text');
                }
            }
            if (plan.cutAfter !== undefined) {
                cutAfterAbsolute = Number(plan.cutAfter);
                if (!Number.isFinite(cutAfterAbsolute) || cutAfterAbsolute <= 0
                    || plan.windows.some(row => Number(row.end) > cutAfterAbsolute)) {
                    throw new Error('Cut-after must be a positive recording timestamp at or after every speed window');
                }
            }
            if (plan.keepTailFrom !== undefined) {
                keepTailAbsolute = Number(plan.keepTailFrom);
                if (!Number.isFinite(keepTailAbsolute) || keepTailAbsolute <= 0
                    || plan.windows.some(row => Number(row.end) > keepTailAbsolute)
                    || cutAfterAbsolute !== null && keepTailAbsolute < cutAfterAbsolute) {
                    throw new Error('Keep-tail-from must be a recording timestamp at or after every speed window and the cut-after point');
                }
            }
            // Operator overlay switches: ban stickers outright, and/or burn every audience
            // comment with the generic rolling-danmaku layer instead of curated cards.
            if (plan.noSticker !== undefined) {
                if (plan.noSticker !== true) throw new Error('No-sticker must be true when present');
                noSticker = true;
            }
            if (plan.radioDanmaku !== undefined) {
                if (plan.radioDanmaku !== true) throw new Error('Radio danmaku must be true when present');
                if (!xmlPath) throw new Error('Radio danmaku requires a danmaku XML next to the baseline source video');
                radioDanmaku = { enabled: true, mode: 'radio', fps: 30, fontScale: 1 };
            }
            writeJsonAtomic(path.join(directory, 'speed-plan.json'), plan);
        }
        const outputMetadata = path.join(directory, 'clip.json'), revisionSrt = path.join(directory, 'clip.srt');
        fs.copyFileSync(original.output.srtPath, revisionSrt);
        // Operator-reviewed ASR corrections: text-only substitutions applied to this
        // revision's copy so the burned-in cues and the delivered srt both match the audio.
        let revisionSubtitlesDigest = digests.subtitles;
        if (subtitleFixes.length) {
            let subtitles = fs.readFileSync(revisionSrt, 'utf8');
            for (const fix of subtitleFixes) subtitles = subtitles.split(fix.from).join(fix.to);
            fs.writeFileSync(revisionSrt, subtitles);
            revisionSubtitlesDigest = fileDigest(revisionSrt);
        }
        const revision = { version: 1, clipId: id, createdAt: new Date().toISOString(), note: String(options.note || ''),
            originalMetadataPath: metadataPath, originalDigests: registeredDigests, baselineDigests: digests,
            sourceSnapshot: snapshot, style: config.enhancements.creative?.style || 'accent',
            avatarMode: config.enhancements.creative?.avatarMode || 'auto',
            ...(speedWindows ? { speedPlanWindows: speedWindows.length } : {}),
            ...(noSticker ? { noSticker: true } : {}),
            ...(radioDanmaku ? { radioDanmaku: true } : {}),
            ...(cutAfterAbsolute ? { cutAfter: cutAfterAbsolute } : {}),
            ...(keepTailAbsolute ? { keepTailFrom: keepTailAbsolute } : {}),
            ...(options.noBgm ? { musicDisabled: true } : {}),
            ...(manualClip ? { localClipBaseline: { note: localClipNote, authority: 'user', scope: 'local_precision_revision_only' } } : {}),
            ...(contextQuestion ? { contextQuestion } : {}),
            ...(attributionExemption ? { attributionExemption } : {}),
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
                allowKeywordTopicPrecision: keywordTopic,
                creativeResumeDirectory: resumeDirectory, creativeInsetPlan: insetPlan, creativeSoundLevelOverrides: soundLevelOverrides,
                creativeContextQuestion: contextQuestion, creativeEditorialFeedback: String(options.note || ''),
                creativeCoverTextPosition: options.coverTextPosition,
                creativeSpeedWindows: speedWindows, creativeCutAfter: cutAfterAbsolute,
                creativeKeepTailFrom: keepTailAbsolute,
                creativeKeepBeats: keepBeats, creativeNoStorySpeed: noStorySpeed,
                creativeLaughId: laughId, creativeNoDanmaku: noDanmaku,
                creativeNoSticker: noSticker,
                ...(radioDanmaku ? { creativeRadioDanmaku: radioDanmaku, creativeDanmakuXmlPath: xmlPath } : {}),
                creativeNoMusic: options.noBgm === true,
                creativeAllowCoverFaceOverlap: options.allowCoverFaceOverlap === true },
            topic, clip, subtitleEvidence: evidence, execution });
        if (fs.readFileSync(metadataPath, 'utf8') !== before || JSON.stringify(sourceSnapshot(original)) !== JSON.stringify(snapshot)
            || fileDigest(original.output.mediaPath) !== digests.video || fileDigest(revisionSrt) !== revisionSubtitlesDigest
            || Object.entries(registeredDigests).some(([key, value]) => fileDigest(registered.output[{ video: 'mediaPath', subtitles: 'srtPath', cover: 'coverPath' }[key]]) !== value)) {
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
            sourceWindow: { start: result.window.start, end: result.window.end },
            sourceExpansionCount: result.sourceExpansion?.attempts.length
                || result.creativeResult?.history?.filter(row => row.stage === 'source_expanded').length || 0,
            removedSeconds: result.creativePlan?.timeline?.removedSeconds || 0, reason: result.creativeResult?.reason,
            spedSavedSeconds: result.creativePlan?.timeline?.spedSavedSeconds || 0,
            speedWindows: result.creativePlan?.timeline?.speedWindows?.length || 0,
            music: result.creativePlan?.music ? 'added' : 'none',
            radioDanmaku: result.output?.radioDanmaku?.commentCount ?? null,
            qaStatus: result.qaResult?.status || null, uploadAuthorized: false };
        writeJsonAtomic(path.join(directory, 'RESULT.json'), summary);
        writeJsonAtomic(path.join(parent, 'latest.json'), summary);
        const extra = [
            summary.spedSavedSeconds ? `加速：省下 ${summary.spedSavedSeconds} 秒过程性画面（${summary.speedWindows} 段）` : null,
            summary.music === 'none' ? 'BGM：未添加，保留原片音轨' : null
        ].filter(Boolean).join('\n\n');
        fs.writeFileSync(path.join(directory, 'REVIEW.md'), `# ID${id} 精切重渲染\n\n状态：${summary.status}\n\n视频：${summary.mediaPath}\n\n素材窗口：${summary.sourceWindow.start}–${summary.sourceWindow.end}秒，扩窗 ${summary.sourceExpansionCount} 次\n\n效果节点：${summary.effectCount}\n\n质检：${summary.qaStatus}\n${extra ? `\n${extra}\n` : ''}\n原稿与线上投稿保留，新版待人工查看。\n`, 'utf8');
        return summary;
    } catch (error) {
        if (directory) writeJsonAtomic(path.join(directory, 'ERROR.json'), { id, error: error.message, uploadAuthorized: false });
        throw error;
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}

module.exports = { renderPrecisionRevision };
if (require.main === module) {
    const { values } = parseArgs({ options: { id: { type: 'string' }, registry: { type: 'string' }, note: { type: 'string' }, style: { type: 'string' }, 'single-host-note': { type: 'string' }, 'avatar-mode': { type: 'string' }, 'inset-plan': { type: 'string' }, 'resume-from': { type: 'string' }, 'sound-level-overrides': { type: 'string' }, 'cover-text-position': { type: 'string' }, 'allow-cover-face-overlap': { type: 'boolean' }, 'context-danmaku-at': { type: 'string' },
        'speed-plan': { type: 'string' }, 'no-bgm': { type: 'boolean' }, 'local-clip-note': { type: 'string' } } });
    renderPrecisionRevision({ id: values.id, registryPath: values.registry, note: values.note, style: values.style,
        singleHostNote: values['single-host-note'], avatarMode: values['avatar-mode'], insetPlanPath: values['inset-plan'], resumeFrom: values['resume-from'], soundLevelOverridesPath: values['sound-level-overrides'], coverTextPosition: values['cover-text-position'], allowCoverFaceOverlap: values['allow-cover-face-overlap'], contextDanmakuAt: values['context-danmaku-at'],
        speedPlanPath: values['speed-plan'], noBgm: values['no-bgm'], localClipNote: values['local-clip-note'] })
        .then(result => { console.log('PRECISION_RESULT: ' + JSON.stringify(result)); if (result.status !== 'pending_review') process.exitCode = 1; })
        .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
