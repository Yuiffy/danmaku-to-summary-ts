#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const configLoader = require('../config-loader');
const asrBackends = require('./asr_backends');

const DEFAULT_ROOT = 'D:/files/videos/DDTV录播';
const TARGET_MATCH_RE = /(碎几|碎己|碎机|碎即|岁几|岁已|岁机|随机|随即|小岁|岁己姐|小岁姐|穗子姐|小穗姐)/;
const XML_CONTEXT_RE = /(岁己|小岁|饼干岁)/;
const MEDIA_EXTS = ['.flv', '.mp4', '.m4a', '.aac', '.wav', '.mp3', '.ogg', '.flac', '.mkv', '.ts', '.mov'];
const BACKEND_ALIASES = new Map([
    ['fun-asr-nano', 'fun_asr_nano'],
    ['fun-asr-nano-vllm', 'fun_asr_nano_vllm'],
    ['fun_asr_nano-vllm', 'fun_asr_nano_vllm']
]);
const EVAL_TERMS = ['岁己', '小岁', '岁己SUI', '岁岁', '随机', '随即', '碎几', '碎己', '碎机', '碎即', '穗即', '穗姐', '穗穗', '小穗'];
const SUI_EXPECTED_RE = /(岁己|小岁|岁岁|岁己姐|小岁姐|饼干岁|碎己|碎即|穗即|穗姐|穗穗|小穗|小穗姐|小碎姐|岁几|岁已|岁机)/;
const RANDOM_RE = /(随机|随即)/;
const SUI_TARGET_RE = /(岁己|小岁|岁岁|岁己SUI|岁己姐|小岁姐|饼干岁)/;

function parseArgs(argv) {
    const options = {
        root: DEFAULT_ROOT,
        limit: 8,
        windowSec: 25,
        preSec: 10,
        postSec: 10,
        outputDir: path.join(process.cwd(), 'tmp', 'asr-hotword-benchmark'),
        noAsr: false,
        backend: 'fun_asr_nano',
        failFast: false
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--root') {
            options.root = argv[++i];
        } else if (arg.startsWith('--root=')) {
            options.root = arg.slice('--root='.length);
        } else if (arg === '--limit') {
            options.limit = Number(argv[++i]);
        } else if (arg.startsWith('--limit=')) {
            options.limit = Number(arg.slice('--limit='.length));
        } else if (arg === '--window') {
            options.windowSec = Number(argv[++i]);
        } else if (arg.startsWith('--window=')) {
            options.windowSec = Number(arg.slice('--window='.length));
        } else if (arg === '--pre') {
            options.preSec = Number(argv[++i]);
        } else if (arg.startsWith('--pre=')) {
            options.preSec = Number(arg.slice('--pre='.length));
        } else if (arg === '--post') {
            options.postSec = Number(argv[++i]);
        } else if (arg.startsWith('--post=')) {
            options.postSec = Number(arg.slice('--post='.length));
        } else if (arg === '--output') {
            options.outputDir = argv[++i];
        } else if (arg.startsWith('--output=')) {
            options.outputDir = arg.slice('--output='.length);
        } else if (arg === '--no-asr') {
            options.noAsr = true;
        } else if (arg === '--backend') {
            options.backend = argv[++i];
        } else if (arg.startsWith('--backend=')) {
            options.backend = arg.slice('--backend='.length);
        } else if (arg === '--fail-fast') {
            options.failFast = true;
        }
    }

    options.limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 8;
    options.windowSec = Number.isFinite(options.windowSec) && options.windowSec > 0 ? options.windowSec : 25;
    options.preSec = Number.isFinite(options.preSec) && options.preSec >= 0 ? options.preSec : 10;
    options.postSec = Number.isFinite(options.postSec) && options.postSec >= 0 ? options.postSec : 10;
    options.root = String(options.root || '').trim() || DEFAULT_ROOT;
    options.outputDir = String(options.outputDir || '').trim() || path.join(process.cwd(), 'tmp', 'asr-hotword-benchmark');
    options.backends = normalizeBackendList(options.backend || 'fun_asr_nano');
    options.backend = options.backends[0] || 'fun_asr_nano';
    return options;
}

function normalizeBackendName(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return BACKEND_ALIASES.get(normalized) || normalized || 'fun_asr_nano';
}

function normalizeBackendList(value) {
    return Array.from(new Set(
        String(value || '')
            .split(',')
            .map(item => normalizeBackendName(item))
            .filter(Boolean)
    ));
}

function walkFiles(dir) {
    const result = [];
    if (!fs.existsSync(dir)) {
        return result;
    }
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else {
                result.push(full);
            }
        }
    }
    return result;
}

function parseSrtTimestamp(value) {
    const match = String(value || '').trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
    if (!match) {
        return 0;
    }
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function formatSrtTimestamp(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const ms = Math.floor((safe % 1) * 1000);
    const whole = Math.floor(safe);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function safeName(value) {
    return String(value || '')
        .replace(/[^\p{L}\p{N}._-]+/gu, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120) || 'clip';
}

function parseSrtFile(srtPath) {
    const segments = asrBackends.parseSrt(srtPath, 'whisper').segments;
    return segments.map((segment, index) => ({
        index,
        ...segment,
        rawText: segment.text
    }));
}

function findMediaPath(srtPath) {
    const dir = path.dirname(srtPath);
    const parsed = path.parse(srtPath);
    const candidates = [];
    MEDIA_EXTS.forEach(ext => candidates.push(path.join(dir, `${parsed.name}${ext}`)));
    const stem = parsed.name.replace(/_merged$/, '');
    if (stem !== parsed.name) {
        MEDIA_EXTS.forEach(ext => candidates.push(path.join(dir, `${stem}${ext}`)));
    }
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function findXmlPath(srtPath) {
    const dir = path.dirname(srtPath);
    const parsed = path.parse(srtPath);
    const candidates = [];
    candidates.push(path.join(dir, `${parsed.name}.xml`));
    const stem = parsed.name.replace(/_merged$/, '');
    if (stem !== parsed.name) {
        candidates.push(path.join(dir, `${stem}.xml`));
    }
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function extractXmlEntries(xmlPath) {
    if (!xmlPath || !fs.existsSync(xmlPath)) {
        return [];
    }
    const content = fs.readFileSync(xmlPath, 'utf8')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n');
    const results = [];
    for (const line of content.split('\n')) {
        if (!line.includes('<d p="') || !line.includes('</d>')) {
            continue;
        }
        const pStart = line.indexOf('p="');
        if (pStart < 0) {
            continue;
        }
        const pValueStart = pStart + 3;
        const pValueEnd = line.indexOf('"', pValueStart);
        const closeTagIndex = line.lastIndexOf('</d>');
        const textStart = line.indexOf('>', pValueEnd) + 1;
        if (pValueEnd < 0 || closeTagIndex < 0 || textStart <= 0 || textStart > closeTagIndex) {
            continue;
        }
        const text = line.slice(textStart, closeTagIndex).replace(/<[^>]+>/g, '').trim();
        const timestamp = Number(String(line.slice(pValueStart, pValueEnd)).split(',')[0]);
        if (!Number.isFinite(timestamp)) {
            continue;
        }
        results.push({
            time: timestamp,
            text,
            highlight: XML_CONTEXT_RE.test(text) || XML_CONTEXT_RE.test(line)
        });
    }
    return results.sort((a, b) => a.time - b.time);
}

function extractNearbyXml(xmlEntries, centerSec, windowSec) {
    if (!Array.isArray(xmlEntries) || xmlEntries.length === 0) {
        return [];
    }
    const inWindow = xmlEntries.filter(item => Math.abs(item.time - centerSec) <= windowSec);
    const base = inWindow.length > 0 ? inWindow : [...xmlEntries]
        .sort((a, b) => Math.abs(a.time - centerSec) - Math.abs(b.time - centerSec))
        .slice(0, 4);
    return base.slice(0, 8);
}

function cloneConfig(config) {
    return JSON.parse(JSON.stringify(config));
}

function buildBaselineConfig(config) {
    const legacy = cloneConfig(config);
    const asr = legacy.asr || {};
    const common = Array.isArray(asr.common_hotwords) ? asr.common_hotwords.slice() : [];
    const filtered = common.filter(entry => !(entry && entry.word === '岁己'));
    asr.common_hotwords = filtered;
    asr.corrections = [];
    asr.routing = Array.isArray(asr.routing)
        ? asr.routing.filter((rule) => {
            if (!rule || !rule.match) {
                return true;
            }
            const match = rule.match || {};
            return !(
                String(match.room_id || '') === '25788785' ||
                String(match.streamer_name || '') === '岁己SUI'
            );
        })
        : [];
    legacy.asr = asr;
    return legacy;
}

function runFfmpeg(ffmpegPath, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        let stderr = '';
        child.stderr.on('data', data => {
            stderr += data.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 300)}`));
        });
    });
}

async function extractClip(mediaPath, outputPath, startSec, endSec, ffmpegPath) {
    const duration = Math.max(0.5, endSec - startSec);
    const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', formatSrtTimestamp(startSec).replace(',', '.'),
        '-i', mediaPath,
        '-t', String(duration),
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'pcm_s16le',
        '-y',
        outputPath
    ];
    await runFfmpeg(ffmpegPath, args);
}

function countTerm(text, term) {
    if (!term) {
        return 0;
    }
    return (String(text || '').match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

function summarizeTranscript(text, rawText = '') {
    const normalized = String(text || '');
    const raw = String(rawText || '');
    const summary = {
        text: normalized,
        found: {},
        rawFound: {}
    };
    EVAL_TERMS.forEach((target) => {
        summary.found[target] = countTerm(normalized, target);
        summary.rawFound[target] = countTerm(raw, target);
    });
    summary.randomStillPresent = /随机|随即/.test(normalized);
    summary.falseSuiFromRandomRisk = /随机|随即/.test(raw) && /岁己|小岁/.test(normalized);
    summary.suiHomophonesRemaining = ['碎几', '碎己', '碎机', '碎即', '穗即', '穗姐', '穗穗', '小穗']
        .filter(term => normalized.includes(term));
    return summary;
}

function classifyExpected(candidate) {
    const sourceText = [
        candidate?.segment?.text || '',
        ...(candidate?.xmlNearby || []).map(item => item.text || ''),
        ...(candidate?.xmlHighlights || []).map(item => item.text || '')
    ].join(' ');
    const expectsRandomPreserved = RANDOM_RE.test(candidate?.segment?.text || '');
    const expectsSui = SUI_EXPECTED_RE.test(sourceText);
    return {
        expectsSui,
        expectsXiaoSui: /(小岁|小穗|小碎)/.test(sourceText),
        expectsRandomPreserved,
        randomNegative: expectsRandomPreserved && !expectsSui
    };
}

function evaluateRun(run, expected) {
    if (!run || run.status !== 'ok') {
        return {
            status: run?.status || 'missing',
            evaluable: false
        };
    }
    const text = String(run.transcript || '');
    const found = run.summary?.found || {};
    const containsSuiTarget = SUI_TARGET_RE.test(text);
    const containsXiaoSui = (found['小岁'] || 0) > 0;
    const containsRandom = RANDOM_RE.test(text);
    return {
        status: run.status,
        evaluable: true,
        suiTargetHit: expected.expectsSui ? containsSuiTarget : null,
        xiaoSuiHit: expected.expectsXiaoSui ? containsXiaoSui : null,
        randomPreserved: expected.expectsRandomPreserved ? containsRandom : null,
        randomFalseSui: expected.randomNegative ? containsSuiTarget : false,
        suiHomophonesRemaining: run.summary?.suiHomophonesRemaining || []
    };
}

async function runBackend(backend, clipPath, config, runtime) {
    if (backend === 'fun_asr_nano_vllm') {
        return asrBackends.transcribeFunAsrNanoVllm(clipPath, config, runtime);
    }
    if (backend === 'fun_asr_nano') {
        return asrBackends.transcribeFunAsrNano(clipPath, config, runtime);
    }
    if (backend === 'sensevoice') {
        return asrBackends.transcribeSenseVoice(clipPath, config, runtime);
    }
    throw new Error(`hotword benchmark 不支持 backend=${backend}`);
}

async function transcribeClip(clipPath, config, context, label, backend, clipDurationSec) {
    const runtime = asrBackends.resolveAsrHotwords(config, context);
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const result = await runBackend(backend, clipPath, config, runtime);
    const elapsedMs = Math.round(performance.now() - t0);
    const normalized = asrBackends.normalizeAsrResult(result, asrBackends.getSubtitleConfig(config));
    const rawText = normalized.segments.map(segment => segment.text).join('');
    const corrected = asrBackends.applyCorrectionsToAsrResult(normalized, runtime.corrections);
    const text = corrected.segments.map(segment => segment.text).join('');
    return {
        label,
        backend,
        startedAt,
        elapsedMs,
        clipDurationSec,
        realtimeFactor: clipDurationSec > 0 ? Number((elapsedMs / 1000 / clipDurationSec).toFixed(4)) : null,
        segmentCount: normalized.segments.length,
        hotwords: runtime.hotwordWords || runtime.hotwordTokens || runtime.hotwords || [],
        rawTranscript: rawText,
        transcript: text,
        summary: summarizeTranscript(text, rawText)
    };
}

async function safeTranscribeClip(clipPath, config, context, label, backend, clipDurationSec, options = {}) {
    try {
        const result = await transcribeClip(clipPath, config, context, label, backend, clipDurationSec);
        return {
            status: 'ok',
            ...result
        };
    } catch (error) {
        if (options.failFast) {
            throw error;
        }
        const runtime = asrBackends.resolveAsrHotwords(config, context);
        return {
            status: 'failed',
            label,
            backend,
            startedAt: new Date().toISOString(),
            elapsedMs: null,
            clipDurationSec,
            realtimeFactor: null,
            hotwords: runtime.hotwordWords || runtime.hotwordTokens || runtime.hotwords || [],
            rawTranscript: '',
            transcript: '',
            summary: summarizeTranscript('', ''),
            error: {
                message: error.message,
                stack: String(error.stack || '').split(/\r?\n/).slice(0, 12).join('\n')
            }
        };
    }
}

function selectCandidates(root, limit, windowSec) {
    const files = walkFiles(root).filter(file => file.toLowerCase().endsWith('.srt'));
    const candidates = [];
    const stats = {
        srtFiles: files.length,
        filesWithMedia: 0,
        filesWithXmlPath: 0,
        filesWithXml: 0,
        segmentsWithTarget: 0,
        segmentsWithXmlContext: 0
    };
    for (const srtPath of files) {
        const mediaPath = findMediaPath(srtPath);
        const xmlPath = findXmlPath(srtPath);
        if (!mediaPath) {
            continue;
        }
        stats.filesWithMedia += 1;
        const xmlEntries = extractXmlEntries(xmlPath);
        if (xmlPath && fs.existsSync(xmlPath)) {
            stats.filesWithXmlPath += 1;
        }
        if (xmlEntries.length === 0) {
            continue;
        }
        stats.filesWithXml += 1;
        const segments = parseSrtFile(srtPath);
        for (const segment of segments) {
            if (!TARGET_MATCH_RE.test(segment.rawText)) {
                continue;
            }
            stats.segmentsWithTarget += 1;
            const xmlNearby = extractNearbyXml(xmlEntries, segment.start, windowSec);
            if (xmlNearby.length === 0) {
                continue;
            }
            stats.segmentsWithXmlContext += 1;
            candidates.push({
                srtPath,
                mediaPath,
                xmlPath,
                xmlEntries,
                segment,
                xmlNearby
            });
            if (candidates.length >= limit) {
                console.log(`候选统计: ${JSON.stringify(stats)}`);
                return candidates;
            }
        }
    }
    console.log(`候选统计: ${JSON.stringify(stats)}`);
    return candidates;
}

function summarizeReport(report) {
    const runItems = [];
    for (const candidate of report.candidates || []) {
        if (candidate.backends && typeof candidate.backends === 'object') {
            Object.entries(candidate.backends).forEach(([backend, backendResult]) => {
                ['baseline', 'tuned'].forEach((label) => {
                    if (backendResult?.[label]) {
                        runItems.push({
                            backend,
                            label,
                            run: backendResult[label],
                            expected: candidate.expected || {},
                            evaluation: backendResult.evaluation?.[label]
                        });
                    }
                });
            });
        } else {
            ['baseline', 'tuned'].forEach((label) => {
                if (candidate[label]) {
                    runItems.push({
                        backend: candidate[label].backend || report.backend || 'unknown',
                        label,
                        run: candidate[label],
                        expected: candidate.expected || {},
                        evaluation: candidate.evaluation?.[label]
                    });
                }
            });
        }
    }
    const runs = runItems.map(item => item.run);
    const okRuns = runs.filter(run => run.status === 'ok');
    const failedRuns = runs.filter(run => run.status === 'failed');
    const backendNames = Array.from(new Set([
        ...(Array.isArray(report.backends) ? report.backends : []),
        ...runItems.map(item => item.backend)
    ].filter(Boolean)));

    function summarizeItems(items) {
        const okItems = items.filter(item => item.run.status === 'ok');
        const failedItems = items.filter(item => item.run.status === 'failed');
        const rtfValues = okItems
            .map(item => item.run.realtimeFactor)
            .filter(value => Number.isFinite(value));
        const avgRtf = rtfValues.length > 0
            ? rtfValues.reduce((acc, value) => acc + value, 0) / rtfValues.length
            : NaN;
        const evaluations = items.filter(item => item.evaluation?.evaluable);
        const byLabel = {};
        ['baseline', 'tuned'].forEach((label) => {
            const labelItems = evaluations.filter(item => item.label === label);
            const suiItems = labelItems.filter(item => item.expected.expectsSui);
            const xiaoSuiItems = labelItems.filter(item => item.expected.expectsXiaoSui);
            const randomItems = labelItems.filter(item => item.expected.expectsRandomPreserved);
            const randomNegativeItems = labelItems.filter(item => item.expected.randomNegative);
            byLabel[label] = {
                evaluableRuns: labelItems.length,
                suiExpected: suiItems.length,
                suiTargetHits: suiItems.filter(item => item.evaluation.suiTargetHit).length,
                xiaoSuiExpected: xiaoSuiItems.length,
                xiaoSuiHits: xiaoSuiItems.filter(item => item.evaluation.xiaoSuiHit).length,
                randomExpected: randomItems.length,
                randomPreserved: randomItems.filter(item => item.evaluation.randomPreserved).length,
                randomNegative: randomNegativeItems.length,
                randomFalseSui: randomNegativeItems.filter(item => item.evaluation.randomFalseSui).length
            };
            byLabel[label].suiTargetHitRate = byLabel[label].suiExpected > 0
                ? Number((byLabel[label].suiTargetHits / byLabel[label].suiExpected).toFixed(4))
                : null;
            byLabel[label].randomPreserveRate = byLabel[label].randomExpected > 0
                ? Number((byLabel[label].randomPreserved / byLabel[label].randomExpected).toFixed(4))
                : null;
        });
        return {
            runCount: items.length,
            okRuns: okItems.length,
            failedRuns: failedItems.length,
            averageRealtimeFactor: Number.isFinite(avgRtf) ? Number(avgRtf.toFixed(4)) : null,
            accuracy: byLabel,
            failedMessages: Array.from(new Set(failedItems.map(item => item.run.error?.message).filter(Boolean))).slice(0, 5)
        };
    }

    const overall = summarizeItems(runItems);
    const byBackend = {};
    backendNames.forEach((backend) => {
        byBackend[backend] = summarizeItems(runItems.filter(item => item.backend === backend));
    });
    const primaryBackend = backendNames[0] || report.backend || 'unknown';

    return {
        candidateCount: report.candidates.length,
        runCount: overall.runCount,
        okRuns: overall.okRuns,
        failedRuns: overall.failedRuns,
        averageRealtimeFactor: overall.averageRealtimeFactor,
        accuracy: byBackend[primaryBackend]?.accuracy || overall.accuracy,
        byBackend,
        failedMessages: overall.failedMessages
    };
}

function logRun(label, run) {
    if (run.status === 'ok') {
        console.log(`  ${label.padEnd(8)} (${run.elapsedMs}ms, RTF=${run.realtimeFactor}): ${run.transcript}`);
    } else {
        console.log(`  ${label.padEnd(8)} failed: ${run.error.message}`);
    }
}

async function transcribeBackendPair(backend, clipPath, baselineConfig, config, context, clipDurationSec, options) {
    const baseline = await safeTranscribeClip(clipPath, baselineConfig, context, 'baseline', backend, clipDurationSec, options);
    const tuned = await safeTranscribeClip(clipPath, config, context, 'tuned', backend, clipDurationSec, options);
    return {
        baseline,
        tuned,
        evaluation: null
    };
}

function attachEvaluation(backendResult, expected) {
    backendResult.evaluation = {
        baseline: evaluateRun(backendResult.baseline, expected),
        tuned: evaluateRun(backendResult.tuned, expected)
    };
    return backendResult;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const config = configLoader.getConfig();
    const baselineConfig = buildBaselineConfig(config);
    const ffmpegPath = config.audio?.ffmpeg?.path || 'ffmpeg';
    fs.mkdirSync(options.outputDir, { recursive: true });

    const allFiles = walkFiles(options.root);
    const srtCount = allFiles.filter(file => file.toLowerCase().endsWith('.srt')).length;
    const xmlCount = allFiles.filter(file => file.toLowerCase().endsWith('.xml')).length;
    console.log(`根目录: ${options.root}`);
    console.log(`目录存在: ${fs.existsSync(options.root)}`);
    console.log(`扫描文件: ${allFiles.length}, SRT=${srtCount}, XML=${xmlCount}`);

    const candidates = selectCandidates(options.root, options.limit, options.windowSec);
    const report = {
        root: options.root,
        outputDir: options.outputDir,
        backend: options.backend,
        backends: options.backends,
        generatedAt: new Date().toISOString(),
        candidates: []
    };

    console.log(`扫描到 ${candidates.length} 个候选片段`);

    for (let index = 0; index < candidates.length; index += 1) {
        const item = candidates[index];
        const baseName = safeName(`${path.parse(item.srtPath).name}_${String(item.segment.index).padStart(4, '0')}_${formatSrtTimestamp(item.segment.start)}`);
        const clipPath = path.join(options.outputDir, `${baseName}.wav`);
        const clipStart = Math.max(0, item.segment.start - options.preSec);
        const clipEnd = item.segment.end + options.postSec;
        const clipDurationSec = Number((clipEnd - clipStart).toFixed(3));
        const candidateReport = {
            index: index + 1,
            srtPath: item.srtPath,
            mediaPath: item.mediaPath,
            xmlPath: item.xmlPath,
            segment: {
                start: item.segment.start,
                end: item.segment.end,
                text: item.segment.rawText
            },
            xmlNearby: item.xmlNearby,
            xmlHighlights: item.xmlEntries.filter(entry => entry.highlight).slice(0, 12),
            clipPath,
            clipDurationSec
        };
        candidateReport.expected = classifyExpected(candidateReport);

        console.log(`\n[${index + 1}/${candidates.length}] ${path.basename(item.srtPath)} @ ${formatSrtTimestamp(item.segment.start)}`);
        console.log(`  ASR: ${item.segment.rawText}`);
        console.log(`  XML: ${item.xmlNearby.map(x => `${x.time.toFixed(1)}s:${x.text}`).join(' | ')}`);

        if (!options.noAsr) {
            await extractClip(item.mediaPath, clipPath, clipStart, clipEnd, ffmpegPath);
            const context = {
                mediaPath: clipPath
            };
            candidateReport.backends = {};
            for (const backend of options.backends) {
                console.log(`  backend: ${backend}`);
                const backendResult = await transcribeBackendPair(
                    backend,
                    clipPath,
                    baselineConfig,
                    config,
                    context,
                    clipDurationSec,
                    options
                );
                attachEvaluation(backendResult, candidateReport.expected);
                candidateReport.backends[backend] = backendResult;
                logRun('baseline', backendResult.baseline);
                logRun('tuned', backendResult.tuned);
            }
            if (options.backends.length === 1) {
                const only = candidateReport.backends[options.backends[0]];
                candidateReport.baseline = only.baseline;
                candidateReport.tuned = only.tuned;
                candidateReport.evaluation = only.evaluation;
            }
        } else {
            console.log('  跳过 ASR，仅输出候选与 XML 对照');
        }

        report.candidates.push(candidateReport);
    }

    report.summary = summarizeReport(report);
    const reportPath = path.join(options.outputDir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n报告已写入: ${reportPath}`);
}

main().catch((error) => {
    console.error(`hotword benchmark failed: ${error.stack || error.message}`);
    process.exit(1);
});
