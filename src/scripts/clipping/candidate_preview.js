'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { digest } = require('./candidate_subtitles');

function fingerprint(file) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || !stat.size) throw new Error(`Missing or empty media: ${file}`);
    return { path: path.resolve(file), size: stat.size, mtimeMs: stat.mtimeMs };
}

// Preview media is a cache, never an upload artifact or an approval.
function reusablePreview(preview, sourcePath, window) {
    try {
        return preview?.version === 1 && preview.status === 'ready'
            && preview.window.start === window.start && preview.window.end === window.end
            && Number.isFinite(preview.sourceTimeOrigin) && preview.sourceTimeOrigin <= window.start
            && preview.sourceTimeOrigin + preview.duration >= window.end - 0.1
            && JSON.stringify(preview.sourceFingerprint) === JSON.stringify(fingerprint(sourcePath))
            && JSON.stringify(preview.mediaFingerprint) === JSON.stringify(fingerprint(preview.mediaPath));
    } catch { return false; }
}

function subtitleText(cues) {
    const time = value => {
        const ms = Math.max(0, Math.round(value * 1000));
        return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
    };
    return cues.map((cue, i) => `${i + 1}\n${time(cue.start)} --> ${time(cue.end)}\n${cue.text}\n`).join('\n');
}

function syncPreviewSubtitles(metadata, evidence) {
    const preview = metadata.reviewPreview;
    if (!reusablePreview(preview, metadata.source.mediaPath, metadata.window)) return false;
    const draft = metadata.candidateSubtitles;
    const corrected = new Map(draft.cues.map(cue => [cue.cueId, cue.text]));
    const origin = preview.sourceTimeOrigin;
    const cues = evidence.cues.filter(cue => cue.end > origin && cue.start < origin + preview.duration)
        .map(cue => ({ start: Math.max(0, cue.start - origin),
            end: Math.min(preview.duration, cue.end - origin), text: corrected.get(cue.id) ?? cue.text }));
    const content = subtitleText(cues);
    const temporary = `${preview.srtPath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, content, 'utf8');
        fs.renameSync(temporary, preview.srtPath);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    preview.subtitleSha256 = digest(content);
    preview.candidateSrtSha256 = draft.sha256;
    preview.candidateRevision = draft.revision;
    return true;
}

async function ensureCandidatePreview(metadata, metadataPath, evidence, config = {}, mediaApi = require('../topic_clipper')) {
    if (metadata.source?.sourceKind !== 'video') throw new Error('Review preview requires source video');
    const window = metadata.window;
    if (!Number.isFinite(window?.start) || !Number.isFinite(window?.end) || window.start < 0 || window.end <= window.start) {
        throw new Error('Invalid preview boundaries');
    }
    if (reusablePreview(metadata.reviewPreview, metadata.source.mediaPath, window)) {
        syncPreviewSubtitles(metadata, evidence);
        return metadata.reviewPreview;
    }
    const sourceFingerprint = fingerprint(metadata.source.mediaPath);
    const previous = metadata.reviewPreview;
    const revision = (previous?.revision || 0) + 1;
    // A new window/source gets a new pair; preserve the previous review files.
    const stem = `${path.basename(metadataPath, '.json')}_preview_r${String(revision).padStart(4, '0')}_${crypto.randomUUID().slice(0, 8)}`;
    const mediaPath = path.join(path.dirname(metadataPath), `${stem}.mp4`);
    const temporary = mediaPath.replace(/\.mp4$/, '.partial.mp4');
    const ffmpegPath = config.ffmpegPath || 'ffmpeg';
    const start = Math.max(0, window.start - Number(config.twoStagePreRollSeconds ?? 8));
    const end = window.end + Number(config.twoStagePostRollSeconds ?? 2);
    try {
        await mediaApi.runFfmpeg(['-y', '-ss', String(start), '-i', metadata.source.mediaPath,
            '-t', String(end - start), '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
            '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', temporary],
        { ffmpegPath, threads: config.clipFfmpegThreads ?? config.ffmpegThreads, timeoutMs: config.ffmpegTimeoutMs });
        const sourceStart = await mediaApi.probeRoughCutSourceStart(ffmpegPath, metadata.source.mediaPath, temporary, start);
        const [firstPacket] = await mediaApi.probeVideoPacketsWithHashes(ffmpegPath, temporary, '%+#1');
        const localStart = Number(firstPacket?.pts_time);
        const duration = await mediaApi.probeMediaDuration(temporary, mediaApi.resolveFfprobePath(ffmpegPath));
        const sourceTimeOrigin = sourceStart - localStart;
        if (!Number.isFinite(localStart) || !Number.isFinite(duration) || duration <= 0
            || sourceTimeOrigin > window.start || sourceTimeOrigin + duration < window.end - 0.1) {
            throw new Error('Rough preview does not cover the requested window or has invalid timestamps');
        }
        if (JSON.stringify(sourceFingerprint) !== JSON.stringify(fingerprint(metadata.source.mediaPath))) {
            throw new Error('Source video changed during rough cut');
        }
        fs.renameSync(temporary, mediaPath);
        metadata.reviewPreview = { version: 1, status: 'ready', revision, mediaPath,
            srtPath: mediaPath.replace(/\.mp4$/, '.srt'), sourceFingerprint, mediaFingerprint: fingerprint(mediaPath),
            window: { start: window.start, end: window.end }, duration, sourceStart, sourceTimeOrigin,
            clipStart: window.start - sourceTimeOrigin, clipEnd: window.end - sourceTimeOrigin,
            generatedAt: new Date().toISOString(), burnedSubtitles: false };
        syncPreviewSubtitles(metadata, evidence);
        return metadata.reviewPreview;
    } catch (error) {
        metadata.reviewPreview = { ...previous, status: 'failed', error: error.message, revision };
        throw error;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function previewReviewLines(result) {
    const preview = result.reviewPreview;
    if (preview?.status !== 'ready') return preview?.error ? [`   粗剪失败: ${preview.error}`] : [];
    const link = file => encodeURI(file.replace(/\\/g, '/')).replace(/[()?#]/g, char => `%${char.charCodeAt(0).toString(16)}`);
    return [`   粗剪视频: [打开视频](<${link(preview.mediaPath)}>)`,
        `   同名字幕: [SRT](<${link(preview.srtPath)}>)（打开视频可自动加载）`,
        `   候选范围（粗剪内）: ${preview.clipStart.toFixed(3)}–${preview.clipEnd.toFixed(3)} 秒；含前后上下文，待预审`];
}

module.exports = { ensureCandidatePreview, syncPreviewSubtitles, reusablePreview, previewReviewLines };
