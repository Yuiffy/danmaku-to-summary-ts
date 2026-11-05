const fs = require('fs');
const asrBackends = require('../asr/asr_backends');
const { getOverlappingSegments, clamp } = require('./topic_selection');
function formatSrtTimestamp(seconds) {
    return asrBackends.formatTimestamp(seconds);
}

function wrapSubtitleText(text, maxCharsPerLine = 20) {
    const limit = Math.max(1, Number(maxCharsPerLine) || 20);
    return String(text || '').split(/\r?\n/).flatMap(line => {
        const trimmed = line.trim();
        const characters = Array.from(trimmed);
        if (!trimmed || characters.length <= limit) return [trimmed];
        const wrapped = [];
        let offset = 0;
        const isWordChar = char => Boolean(char && /[A-Za-z0-9]/.test(char));
        while (offset < characters.length) {
            const remaining = characters.length - offset;
            let end = offset + Math.ceil(remaining / Math.ceil(remaining / limit));
            if (isWordChar(characters[end - 1]) && isWordChar(characters[end])) {
                let wordStart = end - 1, wordEnd = end;
                while (wordStart > offset && isWordChar(characters[wordStart - 1])) wordStart--;
                while (wordEnd < characters.length && isWordChar(characters[wordEnd])) wordEnd++;
                if (wordEnd - offset <= limit) end = wordEnd;
                else if (wordStart > offset) end = wordStart;
                // A token longer than the whole line still has to be split.
            }
            wrapped.push(characters.slice(offset, end).join(''));
            offset = end;
        }
        return wrapped;
    }).join('\n');
}

function parseSpeakerReviewText(text) {
    const value = String(text || '').trim();
    const match = value.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
    if (!match) {
        return { text: value };
    }

    const label = match[1].trim();
    const scoreMatch = label.match(/^(.*?)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
    const speaker = (scoreMatch ? scoreMatch[1] : label).trim();
    const score = scoreMatch ? Number(scoreMatch[2]) : null;
    return {
        text: match[2].trim(),
        speaker: speaker || 'UNKNOWN',
        ...(Number.isFinite(score) ? { speaker_score: score } : {})
    };
}

function parseTopicSrt(srtPath) {
    const parsed = asrBackends.parseSrt(srtPath, 'topic_clip');
    const isSpeakerReviewSrt = /\.speaker\.srt$/i.test(String(srtPath || ''));
    if (isSpeakerReviewSrt) {
        parsed.segments = parsed.segments.map(segment => ({ ...segment, ...parseSpeakerReviewText(segment.text) }));
    }
    const evidenceSrtPath = isSpeakerReviewSrt ? srtPath.replace(/\.speaker\.srt$/i, '.srt') : srtPath;
    const provenance = require('../asr/evidence_sidecar').loadAsrEvidence(evidenceSrtPath, parsed.segments);
    return { ...parsed, segments: provenance.segments, asrEvidenceStatus: provenance.status };
}

function writeClipSrt(segments = [], window, outputPath, options = {}) {
    const lines = [];
    const clipSegments = getOverlappingSegments(segments, window);
    const writtenSegments = [];
    let lineIndex = 1;

    for (const segment of clipSegments) {
        const start = clamp(Number(segment.start) - window.start, 0, window.duration);
        const end = clamp(Number(segment.end) - window.start, 0, window.duration);
        const rawText = String(segment.text || '').trim();
        const text = options.stripPunctuation
            ? asrBackends.stripSubtitlePunctuation(rawText)
            : rawText;
        if (!text || end <= start) {
            continue;
        }
        const wrappedText = wrapSubtitleText(text, options.maxCharsPerLine);
        lines.push(String(lineIndex));
        lines.push(`${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`);
        lines.push(wrappedText);
        lines.push('');
        writtenSegments.push({
            ...segment,
            start,
            end,
            text: wrappedText
        });
        lineIndex += 1;
    }

    fs.writeFileSync(outputPath, `${lines.join('\n').trim()}\n`, 'utf8');
    return {
        path: outputPath,
        segmentCount: lineIndex - 1,
        segments: writtenSegments
    };
}

function srtTimestampToAss(value) {
    const match = String(value || '').match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
    if (!match) return '0:00:00.00';
    const hours = String(Number(match[1]));
    const minutes = match[2];
    const seconds = match[3];
    const centiseconds = String(Math.floor(Number(match[4]) / 10)).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}.${centiseconds}`;
}

function assEscapeText(text) {
    return String(text || '')
        .replace(/\\/g, '\\\\')
        .replace(/\r?\n/g, '\\N')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\u007f/g, '');
}

const SPEAKER_OUTLINE_COLORS = [
    '#ff66cc',
    '#66ccff',
    '#66e6a3',
    '#ffcc66',
    '#b388ff',
    '#ff7777',
    '#66d9ff',
    '#d9d966'
];

function rgbHexToAssColor(value) {
    const match = String(value || '').trim().match(/^#?([0-9a-f]{6})$/i);
    if (!match) return '&H00000000';
    const rgb = match[1].toUpperCase();
    return `&H00${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
}

function buildSpeakerStyleName(speaker, index) {
    const safe = String(speaker || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^\d+/, '');
    return `Speaker_${safe || index + 1}`;
}

function buildSpeakerStyles(speakerSegments = []) {
    const speakers = Array.from(new Set(
        speakerSegments
            .map(segment => String(segment?.speaker || '').trim())
            .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));
    const styles = new Map();
    const usedNames = new Set(['Default']);
    speakers.forEach((speaker, index) => {
        let name = buildSpeakerStyleName(speaker, index);
        if (usedNames.has(name)) {
            name = `${name}_${index + 1}`;
        }
        usedNames.add(name);
        styles.set(speaker, {
            name,
            outlineColour: rgbHexToAssColor(SPEAKER_OUTLINE_COLORS[index % SPEAKER_OUTLINE_COLORS.length])
        });
    });
    return styles;
}

function buildBurnAssContentFromSrt(srtContent, style = {}) {
    const playResX = Number(style.playResX) || 1280;
    const playResY = Number(style.playResY) || 720;
    const fontName = String(style.fontName || '汉仪有圆 85简');
    const fontSize = Number(style.fontSize) || 31;
    const outline = Number(style.outline) || 2;
    const marginV = Number(style.marginV) || 24;
    const alignment = Number(style.alignment) || 2;
    const bold = Number(style.bold) || 1;
    const shadow = Number(style.shadow) || 0;
    const wrapStyle = Number(style.wrapStyle) || 2;
    const marginL = Math.max(0, Number(style.marginL) || 32);
    const marginR = Math.max(0, Number(style.marginR) || 32);
    const maxCharsPerLine = Number(style.maxCharsPerLine);
    const speakerSegments = Array.isArray(style.speakerSegments) ? style.speakerSegments : [];
    const speakerStyles = buildSpeakerStyles(speakerSegments);
    const blocks = String(srtContent || '').trim().split(/\r?\n\r?\n+/).filter(Boolean);
    const events = [];

    blocks.forEach((block, blockIndex) => {
        const lines = block.split(/\r?\n/);
        if (lines.length < 3) return;
        const timeLine = lines[1].trim();
        const match = timeLine.match(/^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})$/);
        if (!match) return;
        const shouldRewrap = Number.isFinite(maxCharsPerLine) && maxCharsPerLine > 0;
        const rawText = lines.slice(2).join(shouldRewrap ? '' : '\n').trim();
        const text = shouldRewrap
            ? wrapSubtitleText(rawText, maxCharsPerLine)
            : rawText;
        if (!text) return;
        const speaker = String(speakerSegments[blockIndex]?.speaker || '').trim();
        const speakerStyle = speakerStyles.get(speaker);
        events.push(`Dialogue: 0,${srtTimestampToAss(match[1])},${srtTimestampToAss(match[2])},${speakerStyle?.name || 'Default'},,0,0,0,,${assEscapeText(text)}`);
    });

    const defaultStyle = `Style: Default,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1`;
    const speakerStyleLines = Array.from(speakerStyles.values()).map(speakerStyle =>
        `Style: ${speakerStyle.name},${fontName},${fontSize},&H00FFFFFF,&H000000FF,${speakerStyle.outlineColour},&H00000000,${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1`
    );

    return [
        '[Script Info]',
        'ScriptType: v4.00+',
        'ScaledBorderAndShadow: yes',
        `PlayResX: ${playResX}`,
        `PlayResY: ${playResY}`,
        `WrapStyle: ${wrapStyle}`,
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        defaultStyle,
        ...speakerStyleLines,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ...events,
        ''
    ].join('\n');
}

function writeTemporaryBurnAssFromSrt(srtPath, assPath, style = {}) {
    const srtContent = fs.readFileSync(srtPath, 'utf8');
    const assContent = buildBurnAssContentFromSrt(srtContent, style);
    fs.writeFileSync(assPath, assContent, 'utf8');
    return assPath;
}
module.exports = {
    formatSrtTimestamp,
    wrapSubtitleText,
    parseTopicSrt,
    writeClipSrt,
    buildBurnAssContentFromSrt,
    writeTemporaryBurnAssFromSrt
};
