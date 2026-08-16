'use strict';

const fs = require('fs');
const path = require('path');
const topicClipper = require('./topic_clipper');

const DEFAULT_KEYWORDS = [
    '显卡', '内存', '电脑', '机箱', '整机', '游戏', 'AI', '丧尸', '旅游', '歌曲',
    '饼干岁', '哈哈', '笑', '但是', '没想到', '怎么', '为什么', '真的'
];

function parseDanmakuXml(xmlPath) {
    if (!xmlPath || !fs.existsSync(xmlPath)) return [];
    const xml = fs.readFileSync(xmlPath, 'utf8');
    const rows = [];
    for (const match of xml.matchAll(/<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/gi)) {
        const attrs = String(match[1] || '').split(',');
        const time = Number(attrs[0]);
        if (!Number.isFinite(time)) continue;
        const text = String(match[2] || '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
        if (text) rows.push({ time, text });
    }
    return rows;
}

function normalizeWindow(window) {
    const start = Number(window?.start);
    const end = Number(window?.end ?? (start + Number(window?.duration || 0)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { start, end };
}

function overlapSeconds(a, b) {
    return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function buildResidualCandidates({
    segments = [],
    danmaku = [],
    selectedWindows = [],
    windowSeconds = 90,
    stepSeconds = 45,
    maxCandidates = 12,
    keywords = DEFAULT_KEYWORDS
} = {}) {
    const cleanSegments = segments
        .map(segment => ({ start: Number(segment.start), end: Number(segment.end), text: String(segment.text || '').trim() }))
        .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text);
    if (!cleanSegments.length) return [];
    const selected = selectedWindows.map(normalizeWindow).filter(Boolean);
    const totalDuration = Math.max(...cleanSegments.map(segment => segment.end));
    const length = Math.max(30, Number(windowSeconds) || 90);
    const step = Math.max(15, Number(stepSeconds) || Math.round(length / 2));
    const candidates = [];
    for (let start = 0; start < totalDuration; start += step) {
        const window = { start, end: Math.min(totalDuration, start + length) };
        if (window.end - window.start < 30) continue;
        const overlap = selected.reduce((sum, item) => sum + overlapSeconds(window, item), 0);
        // Residual review is a set difference: even a small overlap would
        // make the same spoken line appear in both automatic and residual work.
        if (overlap > 0) continue;
        const inside = cleanSegments.filter(segment => segment.end > window.start && segment.start < window.end);
        if (!inside.length) continue;
        const text = inside.map(segment => segment.text).join(' ');
        const chars = Array.from(text.replace(/\s+/g, '')).length;
        const density = danmaku.filter(item => Number(item.time) >= window.start && Number(item.time) <= window.end).length;
        const keywordHits = keywords.reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0);
        const reactionHits = (text.match(/哈哈|笑死|好笑|真的|怎么|为什么|没想到|但是/g) || []).length;
        const score = Math.round(
            Math.min(32, chars / 50)
            + Math.min(28, density / 3)
            + Math.min(24, keywordHits * 3)
            + Math.min(16, reactionHits * 2)
        );
        candidates.push({
            start: window.start,
            end: window.end,
            duration: window.end - window.start,
            score,
            subtitleChars: chars,
            danmakuCount: density,
            keywordHits,
            sample: text.slice(0, 180)
        });
    }
    candidates.sort((a, b) => b.score - a.score || a.start - b.start);
    const chosen = [];
    for (const candidate of candidates) {
        if (chosen.some(item => overlapSeconds(item, candidate) > 15)) continue;
        chosen.push(candidate);
        if (chosen.length >= Math.max(1, Number(maxCandidates) || 12)) break;
    }
    return chosen.sort((a, b) => a.start - b.start);
}

function formatClock(seconds) {
    return topicClipper.formatClock(seconds);
}

function buildResidualReview({ sourcePath, selectedWindows = [], candidates = [], generatedAt = new Date().toISOString() } = {}) {
    const lines = [
        '# 直播结束后残余高光审计',
        '',
        `生成时间: ${generatedAt}`,
        `录播源: ${sourcePath || '未知'}`,
        '',
        '本文件只提供待人工确认的候选，不自动投稿。候选来自自动切片未覆盖的字幕窗口，综合字幕密度、弹幕数量、关键词和情绪转折信号排序。',
        '',
        `已切窗口数: ${selectedWindows.length}`,
        `残余候选数: ${candidates.length}`,
        '',
        '## 候选列表',
        ''
    ];
    candidates.forEach((candidate, index) => {
        lines.push(`${index + 1}. ${formatClock(candidate.start)}-${formatClock(candidate.end)} | 分数 ${candidate.score} | 字幕 ${candidate.subtitleChars} 字 | 弹幕 ${candidate.danmakuCount} 条 | 关键词 ${candidate.keywordHits}`);
        lines.push(`   字幕摘录: ${candidate.sample}`);
        lines.push('   状态: 待人工确认');
        lines.push('');
    });
    return lines.join('\n');
}

function readSelectedWindows(planPath, fallback = []) {
    if (!planPath || !fs.existsSync(planPath)) return fallback.map(normalizeWindow).filter(Boolean);
    try {
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        const windows = Array.isArray(plan.clips) ? plan.clips : [];
        return windows.map(normalizeWindow).filter(Boolean);
    } catch (_) {
        return fallback.map(normalizeWindow).filter(Boolean);
    }
}

function writeResidualReview(options = {}) {
    if (!options.srtPath || !fs.existsSync(options.srtPath)) throw new Error(`SRT not found: ${options.srtPath}`);
    const parsed = topicClipper.parseTopicSrt(options.srtPath);
    const selectedWindows = readSelectedWindows(options.planPath, options.selectedWindows || []);
    const danmaku = options.xmlPath ? parseDanmakuXml(options.xmlPath) : [];
    const candidates = buildResidualCandidates({
        segments: parsed.segments,
        danmaku,
        selectedWindows,
        windowSeconds: options.windowSeconds,
        stepSeconds: options.stepSeconds,
        maxCandidates: options.maxCandidates,
        keywords: options.keywords || DEFAULT_KEYWORDS
    });
    const outputPath = options.outputPath || path.join(path.dirname(options.srtPath), 'RESIDUAL_REVIEW.md');
    fs.writeFileSync(outputPath, buildResidualReview({
        sourcePath: options.mediaPath || options.srtPath,
        selectedWindows,
        candidates
    }), 'utf8');
    return { outputPath, selectedWindows, candidates };
}

function parseCliArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--srt') options.srtPath = argv[++index];
        else if (arg === '--xml') options.xmlPath = argv[++index];
        else if (arg === '--media') options.mediaPath = argv[++index];
        else if (arg === '--plan') options.planPath = argv[++index];
        else if (arg === '--output') options.outputPath = argv[++index];
        else if (arg === '--max-candidates') options.maxCandidates = Number(argv[++index]);
    }
    return options;
}

if (require.main === module) {
    try {
        const result = writeResidualReview(parseCliArgs(process.argv.slice(2)));
        console.log(`Residual review: ${result.outputPath}`);
        console.log(`Candidates: ${result.candidates.length}`);
    } catch (error) {
        console.error(error.message || error);
        process.exitCode = 1;
    }
}

module.exports = {
    DEFAULT_KEYWORDS,
    parseDanmakuXml,
    normalizeWindow,
    buildResidualCandidates,
    buildResidualReview,
    readSelectedWindows,
    writeResidualReview,
    parseCliArgs
};
