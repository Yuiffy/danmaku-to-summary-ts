'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { loadWorkflow } = require('../workflow-runtime');

function enhancementEnabled(config, roomId) {
    return config?.enabled === true && Array.isArray(config.roomIds) && config.roomIds.map(String).includes(String(roomId));
}

function requestStage(config, budget, info, phase, prompt, images = []) {
    const generator = require('../ai_text_generator');
    return loadWorkflow('clipping/stage').runStage(config, budget, {
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
    const result = await enhanceArtifact(metadata, { sourceId, window: metadata.window, speech: segments,
        audience: danmaku.map((row, index) => ({ ...row, id: `D${index + 1}` })), audioEvidence,
        allowEditing: settings.editing === true, streamerName: metadata.streamerName }, {
        request: async (stage, prompt, images = []) => (await requestStage(settings.stages?.[stage], settings.budget, info,
            `${stage}-${metadata.window.index}`, prompt, images)).text,
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
    if (result.uploadReady && result.output.coverPath) {
        const finalCover = path.join(directory, `${name}_cover.jpg`);
        fs.copyFileSync(result.output.coverPath, finalCover);
        result.output.coverPath = finalCover;
    }
    fs.writeFileSync(result.output.metadataPath, JSON.stringify(result, null, 2), 'utf8');
    return result;
}

async function runEnhancements(metadata, context) {
    if (!enhancementEnabled(context.config?.enhancements, context.info?.roomId)) return metadata;
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

module.exports = { enhancementEnabled, requestStage, runEnhancements };
