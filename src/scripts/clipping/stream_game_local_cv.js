'use strict';

/**
 * Cheap local visual evidence for game recordings.
 *
 * This module deliberately returns candidates and measurements only. It must
 * never turn a colour/layout heuristic into a factual death or gameplay claim.
 * The expensive multimodal review remains the authority for publication.
 */

const sharp = require('sharp');

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

async function frameMetrics(file) {
    const { data, info } = await sharp(file).resize({ width: 320, height: 180, fit: 'fill' })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let sum = 0, sum2 = 0, dark = 0, red = 0, white = 0, edges = 0;
    const width = info.width, height = info.height, channels = info.channels;
    const luminance = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        const r = data[i], g = data[i + (channels > 1 ? 1 : 0)], b = data[i + (channels > 2 ? 2 : 0)];
        const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const p = y * width + x;
        luminance[p] = l; sum += l; sum2 += l * l;
        if (l < 0.08) dark++;
        if (r > 125 && r > g * 1.35 && r > b * 1.35) red++;
        // RGB channels are 0..255 here; use a real tolerance instead of the
        // normalized luminance scale so anti-aliased white death text counts.
        if (l > 0.88 && Math.max(r, g, b) - Math.min(r, g, b) < 30) white++;
        if (x && Math.abs(l - luminance[p - 1]) > 0.18) edges++;
        if (y && Math.abs(l - luminance[p - width]) > 0.18) edges++;
    }
    const pixels = width * height;
    return {
        width, height,
        meanLuma: sum / pixels,
        variance: Math.max(0, sum2 / pixels - (sum / pixels) ** 2),
        darkRatio: dark / pixels,
        redRatio: red / pixels,
        whiteRatio: white / pixels,
        edgeRatio: edges / (pixels * 2),
    };
}

function histogramDistance(a, b) {
    if (!a || !b) return null;
    return clamp(Math.abs(a.meanLuma - b.meanLuma) * 1.8
        + Math.abs(a.darkRatio - b.darkRatio)
        + Math.abs(a.redRatio - b.redRatio) * 1.5
        + Math.abs(a.edgeRatio - b.edgeRatio), 0, 1);
}

function candidateDeathScore(metrics) {
    if (!metrics) return 0;
    // Red/white overlays on a darkened game scene are a useful recall signal
    // for titles such as YOU DIED / 死亡, but are intentionally only a score.
    const overlay = clamp(metrics.redRatio * 7 + metrics.whiteRatio * 1.8, 0, 1);
    const darkScene = clamp((0.62 - metrics.meanLuma) * 1.8, 0, 1);
    const lowMotionUi = clamp((0.08 - metrics.edgeRatio) * 6, 0, 1);
    return clamp(overlay * 0.55 + darkScene * 0.3 + lowMotionUi * 0.15, 0, 1);
}

function clusterCandidates(rows, threshold = 0.62, minGapSeconds = 8) {
    const selected = rows.filter(row => row.deathScore >= threshold);
    const clusters = [];
    for (const row of selected) {
        const last = clusters.at(-1);
        if (last && row.time - last.end <= minGapSeconds) {
            last.end = row.time;
            last.samples.push(row.index);
            last.score = Math.max(last.score, row.deathScore);
        } else clusters.push({ start: row.time, end: row.time, score: row.deathScore, samples: [row.index] });
    }
    return clusters;
}

async function analyzeFrames(samples, options = {}) {
    const rows = [];
    let previous = null;
    for (const sample of samples) {
        const metrics = await frameMetrics(sample.path);
        const row = { index: sample.index, time: sample.time, metrics,
            frameDelta: histogramDistance(previous?.metrics, metrics) };
        row.deathScore = candidateDeathScore(metrics);
        rows.push(row); previous = row;
    }
    return {
        version: 1,
        method: 'local_frame_metrics',
        sampleCount: rows.length,
        rows,
        sceneCuts: rows.filter(row => row.frameDelta != null && row.frameDelta >= (options.sceneCutThreshold ?? 0.48))
            .map(row => ({ index: row.index, time: row.time, score: row.frameDelta })),
        deathCandidates: clusterCandidates(rows, options.deathThreshold ?? 0.62, options.deathMinGapSeconds ?? 8),
        disclaimer: 'Heuristic candidates only; visual/audio review is required before publication.',
    };
}

function summarize(localEvidence) {
    return {
        method: localEvidence?.method || null,
        sampleCount: localEvidence?.sampleCount || 0,
        sceneCutCount: localEvidence?.sceneCuts?.length || 0,
        deathCandidateCount: localEvidence?.deathCandidates?.length || 0,
        deathCandidates: (localEvidence?.deathCandidates || []).map(row => ({ start: row.start, end: row.end, score: row.score })),
    };
}

module.exports = { frameMetrics, histogramDistance, candidateDeathScore, clusterCandidates, analyzeFrames, summarize };
