'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { loadWorkflow } = require('../workflow-runtime');
const { withSelectionCache } = require('./selection_cache');

function enhancementEnabled(config, roomId) {
    return config?.enabled === true && Array.isArray(config.roomIds) && config.roomIds.map(String).includes(String(roomId));
}

function requestStage(config, budget, info, phase, prompt, images = []) {
    const generator = require('../ai_text_generator');
    const accounting = { ...budget, ledgerPath: typeof budget?.ledgerPath === 'string'
        ? path.resolve(__dirname, '../../..', budget.ledgerPath) : '' };
    return loadWorkflow('clipping/stage').runStage(config, accounting, {
        stage: phase, roomId: String(info.roomId || ''), sessionId: info.sessionId || info.selectionCacheDirectory || info.recordedAt,
        split: info.evaluationSplit || 'screening'
    }, prompt, images, (provider, text, options) => provider === 'daiYu'
        ? generator.generateTextWithDaiYu(text, options) : generator.generateTextWithTuZi(text, options));
}

function probeMedia(file, ffprobe) {
    return new Promise((resolve, reject) => execFile(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
        { encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 }, (error, stdout) => {
            if (error) return reject(error);
            try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
        }));
}

async function selectExperimentBatch(clips, parsed, config, rootConfig, info) {
    const settings = config.enhancements;
    if (!enhancementEnabled(settings, info.roomId) || settings.experiment?.enabled !== true
        || !config.ai?.enabled || rootConfig.ai?.text?.enabled === false) return { clips };
    const { buildExperimentSelection, parseExperimentSelection, assignExperiment } = loadWorkflow('clipping/experiment');
    const packet = buildExperimentSelection(clips, parsed.segments, settings.experiment);
    const summary = { version: 1, batchId: packet.batchId, total: clips.length, maxSelected: packet.maxSelected,
        selected: [], status: 'ordinary_control', selectionLog: null };
    if (!packet.maxSelected || !packet.eligibleIds.length) return { clips: assignExperiment(clips, packet, []), summary };
    const stageConfig = { ...settings.stageDefaults, ...settings.stages?.selection };
    try {
        const response = await withSelectionCache({ directory: info.selectionCacheDirectory,
            phase: 'precision-experiment-selection-v1', prompt: packet.prompt, signature: { stageConfig, batchId: packet.batchId },
            validate: result => { try { parseExperimentSelection(result.text, packet); return true; } catch { return false; } }
        }, () => requestStage(stageConfig, settings.budget, info, 'precision-experiment-selection', packet.prompt));
        const choices = parseExperimentSelection(response.text, packet);
        summary.selected = choices;
        summary.status = 'selected';
        summary.selectionLog = { ledgerId: response.meta?.ledgerId, usage: response.meta?.usage,
            elapsedMs: response.meta?.elapsedMs, cacheHit: response.meta?.selectionCache?.hit === true };
        return { clips: assignExperiment(clips, packet, choices, response.meta?.ledgerId), summary };
    } catch (error) {
        summary.status = 'selection_failed_control';
        summary.error = error.message;
        return { clips: assignExperiment(clips, packet, [], error.ledgerId || null, error.message), summary };
    }
}

async function enhance(metadata, { config, info, parsed, danmaku, source, options, topic }) {
    const settings = config.enhancements;
    if (!enhancementEnabled(settings, info.roomId)) return metadata;
    const { enhanceArtifact, fileDigest } = loadWorkflow('clipping/enhancement');
    const { mapSubtitles, validateEditPlan } = loadWorkflow('clipping/editPlan');
    const { segments } = require('../asr/evidence_sidecar').loadAsrEvidence(options.srtPath, parsed.segments);
    const stat = fs.statSync(source.mediaPath);
    const sourceId = crypto.createHash('sha256').update(JSON.stringify({ path: path.resolve(source.mediaPath),
        size: stat.size, mtimeMs: stat.mtimeMs, subtitles: await fileDigest(options.srtPath) })).digest('hex');
    const evidencePath = `${options.srtPath}.edit-evidence.json`;
    let audioEvidence = [];
    if (settings.editing === true && fs.existsSync(evidencePath)) {
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        if (evidence.version === 1 && evidence.sourceId === sourceId && Array.isArray(evidence.events)) audioEvidence = evidence.events;
    }
    const ffmpegPath = options.ffmpegPath || config.ffmpegPath || 'ffmpeg';
    const mediaConfig = { ...config, ffmpegPath, preserveCoverSource: false, burnSubtitles: true,
        twoStageSubtitleBurn: true, twoStageMode: 'copy', ffmpegThreads: config.clipFfmpegThreads,
        resourcePeaks: metadata.processing?.resourcePeaks };
    const directory = path.dirname(metadata.output.mediaPath);
    const name = path.basename(metadata.output.mediaPath, path.extname(metadata.output.mediaPath));
    const scratch = path.join(directory, 'temp', `${name}-enhancement`);
    fs.mkdirSync(scratch, { recursive: true });
    let inspection = 0;
    const generationLogs = [];
    const result = await enhanceArtifact(metadata, { sourceId, window: metadata.window, speech: segments,
        audience: danmaku.map((row, index) => ({ ...row, id: `D${index + 1}` })), audioEvidence,
        allowEditing: settings.editing === true, streamerName: metadata.streamerName,
        experimentSelected: metadata.precisionExperiment?.selected === true }, {
        request: async (stage, prompt, images = []) => {
            const stageConfig = { ...settings.stageDefaults, ...settings.stages?.[stage] };
            try {
                const response = await requestStage(stageConfig, settings.budget, info,
                    `${stage}-${metadata.window.index}`, prompt, images);
                generationLogs.push({ stage, ledgerId: response.meta?.ledgerId, status: 'success',
                    costCny: response.meta?.costCny, usageUnknown: response.meta?.usageUnknown,
                    usage: response.meta?.usage, elapsedMs: response.meta?.elapsedMs });
                return response.text;
            } catch (error) {
                generationLogs.push({ stage, ledgerId: error.ledgerId || null, status: 'failure', error: error.message });
                throw error;
            }
        },
        renderEdit: async plan => {
            validateEditPlan(plan, sourceId, metadata.window, segments, audioEvidence);
            const mapped = mapSubtitles(segments, plan);
            const duration = plan.keep.reduce((n, span) => n + span.end - span.start, 0);
            const srtPath = path.join(directory, `${name}.edited.srt`);
            const mediaPath = path.join(directory, `${name}.edited.mp4`);
            topic.writeClipSrt(mapped, { start: 0, end: duration, duration }, srtPath);
            const output = await topic.cutClipMedia(source, metadata.window, srtPath, mediaPath, {
                ...mediaConfig, editPlan: plan, editSourceId: sourceId, originalSubtitleSegments: segments, editAudioEvidence: audioEvidence
            });
            return { ...metadata, window: { ...metadata.window, duration }, editPlan: plan,
                output: { ...metadata.output, mediaPath: output.path, srtPath, burnedSubtitles: output.burnedSubtitles } };
        },
        renderCover: async (artifact, copy, index) => {
            const outputPath = path.join(scratch, `variant-${index + 1}.jpg`);
            return topic.generateClipCover(artifact.output.mediaPath, copy.coverText || copy.title, directory, {
                outputPath, streamerName: metadata.streamerName, coverSourcePath: artifact.output.mediaPath,
                clipStart: 0, clipDuration: artifact.window.duration,
                preferredTime: artifact.window.duration * [0.25, 0.5, 0.75][index % 3],
                resourcePeaks: metadata.processing?.resourcePeaks
            });
        },
        inspectMedia: async (artifact, expected) => {
            const issues = [];
            const data = await probeMedia(artifact.output.mediaPath, topic.resolveFfprobePath(ffmpegPath));
            const streams = Array.isArray(data.streams) ? data.streams : [];
            const video = streams.find(row => row.codec_type === 'video');
            const audio = streams.find(row => row.codec_type === 'audio');
            if (!video || !audio || !(video.width > 0 && video.height > 0)) issues.push('missing_audio_or_video');
            if (!Number.isFinite(Number(data.format?.duration)) || Math.abs(Number(data.format.duration) - expected) > 0.5) issues.push('duration_mismatch');
            if (video && audio && Math.abs(Number(video.start_time || 0) - Number(audio.start_time || 0)) > 0.15) issues.push('av_start_mismatch');
            const subtitles = require('../asr/asr_backends').parseSrt(artifact.output.srtPath).segments;
            if (!subtitles.length || subtitles.some(row => row.start < 0 || row.end > expected + 0.1)) issues.push('subtitle_timeline_invalid');
            if (issues.length) return { passed: false, issues, frames: [] };
            await topic.runFfmpeg(['-v', 'error', '-i', artifact.output.mediaPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], mediaConfig);
            const frames = [];
            for (const [index, ratio] of [0.1, 0.5, 0.9].entries()) {
                const file = path.join(scratch, `qa-${inspection}-${index}.jpg`);
                await topic.runFfmpeg(['-y', '-ss', String(expected * ratio), '-i', artifact.output.mediaPath,
                    '-frames:v', '1', '-vf', 'scale=960:-2', file], mediaConfig);
                frames.push(file);
            }
            inspection++;
            return { passed: true, issues, frames };
        }
    });
    result.enhancement = { version: 1, enabled: true, accountingMode: settings.budget?.mode || 'enforce',
        ledgerPath: path.resolve(__dirname, '../../..', settings.budget.ledgerPath), generationLogs,
        editingRequested: settings.editing === true,
        editDecision: result.editPlan?.removed?.length ? 'multi_cut' : audioEvidence.length ? 'retained_after_review' : 'no_precise_audio_evidence',
        removedSeconds: result.editPlan?.removed?.reduce((sum, span) => sum + span.end - span.start, 0) || 0,
        baseline: { copy: metadata.copy, mediaPath: metadata.output.mediaPath, srtPath: metadata.output.srtPath,
            duration: metadata.window.duration, coverPath: metadata.output.coverPath } };
    if (result.uploadReady && result.output.coverPath) {
        const finalCover = path.join(directory, `${name}_cover.jpg`);
        if (metadata.output.coverPath && fs.existsSync(metadata.output.coverPath)) {
            const baselineCover = path.join(scratch, 'baseline-cover.jpg');
            fs.copyFileSync(metadata.output.coverPath, baselineCover);
            result.enhancement.baseline.coverPath = baselineCover;
        }
        fs.copyFileSync(result.output.coverPath, finalCover);
        result.output.coverPath = finalCover;
    }
    fs.writeFileSync(result.output.metadataPath, JSON.stringify(result, null, 2), 'utf8');
    return result;
}

async function runEnhancements(metadata, context) {
    if (!enhancementEnabled(context.config?.enhancements, context.info?.roomId)) return metadata;
    if (context.config.enhancements.experiment?.enabled === true && metadata.precisionExperiment?.selected !== true) return metadata;
    const pending = { ...metadata, qaRequired: true, uploadReady: false, qaResult: { version: 1, status: 'pending' } };
    fs.writeFileSync(pending.output.metadataPath, JSON.stringify(pending, null, 2), 'utf8');
    try {
        if (context.config.ai?.enabled === false || context.options?.config?.ai?.text?.enabled === false) throw new Error('AI is disabled; required QA cannot run');
        return await enhance(pending, context);
    } catch (error) {
        pending.qaResult = { version: 1, status: 'failed', error: error.message };
        fs.writeFileSync(pending.output.metadataPath, JSON.stringify(pending, null, 2), 'utf8');
        return pending;
    }
}

module.exports = { enhancementEnabled, requestStage, runEnhancements, selectExperimentBatch };
