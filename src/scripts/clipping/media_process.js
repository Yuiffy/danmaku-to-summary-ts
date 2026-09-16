'use strict';

const { spawn } = require('child_process');
const configLoader = require('../config-loader');
const { DEFAULT_CLIP_TOPICS_CONFIG } = require('./topic_config');
const { probeMediaDuration } = require('./video_probe');
const { applyFfmpegProcessPriority, getFfmpegResourceConfig, startResourcePeakMonitor,
    waitForAsrAvailability, waitForCpuAvailability, withFfmpegResourceLimits } = require('../ffmpeg_resource');

async function runFfmpeg(args, options = {}) {
    const resourceConfig = {
        ...(options.resourceConfig || getFfmpegResourceConfig(configLoader.getConfig())),
        ...(Number.isFinite(Number(options.threads)) ? { threads: Number(options.threads) } : {})
    };
    const stage = options.stage || '话题切片 ffmpeg';
    const asrState = await waitForAsrAvailability(stage, resourceConfig);
    const effectiveResourceConfig = { ...resourceConfig };
    if (asrState.asrActive && Number(effectiveResourceConfig.threads) > 0) {
        const overlapThreads = Math.max(1, Number(effectiveResourceConfig.asrGuard?.overlapThreads) || 1);
        effectiveResourceConfig.threads = Math.min(
            Number(effectiveResourceConfig.threads),
            overlapThreads
        );
        console.log(`[resource] ${stage} 与 ASR 重叠，FFmpeg threads=${effectiveResourceConfig.threads}`);
    }
    await waitForCpuAvailability(stage, effectiveResourceConfig);
    return new Promise((resolve, reject) => {
        const ffmpegPath = options.ffmpegPath || 'ffmpeg';
        const commandArgs = withFfmpegResourceLimits(args, effectiveResourceConfig);
        const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_CLIP_TOPICS_CONFIG.ffmpegTimeoutMs);
        const child = spawn(ffmpegPath, commandArgs, {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
            shell: false
        });
        applyFfmpegProcessPriority(child.pid, effectiveResourceConfig.priority);
        let resourcePeak = null;
        const peakMonitor = startResourcePeakMonitor(stage, {
            resourceConfig: effectiveResourceConfig,
            gpuTelemetry: options.gpuTelemetry === true,
            nvidiaSmiPath: options.nvidiaSmiPath,
            onStop: peak => {
                resourcePeak = peak;
                if (typeof options.onResourcePeak === 'function') {
                    options.onResourcePeak(peak);
                }
            }
        });
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const finish = (callback) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            peakMonitor.stop();
            callback();
        };
        const timeoutId = setTimeout(() => {
            timedOut = true;
            try {
                const killed = child.kill('SIGKILL');
                if (!killed) {
                    finish(() => reject(new Error(`ffmpeg timed out after ${timeoutMs}ms and could not be terminated`)));
                }
            } catch {
                finish(() => reject(new Error(`ffmpeg timed out after ${timeoutMs}ms and could not be terminated`)));
            }
        }, timeoutMs);
        child.stderr.on('data', chunk => {
            stderr = `${stderr}${chunk.toString()}`.slice(-32768);
        });
        child.on('error', error => finish(() => reject(error)));
        child.on('close', code => {
            finish(() => {
                if (timedOut) {
                    reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
                    return;
                }
                if (code === 0) {
                    resolve({ stderr, resourcePeak });
                    return;
                }
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
            });
        });
    });
}

function probeVideoPacketsWithHashes(ffmpegPath, mediaPath, readInterval) {
    return new Promise((resolve, reject) => {
        const ffprobePath = resolveFfprobePath(ffmpegPath);
        const child = spawn(ffprobePath, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_packets',
            '-show_entries', 'packet=pts_time,dts_time,flags,data_hash',
            '-show_data_hash', 'md5',
            '-of', 'json',
            '-read_intervals', readInterval,
            mediaPath
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) {
                reject(new Error(`ffprobe packet hash probe exited with code ${code}: ${stderr.slice(-300)}`));
                return;
            }
            try {
                const parsed = JSON.parse(stdout || '{}');
                resolve(Array.isArray(parsed.packets) ? parsed.packets : []);
            } catch (error) {
                reject(new Error(`ffprobe packet hash output is invalid JSON: ${error.message}`));
            }
        });
    });
}

function resolveFfprobePath(ffmpegPath = 'ffmpeg') {
    const normalized = String(ffmpegPath || 'ffmpeg').trim() || 'ffmpeg';
    return normalized.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

function findMatchingPacketTime(roughPacket, sourcePackets, targetTime) {
    const hash = String(roughPacket?.data_hash || '').trim();
    if (!hash) return null;
    const matches = (sourcePackets || [])
        .filter(packet => String(packet?.data_hash || '').trim() === hash)
        .map(packet => Number(packet?.pts_time ?? packet?.dts_time))
        .filter(time => Number.isFinite(time) && time >= 0 && time <= Number(targetTime) + 0.5)
        .sort((a, b) => b - a);
    return matches.length > 0 ? matches[0] : null;
}

/**
 * Locate the stream-copy rough cut's real source origin by matching its first
 * compressed keyframe packet against a small source window. Packet hashing
 * avoids decoding and follows ffmpeg's actual demux seek, which can differ by
 * a full GOP from ffprobe's predicted keyframe on indexed FLV files.
 */
async function probeRoughCutSourceStart(ffmpegPath, sourcePath, roughPath, targetTime) {
    const roughPackets = await probeVideoPacketsWithHashes(ffmpegPath, roughPath, '%+#1');
    const roughPacket = roughPackets[0];
    if (!roughPacket?.data_hash) {
        throw new Error('rough cut has no hashable first video packet');
    }
    if (!String(roughPacket.flags || '').includes('K')) {
        throw new Error('rough cut first video packet is not a keyframe');
    }

    const lookbacks = [30, 120];
    for (const lookback of lookbacks) {
        const searchStart = Math.max(0, Number(targetTime) - lookback);
        const searchDuration = Math.max(2, Number(targetTime) - searchStart + 2);
        const sourcePackets = await probeVideoPacketsWithHashes(
            ffmpegPath,
            sourcePath,
            `${searchStart}%+${searchDuration}`
        );
        const matchedTime = findMatchingPacketTime(roughPacket, sourcePackets, targetTime);
        if (matchedTime !== null) return matchedTime;
    }
    throw new Error(`could not match rough cut first packet near source time ${targetTime}`);
}

module.exports = { runFfmpeg, probeVideoPacketsWithHashes, resolveFfprobePath, findMatchingPacketTime, probeRoughCutSourceStart, probeMediaDuration };
