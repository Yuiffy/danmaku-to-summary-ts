'use strict';
const fs = require('fs');
const { runFfmpeg, resolveFfprobePath } = require('./media_runtime');
const { probeMediaDuration } = require('./video_probe');
const { fileDigest } = require('./source_snapshot');
const { renderActivityPart } = require('./stream_activity_media');

function frameHashes(file) {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(line => line.trim() && !line.startsWith('#'))
        .map(line => line.split(',').at(-1).trim());
}

/** MP4 edit lists can retain decoder preroll while presenting the exact requested cut.
 * Verify the decoded opening against the source before accepting an original-stream copy. */
async function renderGamePart(mediaPath, part, outputPath, config, profile, hooks = {}) {
    const ffmpegPath = config.audio?.ffmpeg?.path || 'ffmpeg', run = hooks.runFfmpeg || runFfmpeg;
    const options = { ffmpegPath, threads: 1, timeoutMs: 30 * 60 * 1000, stage: '游戏原码流切片' };
    const sourceHashes = outputPath + '.source.framemd5', outputHashes = outputPath + '.copy.framemd5';
    try {
        await run(['-y', '-ss', String(part.start), '-i', mediaPath, '-t', String(part.duration),
            '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-avoid_negative_ts', 'disabled', '-movflags', '+faststart', outputPath], options);
        const duration = await (hooks.probe || probeMediaDuration)(outputPath, resolveFfprobePath(ffmpegPath));
        if (!Number.isFinite(duration) || Math.abs(duration - part.duration) > .25) throw new Error('Original-stream game cut duration differs from the reviewed interval');
        await run(['-y', '-ss', String(part.start), '-i', mediaPath, '-an', '-frames:v', '3', '-f', 'framemd5', sourceHashes], options);
        await run(['-y', '-i', outputPath, '-an', '-frames:v', '3', '-f', 'framemd5', outputHashes], options);
        const expected = frameHashes(sourceHashes), actual = frameHashes(outputHashes);
        if (!expected.length || expected.length !== actual.length || expected.some((value, i) => value !== actual[i])) {
            throw new Error('Original-stream game cut opening differs from its source frames');
        }
        return { ...part, mediaPath: outputPath, bytes: fs.statSync(outputPath).size, sha256: fileDigest(outputPath), actualDuration: duration,
            processing: { resourceMode: profile?.mode || 'idle', ffmpegThreads: 1, videoEncoder: 'copy', audioEncoder: 'copy',
                hwaccel: null, fallbackUsed: false, originalStreamCopy: true, boundaryCheck: 'matching_first_decoded_frames' },
            audio: 'original_recording_mix', burnedSubtitles: false };
    } catch (error) {
        const result = await (hooks.renderFallback || renderActivityPart)(mediaPath, part, outputPath, config, profile, hooks);
        return { ...result, processing: { ...result.processing, originalStreamCopy: false, copyFallbackReason: error.message } };
    }
}

async function gameCover(part, coverPath, config) {
    await runFfmpeg(['-y', '-ss', String(Math.min(part.duration / 2, 90)), '-i', part.mediaPath,
        '-frames:v', '1', '-vf', 'scale=1920:-2', '-q:v', '2', coverPath],
    { ffmpegPath: config.audio?.ffmpeg?.path || 'ffmpeg', stage: '游戏切片封面', timeoutMs: 60000 });
    return coverPath;
}

module.exports = { renderGamePart, gameCover };
