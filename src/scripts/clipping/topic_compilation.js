'use strict';

/**
 * Cross-recording keyword/topic compilation workflow.
 *
 * The workflow is intentionally split into evidence, planning, and media
 * stages:
 *   discover -> search -> plan -> build
 *
 * XML is evidence for where viewers reacted. SRT remains the source of the
 * streamer's words and the final subtitle timeline.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const topicClipper = require('../topic_clipper');
const ownStreamClipper = require('../own_stream_clipper');
const configLoader = require('../config-loader');
const { createClipResourceAdaptiveScheduler } = require('./resource_scheduler');

const MEDIA_EXTENSIONS = ['.flv', '.mp4', '.mkv', '.ts', '.mov'];
const SOURCE_SKIP_PARTS = new Set([
    'node_modules',
    'manual_requested_clips',
    'own_stream_fun_clips',
    'topic_clips',
    'tmp',
    'temp'
]);

const DEFAULT_PROFILES = {
    compact: {
        prePaddingSeconds: 0.6,
        postPaddingSeconds: 0.8,
        boundaryStartBacktrackSeconds: 2.5,
        boundaryEndExtensionSeconds: 8,
        boundarySilenceGapSeconds: 1.8,
        mergeGapSeconds: 1.5,
        minClipSeconds: 2.5,
        maxClipSeconds: 40,
        maxSourceSubtitleSeconds: 8,
        aliasContextSeconds: 8,
        aliasMinEvidence: 2,
        aliasMinDistinctSources: 1,
        maxAliases: 24,
        duplicateToleranceSeconds: 45,
        includeUnmatchedDanmakuGuided: false
    },
    balanced: {
        prePaddingSeconds: 3,
        postPaddingSeconds: 5,
        boundaryStartBacktrackSeconds: 6,
        boundaryEndExtensionSeconds: 15,
        boundarySilenceGapSeconds: 2.5,
        mergeGapSeconds: 5,
        minClipSeconds: 5,
        maxClipSeconds: 90,
        maxSourceSubtitleSeconds: 12,
        aliasContextSeconds: 10,
        aliasMinEvidence: 2,
        aliasMinDistinctSources: 1,
        maxAliases: 32,
        duplicateToleranceSeconds: 60,
        includeUnmatchedDanmakuGuided: false
    },
    full: {
        prePaddingSeconds: 8,
        postPaddingSeconds: 12,
        boundaryStartBacktrackSeconds: 12,
        boundaryEndExtensionSeconds: 30,
        boundarySilenceGapSeconds: 3,
        mergeGapSeconds: 12,
        minClipSeconds: 10,
        maxClipSeconds: 180,
        maxSourceSubtitleSeconds: 18,
        aliasContextSeconds: 12,
        aliasMinEvidence: 2,
        aliasMinDistinctSources: 1,
        maxAliases: 40,
        duplicateToleranceSeconds: 90,
        includeUnmatchedDanmakuGuided: false
    }
};

const CONTINUATION_PREFIXES = [
    '然后', '所以', '但是', '可是', '因为', '如果', '里面', '而且', '还有',
    '就是', '以及', '跟', '和', '把', '从', '到', '这', '那', '的'
];

const INCOMPLETE_ENDINGS = [
    '然后', '然后呢', '就是', '里面', '因为', '所以', '但是', '可是',
    '如果', '以及', '还有', '要不要', '要是', '在', '跟', '和', '把', '从', '到', '等'
];

const INCOMPLETE_SHORT_ENDINGS = [
    '我觉得', '我感觉', '我认为', '我想', '我猜', '我就', '你看', '你知道',
    '好像', '可能', '其实', '有点', '这个', '那个'
];

const ALIAS_STOPWORDS = new Set([
    '今天', '昨天', '现在', '刚刚', '这个', '那个', '这里', '那里', '什么', '怎么',
    '然后', '就是', '所以', '但是', '可是', '因为', '可以', '没有', '真的', '不是',
    '感觉', '知道', '看到', '觉得', '喜欢', '自己', '我们', '你们', '他们', '一个',
    '好像', '已经', '还是', '有点', '一下', '这样', '那种', '时候', '的话', '对吧'
]);

function ensureDir(directory) {
    fs.mkdirSync(directory, { recursive: true });
}

function writeJson(filePath, value) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
}

function sanitizeFileName(value) {
    return String(value || 'topic_compilation')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 120) || 'topic_compilation';
}

function normalizePath(value) {
    return String(value || '').replace(/\\/g, '/');
}

function resolvePath(value, baseDir = process.cwd()) {
    const text = String(value || '').trim();
    if (!text) return '';
    return path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)
        ? path.normalize(text)
        : path.resolve(baseDir, text);
}

function stableSourceId(value) {
    return `src-${crypto.createHash('sha1').update(normalizePath(value).toLowerCase()).digest('hex').slice(0, 12)}`;
}

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        command: 'compile',
        roots: [],
        keywords: [],
        danmakuKeywords: [],
        aliases: [],
        autoAliases: true,
        includeUnmatchedDanmakuGuided: false
    };
    let index = 0;
    if (argv[0] && !argv[0].startsWith('-')) {
        args.command = argv[0];
        index = 1;
    }

    const booleanFlags = new Set([
        'plan-only', 'no-auto-aliases', 'no-guided', 'include-guided', 'guided', 'allow-unverified-srt', 'keep-drafts', 'no-burn', 'help', 'h'
    ]);
    const repeatFlags = new Set(['root', 'keyword', 'danmaku-keyword', 'alias']);
    const keyMap = {
        'plan-only': 'planOnly',
        'no-auto-aliases': 'noAutoAliases',
        'no-guided': 'noGuided',
        'keep-drafts': 'keepDrafts',
        'no-burn': 'noBurn',
        'alias-min-evidence': 'aliasMinEvidence',
        'alias-min-sources': 'aliasMinDistinctSources',
        'alias-context': 'aliasContextSeconds',
        'max-aliases': 'maxAliases',
        'pre-pad': 'prePaddingSeconds',
        'post-pad': 'postPaddingSeconds',
        'start-backtrack': 'boundaryStartBacktrackSeconds',
        'end-extension': 'boundaryEndExtensionSeconds',
        'silence-gap': 'boundarySilenceGapSeconds',
        'merge-gap': 'mergeGapSeconds',
        'min-clip-seconds': 'minClipSeconds',
        'max-clip-seconds': 'maxClipSeconds',
        'duplicate-tolerance': 'duplicateToleranceSeconds',
        'max-chars-per-line': 'maxCharsPerLine',
        'batch-size': 'batchSize',
        'output-dir': 'outputDir',
        'work-dir': 'workDir',
        'ffmpeg': 'ffmpegPath',
        'overlay-font': 'overlayFont',
        'overlay-font-size': 'overlayFontSize'
    };

    while (index < argv.length) {
        const token = argv[index];
        if (!token.startsWith('--')) {
            index += 1;
            continue;
        }
        const rawKey = token.slice(2);
        const equalIndex = rawKey.indexOf('=');
        const flag = equalIndex >= 0 ? rawKey.slice(0, equalIndex) : rawKey;
        let value = equalIndex >= 0 ? rawKey.slice(equalIndex + 1) : null;
        if (value === null && !booleanFlags.has(flag)) {
            value = argv[index + 1];
            index += 1;
        }
        const key = keyMap[flag] || flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        if (repeatFlags.has(flag)) {
            const destination = flag === 'root' ? 'roots'
                : flag === 'keyword' ? 'keywords'
                    : flag === 'danmaku-keyword' ? 'danmakuKeywords' : 'aliases';
            if (value) args[destination].push(value);
        } else if (flag === 'no-auto-aliases') {
            args.autoAliases = false;
            args.noAutoAliases = true;
        } else if (flag === 'no-guided') {
            args.includeUnmatchedDanmakuGuided = false;
            args.noGuided = true;
        } else if (flag === 'include-guided' || flag === 'guided') {
            args.includeUnmatchedDanmakuGuided = true;
            args.includeGuided = true;
        } else if (flag === 'allow-unverified-srt') {
            args.allowUnverifiedSrt = true;
        } else if (flag === 'no-burn') {
            args.noBurn = true;
        } else if (booleanFlags.has(flag)) {
            args[key] = true;
        } else {
            args[key] = value;
        }
        index += 1;
    }
    return args;
}

function asNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveProfile(name = 'compact', overrides = {}) {
    const profileName = DEFAULT_PROFILES[name] ? name : 'compact';
    const profile = { ...DEFAULT_PROFILES[profileName] };
    Object.keys(profile).forEach(key => {
        if (overrides[key] !== undefined && overrides[key] !== null && overrides[key] !== '') {
            profile[key] = typeof profile[key] === 'number'
                ? asNumber(overrides[key], profile[key])
                : overrides[key];
        }
    });
    if (overrides.includeUnmatchedDanmakuGuided !== undefined) {
        profile.includeUnmatchedDanmakuGuided = Boolean(overrides.includeUnmatchedDanmakuGuided);
    }
    profile.aliasMinEvidence = Math.max(1, Math.floor(profile.aliasMinEvidence));
    profile.aliasMinDistinctSources = Math.max(1, Math.floor(profile.aliasMinDistinctSources));
    profile.maxAliases = Math.max(0, Math.floor(profile.maxAliases));
    return { name: profileName, ...profile };
}

function shouldSkipSourcePath(filePath) {
    return normalizePath(filePath)
        .split('/')
        .some(part => SOURCE_SKIP_PARTS.has(part.toLowerCase()));
}

function walkFiles(rootPath, output = []) {
    if (!rootPath || !fs.existsSync(rootPath)) return output;
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            if (!shouldSkipSourcePath(fullPath)) walkFiles(fullPath, output);
            continue;
        }
        output.push(fullPath);
    }
    return output;
}

function inferRecordedAt(filePath) {
    const value = normalizePath(filePath);
    let match = value.match(/(20\d{2})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})/);
    if (match) {
        return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
    }
    match = value.match(/(20\d{2})[_-](\d{2})[_-](\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]} 00:00:00`;
    return '';
}

function findCompanion(basePath, extensions) {
    if (!basePath) return '';
    const parsed = path.parse(basePath);
    for (const extension of extensions) {
        const candidate = path.join(parsed.dir, `${parsed.name}${extension}`);
        if (fs.existsSync(candidate)) return candidate;
    }
    return '';
}

function buildDiscoveredSource(srtPath, mediaPath, xmlPath, index) {
    const sourcePath = mediaPath || srtPath;
    return {
        id: stableSourceId(sourcePath || `${srtPath}:${index}`),
        sourceKey: normalizePath(sourcePath),
        mediaPath: mediaPath || null,
        originalSrtPath: srtPath,
        finalSrtPath: null,
        srtPath,
        xmlPath: xmlPath || null,
        recordedAt: inferRecordedAt(sourcePath),
        streamTitle: path.parse(sourcePath).name,
        priority: /_merged(?:\.|$)/i.test(path.basename(sourcePath)) ? 10 : 0,
        isMerged: /_merged(?:\.|$)/i.test(path.basename(sourcePath))
    };
}

function discoverSources(roots = []) {
    const seen = new Set();
    const sources = [];
    for (const rawRoot of roots) {
        const root = path.resolve(rawRoot);
        const files = walkFiles(root).filter(filePath => (
            path.extname(filePath).toLowerCase() === '.srt'
            && !/\.speaker\.srt$/i.test(filePath)
            && !shouldSkipSourcePath(filePath)
        ));
        for (const srtPath of files) {
            const key = normalizePath(srtPath).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            const mediaPath = findCompanion(srtPath, MEDIA_EXTENSIONS);
            const xmlPath = findCompanion(srtPath, ['.xml']);
            sources.push(buildDiscoveredSource(srtPath, mediaPath, xmlPath, sources.length));
        }
    }
    return sources.sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt))
        || a.sourceKey.localeCompare(b.sourceKey));
}

function normalizeSource(raw, baseDir, index) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const mediaPath = resolvePath(source.mediaPath || source.media || '', baseDir);
    const finalSrtPath = resolvePath(source.finalSrtPath || '', baseDir);
    const originalSrtPath = resolvePath(
        source.originalSrtPath || source.srtPath || source.srt || (mediaPath ? mediaPath.replace(/\.[^.]+$/i, '.srt') : ''),
        baseDir
    );
    const srtPath = finalSrtPath || originalSrtPath;
    const xmlPath = resolvePath(source.xmlPath || source.xml || (mediaPath ? mediaPath.replace(/\.[^.]+$/i, '.xml') : ''), baseDir);
    const sourceKey = String(source.sourceKey || mediaPath || srtPath || `source-${index}`).trim();
    return {
        ...source,
        id: String(source.id || stableSourceId(sourceKey)),
        sourceKey,
        mediaPath: mediaPath || null,
        originalSrtPath: originalSrtPath || null,
        finalSrtPath: finalSrtPath || null,
        srtPath: srtPath || null,
        xmlPath: xmlPath || null,
        recordedAt: String(source.recordedAt || inferRecordedAt(mediaPath || srtPath)).trim(),
        streamTitle: String(source.streamTitle || source.title || (mediaPath ? path.parse(mediaPath).name : '未知直播')).trim(),
        priority: asNumber(source.priority, /_merged(?:\.|$)/i.test(path.basename(mediaPath || '')) ? 10 : 0),
        isMerged: Boolean(source.isMerged || /_merged(?:\.|$)/i.test(path.basename(mediaPath || '')))
    };
}

function loadSourcesFromManifest(manifestPath) {
    const data = readJson(manifestPath);
    let rawSources = Array.isArray(data) ? data : (data.sources || data.recordings || []);
    if (!Array.isArray(rawSources) || rawSources.length === 0) {
        const legacySegments = Array.isArray(data.segments) ? data.segments : [];
        rawSources = legacySegments.map(segment => {
            const manifestSource = segment.sourceManifest || {};
            const mediaPath = manifestSource.mediaPath || segment.mediaPath || segment.source || '';
            const originalSrt = mediaPath ? mediaPath.replace(/\.[^.]+$/i, '.srt') : '';
            return {
                ...manifestSource,
                id: manifestSource.sourceKey || segment.id,
                mediaPath,
                // Legacy compilation manifests also contain a local rough-cut
                // SRT. XML timestamps belong to the original recording, so
                // prefer its same-stem SRT when it exists.
                srtPath: manifestSource.srtPath
                    || (originalSrt && fs.existsSync(originalSrt) ? originalSrt : '')
                    || segment.asrSrt,
                xmlPath: manifestSource.xmlPath || segment.xmlPath,
                recordedAt: manifestSource.recordedAt
                    || (mediaPath ? inferRecordedAt(mediaPath) : '')
                    || segment.eventDateTime,
                streamTitle: manifestSource.streamTitle || segment.streamTitle
            };
        });
    }
    if (!Array.isArray(rawSources)) throw new Error(`manifest.sources must be an array: ${manifestPath}`);
    return dedupeSources(rawSources.map((source, index) => normalizeSource(source, path.dirname(manifestPath), index)));
}

function printUsage() {
    console.log([
        '关键词/话题大合集切片',
        '',
        '命令:',
        '  discover --root <录播根目录> [--root <目录>] --output <sources.json>',
        '  search   --manifest <sources.json> --topic <关键词> --output <search.json>',
        '  plan     --search <search.json> --output <plan.json> [--profile compact|balanced|full]',
        '  build    --plan <plan.json> --output <compilation.mp4>',
        '  compile  --manifest <sources.json> --topic <关键词> --output <compilation.mp4>',
        '',
        '搜索参数:',
        '  --keyword <词>              增加 SRT 搜索词',
        '  --alias <词>                手动增加 ASR 别名',
        '  --danmaku-keyword <词>      增加 XML 弹幕搜索词',
        '  --no-auto-aliases           不从弹幕附近的 SRT 自动发现别名',
        '  --include-guided           将未被 SRT 关键词确认的弹幕附近窗口也纳入计划（默认关闭）',
        '  --allow-unverified-srt     build 时允许跳过 needsReAsr 阻断（仅人工确认后使用）',
        '',
        '边界参数:',
        '  --pre-pad/--post-pad <秒>   命中前后文',
        '  --end-extension <秒>        未完句子的最大补尾',
        '  --merge-gap <秒>            近邻命中合并阈值',
        '  --plan-only                 compile 只生成 search/plan，不切视频'
    ].join('\n'));
}

function resolveSources(args) {
    if (args.manifest) return loadSourcesFromManifest(path.resolve(args.manifest));
    if (args.roots.length) return discoverSources(args.roots);
    throw new Error('需要 --manifest 或至少一个 --root');
}

function dedupeSources(sources = []) {
    const byKey = new Map();
    for (const source of sources) {
        const key = normalizePath(source.sourceKey || source.mediaPath || source.srtPath).toLowerCase();
        if (!key) continue;
        const previous = byKey.get(key);
        if (!previous) {
            byKey.set(key, source);
            continue;
        }
        byKey.set(key, {
            ...previous,
            ...source,
            id: previous.id || source.id,
            priority: Math.max(Number(previous.priority || 0), Number(source.priority || 0)),
            isMerged: Boolean(previous.isMerged || source.isMerged),
            mediaPath: previous.mediaPath || source.mediaPath,
            originalSrtPath: previous.originalSrtPath || source.originalSrtPath,
            finalSrtPath: previous.finalSrtPath || source.finalSrtPath,
            srtPath: previous.srtPath || source.srtPath,
            xmlPath: previous.xmlPath || source.xmlPath,
            recordedAt: previous.recordedAt || source.recordedAt,
            streamTitle: previous.streamTitle || source.streamTitle
        });
    }
    return Array.from(byKey.values());
}

function normalizeTerm(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeSearchText(value) {
    return String(value || '').toLowerCase().replace(/[\s，。！？!?；;、,.：:“”‘’「」『』（）()【】\[\]…]+/g, '');
}

function isAsciiWordChar(value) {
    return Boolean(value && /[A-Za-z0-9_]/.test(value));
}

function containsTerm(text, term) {
    const haystack = String(text || '').toLowerCase();
    const needle = normalizeTerm(term).toLowerCase();
    if (!needle) return false;
    let offset = 0;
    while (offset <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, offset);
        if (index < 0) return false;
        const before = haystack[index - 1] || '';
        const after = haystack[index + needle.length] || '';
        if (!/^[A-Za-z0-9_]+$/.test(needle) || (!isAsciiWordChar(before) && !isAsciiWordChar(after))) {
            return true;
        }
        offset = index + 1;
    }
    return false;
}

function uniqueTerms(values = []) {
    const seen = new Set();
    return values.map(normalizeTerm).filter(value => {
        const key = normalizeSearchText(value);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function findSegmentMatches(segments, terms, kind = 'srt_keyword') {
    const normalizedTerms = uniqueTerms(terms);
    return segments.flatMap((segment, segmentIndex) => {
        const matchedTerms = normalizedTerms.filter(term => containsTerm(segment.text, term));
        return matchedTerms.length ? [{
            segmentIndex,
            start: Number(segment.start),
            end: Number(segment.end),
            text: String(segment.text || ''),
            matchedTerms,
            evidence: [kind]
        }] : [];
    });
}

function getOverlappingSegments(segments, start, end) {
    return segments.filter(segment => Number(segment.end) > start && Number(segment.start) < end);
}

function extractCjkRuns(text) {
    return String(text || '').match(/[\u3400-\u9fff]+/g) || [];
}

function extractCandidateTerms(text, topic) {
    const candidates = new Set();
    const topicChars = Array.from(normalizeSearchText(topic)).filter(char => /[\u3400-\u9fff]/.test(char));
    const targetLength = Math.max(2, topicChars.length || normalizeSearchText(topic).length || 2);
    const boundaryFillers = new Set([
        '的', '啊', '呀', '吗', '呢', '吧', '哦', '嗯', '种', '是',
        '跟', '和', '就', '她', '提', '所', '来', '点', '个', '从', '到'
    ]);
    const trimBoundaryFillers = value => {
        let result = String(value || '');
        while (result.length >= targetLength && boundaryFillers.has(result[0])) result = result.slice(1);
        while (result.length >= targetLength && boundaryFillers.has(result[result.length - 1])) result = result.slice(0, -1);
        return result;
    };
    for (const run of extractCjkRuns(text)) {
        for (let start = 0; start + targetLength <= run.length; start += 1) {
            candidates.add(trimBoundaryFillers(run.slice(start, start + targetLength)));
        }
        // Keep a short whole-run expression such as "冷恋冷恋萌", but do
        // not turn every long sentence into dozens of searchable n-grams.
        if (run.length > targetLength && run.length <= targetLength + 2) {
            candidates.add(trimBoundaryFillers(run));
        }
    }
    const latinWords = String(text || '').match(/[A-Za-z][A-Za-z0-9_-]{1,31}/g) || [];
    latinWords.forEach(word => candidates.add(word));
    return Array.from(candidates);
}

function topicCharOverlap(candidate, topic) {
    const candidateChars = new Set(Array.from(normalizeSearchText(candidate)));
    const topicChars = Array.from(new Set(Array.from(normalizeSearchText(topic)).filter(char => /[\u3400-\u9fffA-Za-z0-9]/.test(char))));
    if (!topicChars.length) return 0;
    return topicChars.filter(char => candidateChars.has(char)).length / topicChars.length;
}

function topicOrderedOverlap(candidate, topic) {
    const candidateChars = Array.from(normalizeSearchText(candidate));
    const topicChars = Array.from(new Set(Array.from(normalizeSearchText(topic)).filter(char => /[\u3400-\u9fffA-Za-z0-9]/.test(char))));
    const row = Array(topicChars.length + 1).fill(0);
    for (const candidateChar of candidateChars) {
        let diagonal = 0;
        for (let index = 1; index <= topicChars.length; index += 1) {
            const previous = row[index];
            row[index] = candidateChar === topicChars[index - 1]
                ? diagonal + 1
                : Math.max(row[index], row[index - 1]);
            diagonal = previous;
        }
    }
    return topicChars.length ? row[topicChars.length] / topicChars.length : 0;
}

function discoverAsrAliases(sourceResults, topic, excludedTerms, profile) {
    const excluded = new Set(uniqueTerms(excludedTerms).map(normalizeSearchText));
    const normalizedTopic = normalizeSearchText(topic);
    const topicLength = Array.from(normalizedTopic).length;
    const requiredOverlap = Math.min(1, Math.max(0.5, 2 / Math.max(1, topicLength)));
    const stats = new Map();
    for (const result of sourceResults) {
        for (const evidence of result.aliasEvidence || []) {
            for (const candidate of extractCandidateTerms(evidence.srtText, topic)) {
                const key = normalizeSearchText(candidate);
                if (!key || excluded.has(key) || ALIAS_STOPWORDS.has(key) || key.length < 2) continue;
                if (/^\d+$/.test(key)) continue;
                if (Array.from(key).length < topicLength) continue;
                if (normalizedTopic.includes(key) && key !== normalizedTopic) continue;
                const overlap = topicCharOverlap(candidate, topic);
                const orderedOverlap = topicOrderedOverlap(candidate, topic);
                const current = stats.get(key) || {
                    term: candidate,
                    evidenceIds: new Set(),
                    sourceIds: new Set(),
                    samples: [],
                    topicOverlap: overlap,
                    topicOrderedOverlap: orderedOverlap
                };
                current.evidenceIds.add(evidence.evidenceId);
                current.sourceIds.add(result.sourceId);
                current.topicOverlap = Math.max(current.topicOverlap, overlap);
                current.topicOrderedOverlap = Math.max(current.topicOrderedOverlap, orderedOverlap);
                if (current.samples.length < 4) current.samples.push({
                    sourceId: result.sourceId,
                    danmakuText: evidence.danmakuText,
                    srtText: evidence.srtText,
                    eventTime: evidence.eventTime
                });
                stats.set(key, current);
            }
        }
    }

    return Array.from(stats.values())
        .map(item => {
            const evidenceCount = item.evidenceIds.size;
            const sourceCount = item.sourceIds.size;
            const overlapEnough = item.topicOverlap >= requiredOverlap;
            const orderEnough = item.topicOrderedOverlap >= Math.min(1, 2 / Math.max(1, topicLength));
            const accepted = evidenceCount >= profile.aliasMinEvidence
                && sourceCount >= profile.aliasMinDistinctSources
                && overlapEnough
                && orderEnough;
            return {
                term: item.term,
                evidenceCount,
                sourceCount,
                topicOverlap: Number(item.topicOverlap.toFixed(3)),
                topicOrderedOverlap: Number(item.topicOrderedOverlap.toFixed(3)),
                accepted,
                samples: item.samples
            };
        })
        .filter(item => item.accepted)
        .sort((a, b) => b.evidenceCount - a.evidenceCount
            || b.sourceCount - a.sourceCount
            || b.topicOverlap - a.topicOverlap
            || a.term.localeCompare(b.term))
        .slice(0, profile.maxAliases);
}

function mergeSegmentMatches(matches = []) {
    const merged = new Map();
    for (const match of matches) {
        const key = String(match.segmentIndex);
        const previous = merged.get(key);
        if (!previous) {
            merged.set(key, {
                ...match,
                matchedTerms: [...(match.matchedTerms || [])],
                evidence: [...(match.evidence || [])],
                danmakuTexts: [...(match.danmakuTexts || [])]
            });
            continue;
        }
        previous.matchedTerms = uniqueTerms([...previous.matchedTerms, ...(match.matchedTerms || [])]);
        previous.evidence = Array.from(new Set([...previous.evidence, ...(match.evidence || [])]));
        previous.danmakuTexts = Array.from(new Set([...previous.danmakuTexts, ...(match.danmakuTexts || [])])).slice(0, 8);
    }
    return Array.from(merged.values()).sort((a, b) => a.segmentIndex - b.segmentIndex);
}

function chooseGuidedSegmentIndexes(segments, hit, profile) {
    const candidates = (hit.segmentIndexes || [])
        .map(index => ({ index, segment: segments[index] }))
        .filter(item => item.segment)
        .sort((a, b) => {
            const distanceA = Math.max(0, Number(a.segment.start) - hit.time, hit.time - Number(a.segment.end));
            const distanceB = Math.max(0, Number(b.segment.start) - hit.time, hit.time - Number(b.segment.end));
            return distanceA - distanceB;
        });
    if (!candidates.length) return [];
    const selected = [candidates[0].index];
    const anchor = candidates[0].index;
    for (const direction of [-1, 1]) {
        let cursor = anchor;
        while (selected.length < 3) {
            const nextIndex = cursor + direction;
            const next = segments[nextIndex];
            const current = segments[cursor];
            if (!next || !current) break;
            const gap = direction < 0
                ? Number(current.start) - Number(next.end)
                : Number(next.start) - Number(current.end);
            if (gap > profile.boundarySilenceGapSeconds
                || Number(next.start) < hit.time - profile.aliasContextSeconds
                || Number(next.end) > hit.time + profile.aliasContextSeconds) break;
            selected.push(nextIndex);
            cursor = nextIndex;
        }
    }
    return Array.from(new Set(selected)).sort((a, b) => a - b);
}

async function searchSource(source, topicTerms, danmakuTerms, profile, options = {}) {
    if (!source.srtPath || !fs.existsSync(source.srtPath)) {
        return { sourceId: source.id, error: `SRT not found: ${source.srtPath || '(empty)'}`, matches: [], aliasEvidence: [] };
    }
    const parsed = topicClipper.parseTopicSrt(source.srtPath);
    const segments = parsed.segments || [];
    const directMatches = findSegmentMatches(segments, topicTerms, 'srt_keyword');
    let danmakuRows = [];
    if (source.xmlPath && fs.existsSync(source.xmlPath)) {
        danmakuRows = await ownStreamClipper.parseDanmakuXml(source.xmlPath);
    }
    const danmakuHits = danmakuRows
        .filter(row => danmakuTerms.some(term => containsTerm(row.text, term)))
        .map((row, index) => {
            const nearby = getOverlappingSegments(
                segments,
                Math.max(0, row.time - profile.aliasContextSeconds),
                row.time + profile.aliasContextSeconds
            );
            return {
                index,
                time: row.time,
                text: row.text,
                segmentIndexes: nearby.map(segment => segments.indexOf(segment)),
                srtText: nearby.map(segment => String(segment.text || '')).join('')
            };
        });

    const aliasEvidence = danmakuHits.flatMap(hit => hit.segmentIndexes.length ? [{
        evidenceId: `${source.id}:${hit.index}`,
        eventTime: hit.time,
        danmakuText: hit.text,
        srtText: hit.srtText
    }] : []);

    return {
        sourceId: source.id,
        srtPath: source.srtPath,
        originalSrtPath: source.originalSrtPath || null,
        finalSrtPath: source.finalSrtPath || null,
        segmentCount: segments.length,
        directMatches,
        danmakuHits,
        aliasEvidence,
        segments
    };
}

function applyAliasAndGuidedMatches(result, source, topicTerms, aliasTerms, profile) {
    const segments = result.segments || [];
    const aliasMatches = findSegmentMatches(segments, aliasTerms, 'srt_alias');
    const matches = mergeSegmentMatches([
        ...result.directMatches,
        ...aliasMatches.map(match => ({ ...match, matchedTerms: match.matchedTerms.map(term => term) }))
    ]);
    const byIndex = new Map(matches.map(match => [match.segmentIndex, match]));
    const unresolvedDanmakuHits = [];
    for (const hit of result.danmakuHits || []) {
        const directOrAliasIndexes = (hit.segmentIndexes || []).filter(segmentIndex => byIndex.has(segmentIndex));
        if (!directOrAliasIndexes.length && profile.includeUnmatchedDanmakuGuided === false) {
            unresolvedDanmakuHits.push(hit);
            continue;
        }
        const guidedIndexes = directOrAliasIndexes.length
            ? directOrAliasIndexes
            : chooseGuidedSegmentIndexes(segments, hit, profile);
        for (const segmentIndex of guidedIndexes) {
            const segment = segments[segmentIndex];
            if (!segment) continue;
            const found = byIndex.get(segmentIndex);
            if (found) {
                found.evidence = Array.from(new Set([...found.evidence, 'danmaku_confirmed']));
                found.danmakuTexts = Array.from(new Set([...(found.danmakuTexts || []), hit.text])).slice(0, 8);
                continue;
            }
            const hasAliasEvidence = aliasTerms.some(term => containsTerm(segment.text, term));
            if (!profile.includeUnmatchedDanmakuGuided || (!hasAliasEvidence && !optionsIncludeGuided(profile))) continue;
            byIndex.set(segmentIndex, {
                segmentIndex,
                start: Number(segment.start),
                end: Number(segment.end),
                text: String(segment.text || ''),
                matchedTerms: hasAliasEvidence ? aliasTerms.filter(term => containsTerm(segment.text, term)) : [],
                evidence: ['danmaku_guided'],
                danmakuTexts: [hit.text]
            });
        }
    }
    return {
        sourceId: source.id,
        srtPath: source.srtPath,
        originalSrtPath: source.originalSrtPath || null,
        finalSrtPath: source.finalSrtPath || null,
        segmentCount: result.segmentCount,
        matches: Array.from(byIndex.values()).sort((a, b) => a.segmentIndex - b.segmentIndex),
        danmakuHits: result.danmakuHits,
        unresolvedDanmakuHits,
        aliasEvidence: result.aliasEvidence
    };
}

function optionsIncludeGuided(profile) {
    return profile.includeUnmatchedDanmakuGuided !== false;
}

async function searchTopic(sources, topic, args = {}) {
    const profile = resolveProfile(args.profile || 'compact', args);
    const primaryTerms = uniqueTerms([topic, ...(args.keywords || []), ...(args.aliases || [])]);
    const danmakuTerms = uniqueTerms([topic, ...(args.danmakuKeywords || []), ...(args.keywords || [])]);
    const firstPass = await Promise.all(sources.map(source => searchSource(
        source,
        primaryTerms,
        danmakuTerms,
        profile,
        args
    )));
    const discoveredAliases = args.autoAliases === false || args.noAutoAliases
        ? []
        : discoverAsrAliases(firstPass, topic, primaryTerms, profile);
    const autoAliasTerms = discoveredAliases.map(item => item.term);
    const searchableTerms = uniqueTerms([...primaryTerms, ...autoAliasTerms]);
    const sourceResults = firstPass.map((result, index) => applyAliasAndGuidedMatches(
        result,
        sources[index],
        primaryTerms,
        autoAliasTerms,
        {
            ...profile,
            includeUnmatchedDanmakuGuided: args.includeUnmatchedDanmakuGuided === true
                || profile.includeUnmatchedDanmakuGuided === true
        }
    ));
    return {
        version: 1,
        generatedAt: new Date().toISOString(),
        topic,
        searchTerms: {
            primary: primaryTerms,
            danmaku: danmakuTerms,
            autoAliases: discoveredAliases
        },
        searchableTerms,
        profile,
        sources,
        sourceResults,
        summary: {
            sourceCount: sources.length,
            sourcesWithMatches: sourceResults.filter(result => result.matches.length > 0).length,
            matchCount: sourceResults.reduce((sum, result) => sum + result.matches.length, 0),
            danmakuHitCount: sourceResults.reduce((sum, result) => sum + result.danmakuHits.length, 0),
            unresolvedDanmakuHitCount: sourceResults.reduce((sum, result) => sum + result.unresolvedDanmakuHits.length, 0),
            aliasCount: discoveredAliases.length
        }
    };
}

function parseDateMs(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const normalized = text.replace(/\//g, '-').replace(' ', 'T');
    const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}+08:00`;
    const timestamp = Date.parse(withZone);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function formatBeijingDateTime(timestamp) {
    if (!Number.isFinite(timestamp)) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function isLikelyIncompleteSubtitle(text) {
    const normalized = String(text || '').replace(/\s+/g, '').trim();
    if (!normalized) return true;
    if (INCOMPLETE_ENDINGS.some(ending => normalized.endsWith(ending))) return true;
    if (/[。！？!?；;…]$/.test(normalized)) return false;
    if (/[吗呢呀吧呗哦喔啊啦嘛]$/.test(normalized)) return false;
    return normalized.length <= 8
        && INCOMPLETE_SHORT_ENDINGS.some(ending => normalized.endsWith(ending));
}

function startsWithContinuation(text) {
    const normalized = String(text || '').replace(/\s+/g, '').trim();
    return CONTINUATION_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function mergeWindow(window, match) {
    window.end = Math.max(window.end, match.end);
    window.matchIndexes.push(match.segmentIndex);
    window.matchedTerms = uniqueTerms([...window.matchedTerms, ...(match.matchedTerms || [])]);
    window.evidence = Array.from(new Set([...window.evidence, ...(match.evidence || [])]));
    window.danmakuTexts = Array.from(new Set([...window.danmakuTexts, ...(match.danmakuTexts || [])])).slice(0, 8);
}

function alignWindowToSentence(rawWindow, segments, profile) {
    const contentStart = rawWindow.matchStart;
    const contentEnd = rawWindow.matchEnd;
    let start = Math.max(0, rawWindow.start);
    let end = Math.max(rawWindow.end, contentEnd);
    const overlapping = getOverlappingSegments(segments, start, end);
    if (!overlapping.length) return { ...rawWindow, start, end };

    const first = overlapping[0];
    if (Number(first.start) < start && start - Number(first.start) <= profile.boundaryStartBacktrackSeconds) {
        start = Number(first.start);
    }
    const contentSegments = getOverlappingSegments(
        segments,
        Math.max(0, contentStart - profile.boundaryStartBacktrackSeconds),
        Math.min(end, contentEnd + profile.postPaddingSeconds)
    );
    let tail = contentSegments[contentSegments.length - 1] || overlapping[overlapping.length - 1];
    end = Math.max(end, Number(tail.end));
    const maxEnd = contentEnd + profile.postPaddingSeconds + profile.boundaryEndExtensionSeconds;
    let tailIndex = segments.indexOf(tail);
    while (tailIndex >= 0 && tailIndex + 1 < segments.length) {
        const next = segments[tailIndex + 1];
        const gap = Math.max(0, Number(next.start) - Number(tail.end));
        const needsCompletion = isLikelyIncompleteSubtitle(tail.text)
            || (startsWithContinuation(next.text) && gap <= profile.boundarySilenceGapSeconds);
        if (!needsCompletion || Number(next.end) > maxEnd + 0.25) break;
        if (gap > profile.boundarySilenceGapSeconds && !isLikelyIncompleteSubtitle(tail.text)) break;
        tail = next;
        tailIndex += 1;
        end = Math.max(end, Number(tail.end));
    }
    end = Math.min(end, contentEnd + profile.postPaddingSeconds + profile.boundaryEndExtensionSeconds);
    if (end < Number(tail.end)) end = Number(tail.end);
    return {
        ...rawWindow,
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        duration: Number((end - start).toFixed(3)),
        boundaryAdjusted: start !== rawWindow.start || end !== rawWindow.end
    };
}

function buildSourceWindows(source, segments, matches, profile) {
    if (!matches.length) return [];
    const sorted = [...matches].sort((a, b) => Number(a.start) - Number(b.start));
    const rawWindows = [];
    for (const match of sorted) {
        const start = Math.max(0, Number(match.start) - profile.prePaddingSeconds);
        const end = Number(match.end) + profile.postPaddingSeconds;
        const last = rawWindows[rawWindows.length - 1];
        const combinedEnd = Math.max(last?.end || 0, end);
        if (last && start <= last.end + profile.mergeGapSeconds
            && combinedEnd - last.start <= profile.maxClipSeconds) {
            mergeWindow(last, match);
            last.matchEnd = Math.max(last.matchEnd, Number(match.end));
            continue;
        }
        rawWindows.push({
            sourceId: source.id,
            start,
            end,
            duration: end - start,
            matchStart: Number(match.start),
            matchEnd: Number(match.end),
            matchIndexes: [match.segmentIndex],
            matchedTerms: [...(match.matchedTerms || [])],
            evidence: [...(match.evidence || [])],
            danmakuTexts: [...(match.danmakuTexts || [])]
        });
    }

    return rawWindows.map(raw => {
        const aligned = alignWindowToSentence(raw, segments, profile);
        const windowSegments = getOverlappingSegments(segments, aligned.start, aligned.end);
        const longSubtitleSegments = windowSegments.filter(segment => (
            Number(segment.end) - Number(segment.start) > profile.maxSourceSubtitleSeconds
        ));
        const preview = getOverlappingSegments(segments, aligned.start, aligned.end)
            .map(segment => String(segment.text || '').trim())
            .filter(Boolean)
            .join(' ');
        const startMs = parseDateMs(source.recordedAt);
        const absoluteStart = Number.isFinite(startMs) ? startMs + aligned.start * 1000 : null;
        const absoluteEnd = Number.isFinite(startMs) ? startMs + aligned.end * 1000 : null;
        return {
            sourceId: source.id,
            mediaPath: source.mediaPath,
            originalSrtPath: source.originalSrtPath || null,
            finalSrtPath: source.finalSrtPath || null,
            srtPath: source.srtPath,
            xmlPath: source.xmlPath,
            recordedAt: source.recordedAt || null,
            streamTitle: source.streamTitle || '',
            start: aligned.start,
            end: aligned.end,
            duration: aligned.duration,
            rawStart: Number(raw.start.toFixed(3)),
            rawEnd: Number(raw.end.toFixed(3)),
            matchedTerms: uniqueTerms(raw.matchedTerms),
            evidence: Array.from(new Set(raw.evidence)),
            danmakuTexts: raw.danmakuTexts,
            subtitlePreview: preview,
            absoluteStart,
            absoluteEnd,
            eventDateTime: Number.isFinite(absoluteStart) ? formatBeijingDateTime(absoluteStart) : source.recordedAt || '',
            boundaryAdjusted: Boolean(aligned.boundaryAdjusted),
            needsReAsr: longSubtitleSegments.length > 0,
            reAsrReason: longSubtitleSegments.length > 0
                ? `窗口内字幕块最长 ${Math.max(...longSubtitleSegments.map(segment => Number(segment.end) - Number(segment.start))).toFixed(1)} 秒，可能包含未切开的前后话题`
                : null,
            matchIndexes: Array.from(new Set(raw.matchIndexes)).sort((a, b) => a - b)
        };
    }).filter(window => window.end > window.start && window.duration >= profile.minClipSeconds);
}

function candidateQuality(candidate, source) {
    return Number(source.priority || 0) * 100
        + (source.isMerged ? 25 : 0)
        + (source.mediaPath && fs.existsSync(source.mediaPath) ? 5 : 0)
        + (candidate.evidence.includes('srt_keyword') ? 3 : 0)
        + Math.min(5, candidate.duration / 10);
}

function intervalsOverlap(first, second, toleranceSeconds) {
    if (!Number.isFinite(first.absoluteStart) || !Number.isFinite(second.absoluteStart)) return false;
    return first.absoluteStart <= second.absoluteEnd + toleranceSeconds * 1000
        && second.absoluteStart <= first.absoluteEnd + toleranceSeconds * 1000;
}

function dedupeCrossSourceWindows(windows, sourceMap, profile) {
    const kept = [];
    const removed = [];
    const sorted = [...windows].sort((a, b) => (
        (Number.isFinite(a.absoluteStart) ? a.absoluteStart : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(b.absoluteStart) ? b.absoluteStart : Number.MAX_SAFE_INTEGER)
        || a.start - b.start
    ));
    for (const candidate of sorted) {
        const source = sourceMap.get(candidate.sourceId) || {};
        const duplicateIndex = kept.findIndex(existing => (
            existing.sourceId !== candidate.sourceId
            && intervalsOverlap(existing, candidate, profile.duplicateToleranceSeconds)
        ));
        if (duplicateIndex < 0) {
            kept.push(candidate);
            continue;
        }
        const existing = kept[duplicateIndex];
        const existingSource = sourceMap.get(existing.sourceId) || {};
        if (candidateQuality(candidate, source) > candidateQuality(existing, existingSource)) {
            removed.push({ ...existing, duplicateOf: candidate.sourceId });
            kept[duplicateIndex] = candidate;
        } else {
            removed.push({ ...candidate, duplicateOf: existing.sourceId });
        }
    }
    kept.sort((a, b) => (
        (Number.isFinite(a.absoluteStart) ? a.absoluteStart : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(b.absoluteStart) ? b.absoluteStart : Number.MAX_SAFE_INTEGER)
        || a.start - b.start
    ));
    return { kept, removed };
}

function buildPlan(searchData, args = {}) {
    const profile = resolveProfile(args.profile || searchData.profile?.name || 'compact', {
        ...(searchData.profile || {}),
        ...args
    });
    const sources = (searchData.sources || []).map((source, index) => normalizeSource(source, process.cwd(), index));
    const sourceMap = new Map(sources.map(source => [source.id, source]));
    const windows = [];
    for (const result of searchData.sourceResults || []) {
        const source = sourceMap.get(result.sourceId);
        if (!source || !result.matches?.length || !source.srtPath || !fs.existsSync(source.srtPath)) continue;
        const parsed = topicClipper.parseTopicSrt(source.srtPath);
        const matches = result.matches
            .map(match => {
                const segment = parsed.segments[match.segmentIndex];
                if (!segment) return null;
                return {
                    ...match,
                    start: Number(segment.start),
                    end: Number(segment.end),
                    text: String(segment.text || '')
                };
            })
            .filter(Boolean);
        windows.push(...buildSourceWindows(source, parsed.segments, matches, profile));
    }
    const deduped = dedupeCrossSourceWindows(windows, sourceMap, profile);
    const clips = deduped.kept.map((clip, index) => ({
        ...clip,
        sequence: index + 1,
        id: `topic-${String(index + 1).padStart(3, '0')}`
    }));
    return {
        version: 1,
        generatedAt: new Date().toISOString(),
        topic: searchData.topic,
        profile,
        searchPath: searchData.searchPath || null,
        searchTerms: searchData.searchTerms,
        sources,
        clips,
        removedDuplicates: deduped.removed.map(item => ({
            sourceId: item.sourceId,
            start: item.start,
            end: item.end,
            duplicateOf: item.duplicateOf,
            subtitlePreview: item.subtitlePreview
        })),
        summary: {
            candidateCount: windows.length,
            clipCount: clips.length,
            removedDuplicateCount: deduped.removed.length,
            needsReAsrCount: clips.filter(clip => clip.needsReAsr).length,
            totalPlannedDuration: Number(clips.reduce((sum, clip) => sum + clip.duration, 0).toFixed(3))
        }
    };
}

function probeDuration(mediaPath, ffprobePath = 'ffprobe') {
    const result = childProcess.spawnSync(
        ffprobePath,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mediaPath],
        { encoding: 'utf8', windowsHide: true, shell: false }
    );
    if (result.status !== 0) throw new Error(`ffprobe failed for ${mediaPath}: ${result.stderr || ''}`);
    const duration = Number(String(result.stdout || '').trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`invalid duration for ${mediaPath}`);
    return duration;
}

function formatSrtTime(seconds) {
    const millis = Math.max(0, Math.round(Number(seconds || 0) * 1000));
    const ms = millis % 1000;
    const totalSeconds = Math.floor(millis / 1000);
    const s = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const m = totalMinutes % 60;
    const h = Math.floor(totalMinutes / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function writeCompilationSrt(parts, outputPath, options = {}) {
    const parseSrt = options.parseSrt || topicClipper.parseTopicSrt;
    const lines = [];
    let offset = 0;
    let index = 1;
    for (const part of parts) {
        const parsed = parseSrt(part.srtPath);
        for (const segment of parsed.segments || []) {
            const start = Number(segment.start);
            const end = Number(segment.end);
            if (!(end > start)) continue;
            lines.push(String(index++));
            lines.push(`${formatSrtTime(offset + start)} --> ${formatSrtTime(offset + end)}`);
            lines.push(String(segment.text || '').trim());
            lines.push('');
        }
        offset += part.actualDuration;
    }
    fs.writeFileSync(outputPath, `${lines.join('\n').trim()}\n`, 'utf8');
    return { duration: offset, segmentCount: index - 1 };
}

function escapeFilterValue(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/:/g, '\\:')
        .replace(/,/g, '\\,')
        .replace(/%/g, '\\%');
}

function formatOverlayLabel(clip = {}, options = {}) {
    const template = String(options.overlayTemplate || '第{sequence}次   {eventDateTime}');
    return template
        .replace(/\{sequence\}/g, String(clip.sequence ?? ''))
        .replace(/\{eventDateTime\}/g, String(clip.eventDateTime || '未知时间'))
        .replace(/\{id\}/g, String(clip.id || ''));
}

function buildOverlayArgs(batch, outputPath, mediaConfig, options = {}) {
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    batch.forEach(part => args.push('-i', part.burnedPath));
    const filters = [];
    const concatInputs = [];
    const fontFile = escapeFilterValue(options.overlayFont || 'C:/Windows/Fonts/msyh.ttc');
    const fontSize = Math.max(12, Number(options.overlayFontSize || 34));
    for (let index = 0; index < batch.length; index += 1) {
        const part = batch[index];
        const overlayText = escapeFilterValue(formatOverlayLabel(part.clip, options));
        filters.push(
            `[${index}:v]setpts=PTS-STARTPTS,drawtext=`
            + `fontfile='${fontFile}':text='${overlayText}':`
            + `x=w-tw-32:y=24:fontsize=${fontSize}:fontcolor=white@0.95:`
            + 'box=1:boxcolor=black@0.62:boxborderw=10:'
            + 'borderw=2:bordercolor=black@0.78:shadowx=2:shadowy=2:shadowcolor=black@0.65'
            + `[v${index}]`
        );
        filters.push(`[${index}:a]asetpts=PTS-STARTPTS[a${index}]`);
        concatInputs.push(`[v${index}][a${index}]`);
    }
    filters.push(`${concatInputs.join('')}concat=n=${batch.length}:v=1:a=1[outv][outa]`);
    const encoder = String(mediaConfig.subtitleVideoEncoder || 'h264_nvenc');
    const isNvenc = /nvenc/i.test(encoder);
    args.push(
        '-filter_complex', filters.join(';'),
        '-map', '[outv]', '-map', '[outa]',
        '-c:v', encoder,
        '-preset', String(mediaConfig.subtitleVideoPreset || (isNvenc ? 'p4' : 'veryfast')),
        isNvenc ? '-cq' : '-crf', String(isNvenc ? (mediaConfig.subtitleVideoCq ?? 23) : (mediaConfig.subtitleVideoCrf ?? 18)),
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart', outputPath, '-nostdin'
    );
    return args;
}

async function overlayBatch(batch, outputPath, mediaConfig, options = {}) {
    const runFfmpeg = options.runFfmpeg || topicClipper.runFfmpeg;
    try {
        await runFfmpeg(buildOverlayArgs(batch, outputPath, mediaConfig, options), {
            ffmpegPath: options.ffmpegPath || 'ffmpeg',
            threads: options.ffmpegThreads,
            timeoutMs: options.ffmpegTimeoutMs || 1200000,
            stage: `topic compilation overlay batch ${batch[0].clip.sequence}`
        });
    } catch (error) {
        if (!/nvenc/i.test(String(mediaConfig.subtitleVideoEncoder || ''))) throw error;
        const fallbackConfig = {
            ...mediaConfig,
            subtitleVideoEncoder: 'libx264',
            subtitleVideoPreset: 'veryfast',
            subtitleVideoCrf: 18
        };
        console.warn(`NVENC 合集计数烧录失败，回退 libx264: ${error.message}`);
        await runFfmpeg(buildOverlayArgs(batch, outputPath, fallbackConfig, options), {
            ffmpegPath: options.ffmpegPath || 'ffmpeg',
            threads: options.ffmpegThreads,
            timeoutMs: options.ffmpegTimeoutMs || 1200000,
            stage: `topic compilation overlay fallback batch ${batch[0].clip.sequence}`
        });
    }
}

async function concatBatches(batchFiles, outputPath, listPath, options = {}) {
    const runFfmpeg = options.runFfmpeg || topicClipper.runFfmpeg;
    fs.writeFileSync(
        listPath,
        `${batchFiles.map(file => `file '${normalizePath(file).replace(/'/g, "'\\''")}'`).join('\n')}\n`,
        'utf8'
    );
    await runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c', 'copy', '-movflags', '+faststart', outputPath, '-nostdin'
    ], {
        ffmpegPath: options.ffmpegPath || 'ffmpeg',
        threads: options.ffmpegThreads,
        timeoutMs: options.ffmpegTimeoutMs || 1200000,
        stage: 'topic compilation concat'
    });
}

function writeReview(plan, outputPath, mediaPath, srtPath, manifestPath, options = {}) {
    const lines = [
        `# ${options.reviewTitle || `${plan.topic} 大合集审核记录`}`,
        '',
        `- 成片：${mediaPath}`,
        `- 字幕：${srtPath}`,
        `- manifest：${manifestPath}`,
        `- 片段数：${plan.clips.length}`,
        `- 计划总时长：${plan.summary.totalPlannedDuration.toFixed(3)} 秒`,
        `- 需重新 ASR：${plan.summary.needsReAsrCount || 0} 段`,
        '- 字幕：按最终窗口重新生成，默认去标点并使用标准大字幕流程',
        '- 边界：命中窗口先合并重叠/近邻片段，再按字幕分段补齐未说完的句子',
        '',
        '| 序号 | 日期时间 | 时长 | 命中词 | 证据 | 字幕摘要 |',
        '|---:|---|---:|---|---|---|'
    ];
    for (const clip of plan.clips) {
        const reviewNote = clip.needsReAsr ? `需重 ASR：${clip.reAsrReason}` : '';
        const summaryCell = String(reviewNote || clip.subtitlePreview || '').replace(/\|/g, '/');
        lines.push(`| ${clip.sequence} | ${clip.eventDateTime || '未知'} | ${clip.duration.toFixed(2)}s | ${(clip.matchedTerms || []).join('、') || '弹幕引导'} | ${(clip.evidence || []).join('+')} | ${summaryCell} |`);
    }
    if (plan.removedDuplicates?.length) {
        lines.push('', `去重：删除 ${plan.removedDuplicates.length} 个跨录播重复窗口。`);
    }
    fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function buildDefaultCompilationMediaConfig(rootConfig = {}, args = {}) {
    const ownConfig = ownStreamClipper.getOwnStreamClipsConfig(rootConfig.ownStreamClips || {});
    return {
        ...ownStreamClipper.buildCutClipMediaConfig(ownConfig, { ffmpegPath: args.ffmpegPath || 'ffmpeg' }),
        burnSubtitles: args.noBurn ? false : true,
        preserveCoverSource: false,
        subtitleMaxCharsPerLine: asNumber(
            args.maxCharsPerLine,
            rootConfig.subtitle?.max_chars_per_line ?? ownConfig.subtitleMaxCharsPerLine ?? 18
        ),
        ffmpegTimeoutMs: 1200000
    };
}

function resolveCompilationMediaAdapter(options = {}) {
    const rootConfig = options.rootConfig || {};
    const args = options.args || {};
    const clipper = options.clipper || topicClipper;
    const ownConfig = options.ownConfig
        || ownStreamClipper.getOwnStreamClipsConfig(rootConfig.ownStreamClips || {});
    return {
        ownConfig,
        parseSrt: options.parseSrt || clipper.parseTopicSrt,
        writeSrt: options.writeSrt || clipper.writeClipSrt,
        cutMedia: options.cutMedia || clipper.cutClipMedia,
        cleanupTemporaryCoverSource: options.cleanupTemporaryCoverSource
            || clipper.cleanupTemporaryCoverSource
            || (() => {}),
        runFfmpeg: options.runFfmpeg || clipper.runFfmpeg,
        buildMediaConfig: options.buildMediaConfig
            || (() => buildDefaultCompilationMediaConfig(rootConfig, args)),
        createScheduler: options.createScheduler
            || ((schedulerOptions) => createClipResourceAdaptiveScheduler(schedulerOptions))
    };
}

async function buildCompilation(plan, outputPath, args = {}) {
    if (!plan || !Array.isArray(plan.clips) || plan.clips.length === 0) {
        throw new Error('计划没有可编译片段，请先检查 search/plan 输出');
    }
    const resolvedOutput = path.resolve(outputPath);
    const outputDir = path.dirname(resolvedOutput);
    const stem = path.basename(resolvedOutput, path.extname(resolvedOutput));
    const workDir = path.resolve(args.workDir || path.join(process.cwd(), 'tmp', `${sanitizeFileName(stem)}_work`));
    const partDir = path.join(workDir, 'parts');
    const batchDir = path.join(workDir, 'batches');
    ensureDir(outputDir);
    ensureDir(partDir);
    ensureDir(batchDir);

    const blockedClips = (plan.clips || []).filter(clip => {
        const source = plan.sources.find(item => item.id === clip.sourceId);
        return clip.needsReAsr && !source?.finalSrtPath;
    });
    if (blockedClips.length && !args.allowUnverifiedSrt) {
        const ids = blockedClips.map(clip => `${clip.id}(${clip.reAsrReason})`).join('; ');
        throw new Error(`计划包含未经重新 ASR 的长字幕窗口: ${ids}。请在源清单填写 finalSrtPath，或明确使用 --allow-unverified-srt。`);
    }

    const rootConfig = args.rootConfig || configLoader.getConfig();
    const mediaAdapter = resolveCompilationMediaAdapter({
        rootConfig,
        args,
        ...(args.mediaAdapter || {})
    });
    const baseMediaConfig = args.mediaConfig || mediaAdapter.buildMediaConfig(rootConfig, args);
    const scheduler = args.scheduler || mediaAdapter.createScheduler({
        ownConfig: mediaAdapter.ownConfig,
        rootConfig
    });
    const sourceSrtCache = new Map();
    const parts = [];
    for (const clip of plan.clips) {
        const source = plan.sources.find(item => item.id === clip.sourceId);
        if (!source) throw new Error(`source missing for ${clip.id}: ${clip.sourceId}`);
        if (!source.mediaPath || !fs.existsSync(source.mediaPath)) throw new Error(`media not found: ${source.mediaPath}`);
        const subtitleSourcePath = source.finalSrtPath || source.srtPath;
        if (!subtitleSourcePath || !fs.existsSync(subtitleSourcePath)) throw new Error(`SRT not found: ${subtitleSourcePath}`);
        let parsed = sourceSrtCache.get(subtitleSourcePath);
        if (!parsed) {
            parsed = mediaAdapter.parseSrt(subtitleSourcePath);
            sourceSrtCache.set(subtitleSourcePath, parsed);
        }
        const partStem = `part-${String(clip.sequence).padStart(3, '0')}`;
        const partSrtPath = path.join(partDir, `${partStem}.srt`);
        const partVideoPath = path.join(partDir, `${partStem}.mp4`);
        const window = { start: clip.start, end: clip.end, duration: clip.end - clip.start };
        const srtResult = mediaAdapter.writeSrt(parsed.segments, window, partSrtPath, {
            maxCharsPerLine: baseMediaConfig.subtitleMaxCharsPerLine,
            stripPunctuation: true
        });
        const lease = scheduler.enabled ? await scheduler.acquire() : null;
        const profile = lease?.profile || scheduler.getProfile();
        let mediaResult;
        try {
            mediaResult = await mediaAdapter.cutMedia(
                { kind: 'video', mediaPath: source.mediaPath },
                window,
                partSrtPath,
                partVideoPath,
                { ...baseMediaConfig, ffmpegThreads: profile.ffmpegThreads }
            );
        } finally {
            lease?.release();
            if (mediaResult) mediaAdapter.cleanupTemporaryCoverSource(mediaResult);
        }
        const actualDuration = probeDuration(partVideoPath, args.ffprobePath || 'ffprobe');
        parts.push({
            clip,
            srtPath: partSrtPath,
            sourceSrtPath: subtitleSourcePath,
            burnedPath: partVideoPath,
            actualDuration,
            subtitleSegmentCount: srtResult.segmentCount
        });
        console.log(`${clip.sequence}. ${clip.eventDateTime || '未知时间'} ${actualDuration.toFixed(3)}s`);
    }

    const batchFiles = [];
    const batchSize = Math.max(1, Math.floor(asNumber(args.batchSize, 8)));
    for (let offset = 0; offset < parts.length; offset += batchSize) {
        const batch = parts.slice(offset, offset + batchSize);
        const batchPath = path.join(batchDir, `batch-${String(batch[0].clip.sequence).padStart(3, '0')}.mp4`);
        const profile = scheduler.getProfile();
        await overlayBatch(batch, batchPath, baseMediaConfig, {
            ffmpegPath: args.ffmpegPath || 'ffmpeg',
            ffmpegThreads: profile.ffmpegThreads,
            ffmpegTimeoutMs: 1200000,
            overlayFont: args.overlayFont,
            overlayFontSize: args.overlayFontSize,
            overlayTemplate: args.overlayTemplate,
            runFfmpeg: mediaAdapter.runFfmpeg
        });
        batchFiles.push(batchPath);
    }

    const listPath = path.join(workDir, 'batches.concat.txt');
    await concatBatches(batchFiles, resolvedOutput, listPath, {
        ffmpegPath: args.ffmpegPath || 'ffmpeg',
        ffmpegThreads: scheduler.getProfile().ffmpegThreads,
        ffmpegTimeoutMs: 1200000,
        runFfmpeg: mediaAdapter.runFfmpeg
    });
    const outputSrt = path.join(outputDir, `${stem}.srt`);
    const outputManifest = path.join(outputDir, `${stem}.manifest.json`);
    const outputReview = path.join(outputDir, `${stem}_REVIEW.md`);
    const subtitleResult = writeCompilationSrt(parts, outputSrt, {
        parseSrt: mediaAdapter.parseSrt
    });
    const manifest = {
        version: 1,
        topic: plan.topic,
        method: args.method || 'topic_compilation_search_alias_guided_boundary_dedupe_standard_burn',
        planPath: args.planPath || null,
        outputVideo: resolvedOutput,
        outputSrt,
        outputReview,
        actualDuration: Number(probeDuration(resolvedOutput, args.ffprobePath || 'ffprobe').toFixed(3)),
        segmentCount: parts.length,
        subtitle: {
            source: 'final source SRT per selected recording window',
            maxCharsPerLine: baseMediaConfig.subtitleMaxCharsPerLine,
            stripPunctuation: true
        },
        overlay: {
            position: 'top-right',
            format: args.overlayTemplate || '第{sequence}次   {eventDateTime}',
            fontSize: Number(args.overlayFontSize || 34)
        },
        profile: plan.profile,
        segments: parts.map(part => ({
            sequence: part.clip.sequence,
            id: part.clip.id,
            sourceId: part.clip.sourceId,
            mediaPath: part.clip.mediaPath,
            originalSrtPath: part.clip.originalSrtPath || null,
            finalSrtPath: part.clip.finalSrtPath || null,
            srtPath: part.sourceSrtPath,
            start: part.clip.start,
            end: part.clip.end,
            actualDuration: Number(part.actualDuration.toFixed(3)),
            eventDateTime: part.clip.eventDateTime,
            matchedTerms: part.clip.matchedTerms,
            evidence: part.clip.evidence,
            subtitleSegmentCount: part.subtitleSegmentCount,
            subtitlePreview: part.clip.subtitlePreview
        }))
    };
    writeJson(outputManifest, manifest);
    writeReview(
        { ...plan, summary: { ...plan.summary, totalPlannedDuration: subtitleResult.duration } },
        outputReview,
        resolvedOutput,
        outputSrt,
        outputManifest,
        { reviewTitle: args.reviewTitle }
    );
    return { outputVideo: resolvedOutput, outputSrt, outputManifest, outputReview, manifest };
}

function deriveSiblingPath(outputPath, suffix) {
    const parsed = path.parse(path.resolve(outputPath));
    return path.join(parsed.dir, `${parsed.name}${suffix}`);
}

async function runDiscover(args) {
    if (!args.roots.length || !args.output) throw new Error('discover 需要 --root 和 --output');
    const sources = discoverSources(args.roots);
    writeJson(path.resolve(args.output), { version: 1, generatedAt: new Date().toISOString(), sources });
    console.log(`发现 ${sources.length} 个 SRT 源: ${path.resolve(args.output)}`);
}

async function runSearch(args) {
    if (!args.topic) throw new Error('search 需要 --topic');
    const sources = resolveSources(args);
    const result = await searchTopic(sources, args.topic, args);
    result.sourcePath = args.manifest || args.roots;
    const output = path.resolve(args.output || `${sanitizeFileName(args.topic)}.search.json`);
    writeJson(output, result);
    console.log(`搜索完成: ${result.summary.matchCount} 个字幕命中, ${result.summary.danmakuHitCount} 个弹幕命中, ${result.summary.aliasCount} 个自动 ASR 别名`);
    console.log(`证据文件: ${output}`);
}

async function runPlan(args) {
    if (!args.search) throw new Error('plan 需要 --search');
    const searchPath = path.resolve(args.search);
    const searchData = readJson(searchPath);
    searchData.searchPath = searchPath;
    const plan = buildPlan(searchData, args);
    const output = path.resolve(args.output || deriveSiblingPath(searchPath, '.plan.json'));
    writeJson(output, plan);
    console.log(`计划完成: ${plan.summary.clipCount} 段, 去重 ${plan.summary.removedDuplicateCount} 段`);
    console.log(`计划文件: ${output}`);
}

async function runBuild(args) {
    if (!args.plan || !args.output) throw new Error('build 需要 --plan 和 --output');
    const planPath = path.resolve(args.plan);
    const plan = readJson(planPath);
    const result = await buildCompilation(plan, args.output, { ...args, planPath });
    console.log(`完成: ${result.outputVideo}`);
    console.log(`字幕: ${result.outputSrt}`);
    console.log(`审核: ${result.outputReview}`);
}

async function runCompile(args) {
    if (!args.topic || !args.output) throw new Error('compile 需要 --topic 和 --output');
    const output = path.resolve(args.output);
    const searchPath = path.resolve(args.search || deriveSiblingPath(output, '.search.json'));
    const planPath = path.resolve(args.plan || deriveSiblingPath(output, '.plan.json'));
    const sources = resolveSources(args);
    const searchData = await searchTopic(sources, args.topic, args);
    searchData.sourcePath = args.manifest || args.roots;
    writeJson(searchPath, searchData);
    const plan = buildPlan({ ...searchData, searchPath }, args);
    writeJson(planPath, plan);
    console.log(`搜索: ${searchData.summary.matchCount} 个字幕命中, 自动别名 ${searchData.summary.aliasCount}`);
    console.log(`计划: ${plan.summary.clipCount} 段, 去重 ${plan.summary.removedDuplicateCount} 段`);
    if (args.planOnly) {
        console.log(`仅生成计划: ${planPath}`);
        return;
    }
    await runBuild({ ...args, plan: planPath, output, planPath });
}

async function main() {
    const args = parseArgs();
    if (args.help || args.h) {
        printUsage();
        return;
    }
    const command = String(args.command || 'compile').toLowerCase();
    if (command === 'discover') return runDiscover(args);
    if (command === 'search') return runSearch(args);
    if (command === 'plan') return runPlan(args);
    if (command === 'build') return runBuild(args);
    if (command === 'compile') return runCompile(args);
    throw new Error(`未知命令: ${command}，可用 discover/search/plan/build/compile`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULT_PROFILES,
    parseArgs,
    resolveProfile,
    discoverSources,
    loadSourcesFromManifest,
    inferRecordedAt,
    extractCandidateTerms,
    discoverAsrAliases,
    searchTopic,
    isLikelyIncompleteSubtitle,
    alignWindowToSentence,
    buildSourceWindows,
    dedupeCrossSourceWindows,
    buildPlan,
    formatOverlayLabel,
    buildOverlayArgs,
    buildDefaultCompilationMediaConfig,
    resolveCompilationMediaAdapter,
    writeCompilationSrt,
    formatBeijingDateTime,
    buildCompilation
};
