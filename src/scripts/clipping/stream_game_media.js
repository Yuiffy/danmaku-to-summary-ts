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
        const copy = async requestedDuration => {
            await run(['-y', '-ss', String(part.start), '-i', mediaPath, '-t', String(requestedDuration),
                '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-avoid_negative_ts', 'disabled', '-movflags', '+faststart', outputPath], options);
            return (hooks.probe || probeMediaDuration)(outputPath, resolveFfprobePath(ffmpegPath));
        };
        let duration = await copy(part.duration), copyTailAdjustmentSeconds = 0;
        const overshoot = duration - part.duration;
        // Reordered video packets can extend the presented MP4 tail beyond -t.
        // Retry once from the same source/start, with at most .25s less input;
        // the original tolerance and decoded opening checks still decide acceptance.
        if (Number.isFinite(duration) && overshoot > .25 && overshoot <= .5 && part.duration > .25) {
            copyTailAdjustmentSeconds = Math.min(.25, overshoot - .125);
            duration = await copy(part.duration - copyTailAdjustmentSeconds);
        }
        if (!Number.isFinite(duration) || Math.abs(duration - part.duration) > .25) throw new Error('Original-stream game cut duration differs from the reviewed interval');
        await run(['-y', '-ss', String(part.start), '-i', mediaPath, '-an', '-frames:v', '3', '-f', 'framemd5', sourceHashes], options);
        await run(['-y', '-i', outputPath, '-an', '-frames:v', '3', '-f', 'framemd5', outputHashes], options);
        const expected = frameHashes(sourceHashes), actual = frameHashes(outputHashes);
        if (!expected.length || expected.length !== actual.length || expected.some((value, i) => value !== actual[i])) {
            throw new Error('Original-stream game cut opening differs from its source frames');
        }
        return { ...part, mediaPath: outputPath, bytes: fs.statSync(outputPath).size, sha256: fileDigest(outputPath), actualDuration: duration,
            processing: { resourceMode: profile?.mode || 'idle', ffmpegThreads: 1, videoEncoder: 'copy', audioEncoder: 'copy',
                hwaccel: null, fallbackUsed: false, originalStreamCopy: true, copyTailAdjustmentSeconds,
                boundaryCheck: 'matching_first_decoded_frames' },
            audio: 'original_recording_mix', burnedSubtitles: false };
    } catch (error) {
        if (config.streamGameClips?.requireOriginalStreamCopy === true) {
            const stopped = new Error(`Original-stream game cut failed; streamGameClips.requireOriginalStreamCopy forbids re-encoding: ${error.message}`, { cause: error });
            stopped.code = 'GAME_ORIGINAL_STREAM_COPY_REQUIRED';
            throw stopped;
        }
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

/**
 * Render a short-form game editorial sequence. Source ranges are first cut with
 * the same stream-copy checks as ordinary game parts; the final concat keeps the
 * original audio/video whenever the inputs are compatible and falls back to one
 * predictable H.264/AAC encode for mixed OP/source inputs.
 */
async function renderGameSequence(mediaPath, sequence, outputPath, config, profile, hooks = {}) {
    const root = require('path').dirname(outputPath), fsPath = require('path');
    const work = fsPath.join(root, `.sequence-${process.pid}-${Date.now()}`);
    require('fs').mkdirSync(work, { recursive: true });
    const files = [];
    try {
        for (let index = 0; index < sequence.length; index++) {
            const item = sequence[index], segmentPath = fsPath.join(work, `${String(index).padStart(3, '0')}.mp4`);
            if (item.type === 'op') {
                require('fs').copyFileSync(item.mediaPath, segmentPath);
            } else {
                await renderGamePart(mediaPath, { start: item.start, end: item.end, duration: item.end - item.start }, segmentPath, config, profile, hooks);
            }
            files.push(segmentPath);
        }
        const list = fsPath.join(work, 'concat.txt');
        require('fs').writeFileSync(list, files.map(file => `file '${file.replace(/'/gu, "'\\''")}'`).join('\n') + '\n', 'utf8');
        const ffmpegPath = config.audio?.ffmpeg?.path || 'ffmpeg';
        const mixedEditorialInputs = sequence.some(item => item.type === 'op');
        try {
            if (mixedEditorialInputs) throw new Error('Mixed OP/source frame rates require timestamp-normalized concat');
            await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outputPath],
                { ffmpegPath, threads: 1, timeoutMs: 30 * 60 * 1000, stage: '游戏高光合并' });
        } catch (copyError) {
            const inputs = files.flatMap(file => ['-i', file]);
            const chains = files.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('');
            await runFfmpeg(['-y', ...inputs, '-filter_complex', `${chains}concat=n=${files.length}:v=1:a=1[v][a]`,
                '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k',
                '-vsync', 'cfr', '-fps_mode', 'cfr', '-movflags', '+faststart', outputPath], { ffmpegPath, threads: 1, timeoutMs: 30 * 60 * 1000, stage: '游戏高光重编码', copyError });
        }
        const duration = await probeMediaDuration(outputPath, resolveFfprobePath(ffmpegPath));
        return { mediaPath: outputPath, bytes: require('fs').statSync(outputPath).size, sha256: fileDigest(outputPath), actualDuration: duration,
            processing: { resourceMode: profile?.mode || 'idle', videoEncoder: 'sequence-copy-or-h264', audioEncoder: 'source-or-aac', originalStreamCopy: false },
            audio: 'original_recording_mix', burnedSubtitles: false };
    } finally {
        try { require('fs').rmSync(work, { recursive: true, force: true }); } catch { /* retain no publication state */ }
    }
}

module.exports = { renderGamePart, renderGameSequence, gameCover };
