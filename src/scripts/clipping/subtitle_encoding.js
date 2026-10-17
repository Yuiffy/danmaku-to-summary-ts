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
    const threads = Number(config.ffmpegThreads ?? config.clipFfmpegThreads);
    // Decoder threads are input-scoped; output-only limits still let NVDEC request too many surfaces.
    const inputArgs = Number.isFinite(threads) && threads > 0 ? ['-threads', String(Math.max(1, Math.floor(threads)))] : [];
    if (options.forceCpu === true) return inputArgs;
    const hwaccel = String(
        config.subtitleHwaccel
        ?? process.env.FFMPEG_SUBTITLE_HWACCEL
        ?? ''
    ).trim().toLowerCase();
    if (!hwaccel || ['none', 'off', 'false'].includes(hwaccel)) return inputArgs;
    // Keep frames in system memory after decode: libass/subtitles is a CPU
    // filter and cannot consume cuda frames directly.
    return [...inputArgs, '-hwaccel', hwaccel];
}

function isNvencSubtitleEncoder(config = {}) {
    const encoder = String(
        process.env.FFMPEG_SUBTITLE_VIDEO_ENCODER
        || config.subtitleVideoEncoder
        || 'libx264'
    ).trim().toLowerCase();
    return encoder === 'h264_nvenc' || encoder === 'hevc_nvenc';
}

function calculateSubtitleStyle(width, height, config = {}) {
    // ASS 会把 PlayRes 坐标系自动缩放到输出画面。字号必须只按 PlayRes 计算，
    // 如果再按源视频高度缩放，720p 和 1080p 就会得到不同的画面占比。
    const videoWidth = Number(width);
    const videoHeight = Number(height);
    const isPortrait = Number.isFinite(videoWidth) && videoWidth > 0
        && Number.isFinite(videoHeight) && videoHeight > videoWidth;
    const landscapeFontSizeRatio = Number(config.subtitleFontSizeRatio ?? process.env.FFMPEG_SUBTITLE_FONT_SIZE_RATIO ?? 0.094);
    // 竖屏的可用横向空间明显更窄，单独控制字号，避免为了竖屏缩小所有横屏字幕。
    const portraitFontSizeRatio = Number(config.subtitlePortraitFontSizeRatio ?? process.env.FFMPEG_SUBTITLE_PORTRAIT_FONT_SIZE_RATIO ?? 0.044);
    const fontSizeRatio = isPortrait ? portraitFontSizeRatio : landscapeFontSizeRatio;
    const minFontSize = Number(config.subtitleMinFontSize ?? process.env.FFMPEG_SUBTITLE_MIN_FONT_SIZE ?? 30);
    const maxFontSize = Number(config.subtitleMaxFontSize ?? process.env.FFMPEG_SUBTITLE_MAX_FONT_SIZE ?? 72);
    const fontName = String(config.subtitleFontName ?? process.env.FFMPEG_SUBTITLE_FONT_NAME ?? '汉仪有圆 85简').trim() || '汉仪有圆 85简';
    const playResY = Number(config.subtitlePlayResY ?? process.env.FFMPEG_SUBTITLE_PLAYRES_Y ?? 720);
    const configuredPlayResX = Number(config.subtitlePlayResX ?? process.env.FFMPEG_SUBTITLE_PLAYRES_X);
    const playResX = Number.isFinite(configuredPlayResX) && configuredPlayResX > 0
        ? Math.round(configuredPlayResX)
        : (
            Number.isFinite(videoWidth) && videoWidth > 0 && Number.isFinite(videoHeight) && videoHeight > 0
                ? Math.max(1, Math.round(playResY * videoWidth / videoHeight))
                : 1280
        );
    const fontSize = Math.min(maxFontSize, Math.max(minFontSize, Math.round(playResY * fontSizeRatio)));
    const outline = Math.max(2, Math.round(fontSize * 0.09));
    const marginV = Number(config.subtitleMarginV ?? process.env.FFMPEG_SUBTITLE_MARGIN_V ?? 24);
    const marginL = Math.max(0, Number(config.subtitleMarginL ?? config.subtitleMarginHorizontal ?? process.env.FFMPEG_SUBTITLE_MARGIN_L ?? 32));
    const marginR = Math.max(0, Number(config.subtitleMarginR ?? config.subtitleMarginHorizontal ?? process.env.FFMPEG_SUBTITLE_MARGIN_R ?? 32));
    // 汉字实际字面通常略窄于 1em；横屏沿用 0.95em，竖屏则保持保守的 1em 安全估算。
    const glyphWidthRatio = Math.max(0.5, Number(
        config.subtitleGlyphWidthRatio
        ?? process.env.FFMPEG_SUBTITLE_GLYPH_WIDTH_RATIO
        ?? (isPortrait ? 1 : 0.95)
    ));
    const availableWidth = Math.max(fontSize, playResX - marginL - marginR - outline * 2);
    const calculatedMaxChars = Math.max(1, Math.floor(availableWidth / (fontSize * glyphWidthRatio)));
    const configuredMaxChars = Number(config.subtitleMaxCharsPerLine);
    const maxCharsPerLine = Number.isFinite(configuredMaxChars) && configuredMaxChars > 0
        ? Math.min(calculatedMaxChars, Math.floor(configuredMaxChars))
        : calculatedMaxChars;
    const forceStyle = `FontSize=${fontSize},FontName=${fontName},Bold=1,Outline=${outline}`;
    return {
        forceStyle,
        maxCharsPerLine,
        fontSize,
        outline,
        fontName,
        playResX,
        playResY,
        marginL,
        marginR,
        marginV
    };
}

module.exports = { calculateSubtitleStyle, buildSubtitleBurnVideoArgs, buildSubtitleBurnInputArgs, isNvencSubtitleEncoder };
