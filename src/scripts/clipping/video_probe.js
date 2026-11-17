'use strict';
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const videoResolutionCache = new Map();

async function videoFileFingerprint(mediaPath) {
    try {
        const stat = await fs.promises.stat(mediaPath);
        return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    } catch {
        return null;
    }
}

async function getVideoResolution(mediaPath, ffprobePath = 'ffprobe', atSeconds = null) {
    const timed = atSeconds !== null;
    if (timed && (!Number.isFinite(atSeconds) || atSeconds < 0)) throw new Error('Invalid video resolution probe time');
    const fingerprint = await videoFileFingerprint(mediaPath);
    const key = JSON.stringify([path.resolve(String(mediaPath || '')), String(ffprobePath), atSeconds]);
    const cached = videoResolutionCache.get(key);
    if (fingerprint && cached?.fingerprint === fingerprint) return { ...await cached.promise };

    const entry = { fingerprint, promise: null };
    entry.promise = (async () => {
        try {
            const deadline = Date.now() + (timed ? 60000 : 10000);
            const probe = seconds => new Promise((resolve, reject) => childProcess.execFile(ffprobePath, [
                '-v', 'error',
                '-select_streams', 'v:0',
                ...(timed ? ['-read_intervals', `${atSeconds}%${atSeconds + seconds}`,
                    '-show_entries', 'frame=width,height,best_effort_timestamp_time', '-of', 'json']
                    : ['-show_entries', 'stream=width,height', '-of', 'csv=p=0']),
                String(mediaPath)
            ], {
                encoding: 'utf8',
                // Both windows share one deadline; a sparse stream gets one wider lookup.
                timeout: Math.max(1, deadline - Date.now()),
                windowsHide: true,
                shell: false,
                maxBuffer: timed ? 1024 * 1024 : 64 * 1024
            }, (error, stdout) => error ? reject(new Error(`${error.message} (code=${error.code ?? 'none'}, signal=${error.signal ?? 'none'}, killed=${!!error.killed})`))
                : resolve(String(stdout).trim())));
            // A merged recording can switch orientation after its initial stream header.
            // Seeking may land at an earlier keyframe; only use a decoded frame in this clip.
            const localFrame = result => JSON.parse(result).frames?.find(row =>
                Number(row.best_effort_timestamp_time) >= atSeconds && Number(row.best_effort_timestamp_time) <= atSeconds + 15
                && Number.isInteger(row.width) && row.width > 0 && Number.isInteger(row.height) && row.height > 0);
            // Fifteen seconds at 60 fps decodes hundreds of needless frames on every clip.
            // Try a short window first, retaining the wider search for sparse/keyframe gaps.
            const result = await probe(2);
            let frame = timed ? localFrame(result) : null;
            if (timed && !frame && Date.now() < deadline) frame = localFrame(await probe(15));
            const [width, height] = timed ? [frame?.width, frame?.height] : String(result).split(',').map(Number);
            if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
                throw new Error('Invalid video dimensions');
            }
            if (fingerprint !== await videoFileFingerprint(mediaPath) && videoResolutionCache.get(key) === entry) {
                videoResolutionCache.delete(key);
            }
            return { width, height };
        } catch (error) {
            if (videoResolutionCache.get(key) === entry) videoResolutionCache.delete(key);
            if (timed) throw new Error(`Cannot determine clip-local video resolution: ${error.message}`);
            return { width: 1920, height: 1080 };
        }
    })();
    if (fingerprint) {
        videoResolutionCache.set(key, entry);
        if (videoResolutionCache.size > 128) videoResolutionCache.delete(videoResolutionCache.keys().next().value);
    }
    return { ...await entry.promise };
}

const fractionToNumber = value => {
    const [numerator, denominator] = String(value || '').split('/').map(Number);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : NaN;
};

/** Normalising mixed playback rates needs one constant output rate; fall back to null. */
function getVideoFrameRate(mediaPath, ffprobePath = 'ffprobe') {
    return new Promise(resolve => childProcess.execFile(ffprobePath, [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate', '-of', 'json', String(mediaPath)
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false, maxBuffer: 65536 }, (error, stdout) => {
        if (error) return resolve(null);
        try {
            const stream = JSON.parse(String(stdout)).streams?.[0] || {};
            const rate = [stream.avg_frame_rate, stream.r_frame_rate].map(fractionToNumber).find(value => Number.isFinite(value) && value >= 10 && value <= 120);
            resolve(Number.isFinite(rate) ? Math.round(rate * 1000) / 1000 : null);
        } catch { resolve(null); }
    }));
}

function probeMediaDuration(mediaPath, ffprobePath = 'ffprobe') {    return new Promise((resolve, reject) => childProcess.execFile(ffprobePath, [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', String(mediaPath)
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false, maxBuffer: 65536 },
    (error, stdout) => {
        const duration = Number(String(stdout).trim());
        if (error || !Number.isFinite(duration) || duration <= 0) reject(error || new Error('Invalid media duration'));
        else resolve(duration);
    }));
}

module.exports = { getVideoResolution, getVideoFrameRate, probeMediaDuration };
