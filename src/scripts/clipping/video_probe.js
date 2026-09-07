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

async function getVideoResolution(mediaPath, ffprobePath = 'ffprobe') {
    const fingerprint = await videoFileFingerprint(mediaPath);
    const key = JSON.stringify([path.resolve(String(mediaPath || '')), String(ffprobePath)]);
    const cached = videoResolutionCache.get(key);
    if (fingerprint && cached?.fingerprint === fingerprint) return { ...await cached.promise };

    const entry = { fingerprint, promise: null };
    entry.promise = (async () => {
        try {
            const result = await new Promise((resolve, reject) => childProcess.execFile(ffprobePath, [
                '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height',
                '-of', 'csv=p=0',
                String(mediaPath)
            ], {
                encoding: 'utf8',
                timeout: 10000,
                windowsHide: true,
                shell: false,
                maxBuffer: 64 * 1024
            }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim())));
            const [width, height] = String(result).split(',').map(Number);
            if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
                throw new Error('Invalid video dimensions');
            }
            if (fingerprint !== await videoFileFingerprint(mediaPath) && videoResolutionCache.get(key) === entry) {
                videoResolutionCache.delete(key);
            }
            return { width, height };
        } catch {
            if (videoResolutionCache.get(key) === entry) videoResolutionCache.delete(key);
            return { width: 1920, height: 1080 };
        }
    })();
    if (fingerprint) {
        videoResolutionCache.set(key, entry);
        if (videoResolutionCache.size > 128) videoResolutionCache.delete(videoResolutionCache.keys().next().value);
    }
    return { ...await entry.promise };
}

module.exports = { getVideoResolution };

