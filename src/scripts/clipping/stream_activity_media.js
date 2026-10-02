'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { runFfmpeg, resolveFfprobePath } = require('./media_runtime');
const { probeMediaDuration } = require('./video_probe');
const { buildSubtitleBurnVideoArgs, buildSubtitleBurnInputArgs } = require('./subtitle_encoding');
const { fileDigest } = require('./source_snapshot');
const { writeJsonAtomic } = require('./candidate_subtitles');
const execFileAsync = promisify(execFile);

/** Accurate decoding/encoding avoids keyframe-sized gaps or repeated content between viewing Ps.
 * Keep the original mix: ASR lyrics and film dialogue are not suitable automatic burned subtitles. */
async function renderActivityPart(mediaPath, part, outputPath, config, profile, hooks = {}) {
    const ffmpegPath = config.audio?.ffmpeg?.path || 'ffmpeg';
    const settings = config.ownStreamClips || {};
    const run = hooks.runFfmpeg || runFfmpeg;
    const args = forceCpu => ['-y', '-ss', String(part.start), ...buildSubtitleBurnInputArgs(settings, { forceCpu }),
        '-i', mediaPath, '-t', String(part.duration), '-map', '0:v:0', '-map', '0:a:0',
        ...buildSubtitleBurnVideoArgs(settings, { forceCpu }), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath];
    const options = { ffmpegPath, threads: profile?.ffmpegThreads, timeoutMs: 30 * 60 * 1000, stage: '完整活动切片', gpuTelemetry: true };
    let fallbackUsed = false, fallbackReason = null;
    try { await run(args(false), options); }
    catch (error) {
        fallbackUsed = true; fallbackReason = error.message;
        await run(args(true), options);
    }
    const duration = await (hooks.probe || probeMediaDuration)(outputPath, resolveFfprobePath(ffmpegPath));
    if (Math.abs(duration - part.duration) > .25) throw new Error(`Activity P duration mismatch: wanted ${part.duration}, got ${duration}`);
    return { ...part, mediaPath: outputPath, bytes: fs.statSync(outputPath).size, sha256: fileDigest(outputPath), actualDuration: duration,
        processing: { resourceMode: profile?.mode || 'idle', ffmpegThreads: profile?.ffmpegThreads ?? null,
            videoEncoder: fallbackUsed ? 'libx264' : settings.subtitleVideoEncoder || 'libx264',
            hwaccel: fallbackUsed ? null : settings.subtitleHwaccel || null, fallbackUsed, fallbackReason },
        audio: 'original_recording_mix', burnedSubtitles: false };
}
async function activityCover(part, coverPath, config, presentation) {
    if (!presentation) throw new Error('Activity cover requires its music/cinema presentation');
    const directory = path.join(path.dirname(coverPath), 'temp', 'presentation', path.basename(coverPath, '.jpg'));
    fs.mkdirSync(directory, { recursive: true });
    const framePath = path.join(directory, 'frame.jpg'), presentationPath = path.join(directory, 'presentation.json');
    await runFfmpeg(['-y', '-ss', String(Math.min(part.duration / 2, 90)), '-i', part.mediaPath,
        '-frames:v', '1', '-vf', 'scale=1920:-2', '-q:v', '2', framePath],
    { ffmpegPath: config.audio?.ffmpeg?.path || 'ffmpeg', stage: '活动切片封面', timeoutMs: 60000 });
    writeJsonAtomic(presentationPath, presentation);
    await execFileAsync('python', [path.resolve(__dirname, '../stream_activity_cover.py'), '--frame', framePath,
        '--presentation', presentationPath, '--output', coverPath], { windowsHide: true, shell: false, timeout: 60000, maxBuffer: 1024 * 1024 });
    return coverPath;
}
module.exports = { renderActivityPart, activityCover };
