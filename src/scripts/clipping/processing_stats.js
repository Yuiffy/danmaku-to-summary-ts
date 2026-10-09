'use strict';
// Processing metrics and review presentation; no media or publication IO.

function formatProcessingDuration(milliseconds) {
    if (milliseconds === null || milliseconds === undefined || milliseconds === '') return '未知';
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) return '未知';
    if (value < 1000) return `${(value / 1000).toFixed(1)}秒`;
    let totalSeconds = Math.round(value / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}分`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
    return parts.join('');
}

function formatPercent(value) {
    if (value === null || value === undefined || value === '') return '不可用';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '不可用';
    return `${Number(numeric.toFixed(1))}%`;
}

function formatMemoryMb(value) {
    if (value === null || value === undefined || value === '') return '不可用';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '不可用';
    if (numeric >= 1024) return `${(numeric / 1024).toFixed(1)} GB`;
    return `${Math.round(numeric)} MB`;
}

function summarizeResourcePeaks(peaks = []) {
    const entries = (Array.isArray(peaks) ? peaks : [])
        .filter(item => item && typeof item === 'object');
    const weightedAverage = (valueKey, weightKey, fallbackKey = null) => {
        let weightedTotal = 0;
        let weightTotal = 0;
        for (const entry of entries) {
            const value = Number(entry[valueKey]);
            const fallback = fallbackKey ? Number(entry[fallbackKey]) : null;
            const resolved = Number.isFinite(value) ? value : fallback;
            if (!Number.isFinite(resolved)) continue;
            const weight = Math.max(1, Number(entry[weightKey]) || 1);
            weightedTotal += resolved * weight;
            weightTotal += weight;
        }
        return weightTotal > 0 ? Number((weightedTotal / weightTotal).toFixed(2)) : null;
    };
    const maximum = key => {
        const values = entries.map(entry => Number(entry[key])).filter(Number.isFinite);
        return values.length > 0 ? Number(Math.max(...values).toFixed(2)) : null;
    };
    const sum = key => entries.reduce((total, entry) => {
        const value = Number(entry[key]);
        return total + (Number.isFinite(value) ? value : 0);
    }, 0);
    const gpuUtilPeakPct = maximum('gpuUtilPeakPct');
    const gpuAvailable = entries.some(entry => (
        entry.gpuAvailable === true || Number.isFinite(Number(entry.gpuUtilPeakPct))
    ));

    return {
        stageCount: entries.length,
        hostCpuAvgPct: weightedAverage('hostCpuAvgPct', 'samples', 'hostCpuPeakPct'),
        hostCpuPeakPct: maximum('hostCpuPeakPct'),
        gpuAvailable,
        gpuUtilAvgPct: weightedAverage('gpuUtilAvgPct', 'gpuSamples', 'gpuUtilPeakPct'),
        gpuUtilPeakPct,
        gpuMemoryUsedPeakMb: maximum('gpuMemoryUsedPeakMb'),
        gpuMemoryTotalMb: maximum('gpuMemoryTotalMb'),
        gpuSamples: sum('gpuSamples'),
        gpuQueryErrors: sum('gpuQueryErrors')
    };
}

function buildClipProcessingStats(results = [], elapsedMs, startedAt = null, finishedAt = null) {
    const timings = (Array.isArray(results) ? results : [])
        .map(result => Number(result?.processing?.elapsedMs))
        .filter(value => Number.isFinite(value) && value >= 0);
    const totalClipElapsedMs = timings.reduce((total, value) => total + value, 0);
    const resourcePeaks = (Array.isArray(results) ? results : [])
        .flatMap(result => Array.isArray(result?.processing?.resourcePeaks)
            ? result.processing.resourcePeaks
            : []);

    return {
        version: 1,
        startedAt,
        finishedAt,
        totalElapsedMs: Number.isFinite(Number(elapsedMs)) ? Math.round(Number(elapsedMs)) : null,
        averageClipElapsedMs: timings.length > 0
            ? Math.round(totalClipElapsedMs / timings.length)
            : null,
        totalClipElapsedMs: Math.round(totalClipElapsedMs),
        mediaElapsedMs: results.reduce((n, result) => n + (Number(result?.processing?.mediaElapsedMs) || 0), 0),
        enhancementElapsedMs: results.reduce((n, result) => n + (Number(result?.processing?.enhancementElapsedMs) || 0), 0),
        clipCount: Array.isArray(results) ? results.length : 0,
        timedClipCount: timings.length,
        resource: summarizeResourcePeaks(resourcePeaks)
    };
}

function buildProcessingSummaryLines(stats = null) {
    if (!stats || typeof stats !== 'object') return [];
    const clipCount = Number.isFinite(Number(stats.clipCount)) ? Number(stats.clipCount) : 0;
    const average = formatProcessingDuration(stats.averageClipElapsedMs);
    const total = formatProcessingDuration(stats.totalElapsedMs);
    const resource = stats.resource || {};
    const memory = resource.gpuAvailable
        ? `${formatMemoryMb(resource.gpuMemoryUsedPeakMb)}/${formatMemoryMb(resource.gpuMemoryTotalMb)}`
        : '不可用';
    return [
        `切片耗时: 总耗时 ${total}，平均每个切片 ${average}（${clipCount} 段）`,
        ...(stats.mediaElapsedMs ? [`阶段累计耗时（含并发重叠）: 媒体 ${formatProcessingDuration(stats.mediaElapsedMs)}，AI增强 ${formatProcessingDuration(stats.enhancementElapsedMs)}`] : []),
        `资源占用: CPU 平均 ${formatPercent(resource.hostCpuAvgPct)} / 峰值 ${formatPercent(resource.hostCpuPeakPct)}；GPU 平均 ${formatPercent(resource.gpuUtilAvgPct)} / 峰值 ${formatPercent(resource.gpuUtilPeakPct)}；显存峰值 ${memory}`
    ];
}

module.exports = { formatProcessingDuration, summarizeResourcePeaks, buildClipProcessingStats, buildProcessingSummaryLines };
