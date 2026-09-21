'use strict';

function buildSubtitleBurnVideoArgs(config = {}, options = {}) {
    const forceCpu = options.forceCpu === true;
    const encoder = forceCpu
        ? 'libx264'
        : String(process.env.FFMPEG_SUBTITLE_VIDEO_ENCODER || config.subtitleVideoEncoder || 'libx264').trim();
    const cq = String(config.subtitleVideoCq ?? process.env.FFMPEG_SUBTITLE_VIDEO_CQ ?? 23);
    const crf = String(config.subtitleVideoCrf ?? process.env.FFMPEG_SUBTITLE_VIDEO_CRF ?? 23);

    if (!forceCpu && (encoder === 'h264_nvenc' || encoder === 'hevc_nvenc')) {
        const rawPreset = String(process.env.FFMPEG_SUBTITLE_VIDEO_PRESET || config.subtitleVideoPreset || 'p4').trim();
        const preset = rawPreset === 'ultrafast' ? 'p4' : rawPreset;
        return ['-c:v', encoder, '-preset', preset || 'p4', '-cq', cq];
    }

    const preset = forceCpu
        ? String(process.env.FFMPEG_SUBTITLE_CPU_FALLBACK_PRESET || config.subtitleCpuFallbackPreset || 'ultrafast').trim()
        : String(process.env.FFMPEG_SUBTITLE_VIDEO_PRESET || config.subtitleVideoPreset || 'ultrafast').trim();
    return ['-c:v', encoder || 'libx264', '-preset', preset || 'ultrafast', '-crf', crf];
}

function buildSubtitleBurnInputArgs(config = {}, options = {}) {
    if (options.forceCpu === true) return [];
    const hwaccel = String(
        config.subtitleHwaccel
        ?? process.env.FFMPEG_SUBTITLE_HWACCEL
        ?? ''
    ).trim().toLowerCase();
    if (!hwaccel || ['none', 'off', 'false'].includes(hwaccel)) return [];
    // Keep frames in system memory after decode: libass/subtitles is a CPU
    // filter and cannot consume cuda frames directly.
    return ['-hwaccel', hwaccel];
}

function isNvencSubtitleEncoder(config = {}) {
    const encoder = String(
        process.env.FFMPEG_SUBTITLE_VIDEO_ENCODER
        || config.subtitleVideoEncoder
        || 'libx264'
    ).trim().toLowerCase();
    return encoder === 'h264_nvenc' || encoder === 'hevc_nvenc';
}

module.exports = { buildSubtitleBurnVideoArgs, buildSubtitleBurnInputArgs, isNvencSubtitleEncoder };
