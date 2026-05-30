const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SUPPORTED_BACKENDS = new Set(['whisper', 'sensevoice']);

const DEFAULT_ASR_CONFIG = {
    default_backend: 'whisper',
    backend: undefined,
    common_hotwords: [],
    corrections: [],
    routing: [],
    whisper: {
        model: 'deepdml/faster-whisper-large-v3-turbo-ct2',
        language: 'zh'
    },
    sensevoice: {
        model: 'iic/SenseVoiceSmall',
        vad_model: 'fsmn-vad',
        punc_model: 'ct-punc',
        spk_model: 'cam++', 
        language: 'auto',
        device: 'cuda',
        use_itn: true,
        max_vad_segment_s: 8,
        merge_length_s: 8,
        process_timeout_s: 1800,
        enable_speaker: false,
        preset_spk_num: null,
        speaker_merge_threshold: 0.78,
        speaker_references: [],
        speaker_reference_threshold: 0.45
    }
};

const DEFAULT_SUBTITLE_CONFIG = {
    max_chars_per_line: 18,
    max_chars_per_segment: 30,
    min_duration: 0.7,
    max_duration: 5.5,
    gap_split_threshold: 0.45,
    merge_short_segments: true,
    avoid_overlap: true,
    strip_punctuation: false
};

function getAsrConfig(config = {}) {
    return {
        ...DEFAULT_ASR_CONFIG,
        ...(config.asr || {}),
        whisper: {
            ...DEFAULT_ASR_CONFIG.whisper,
            ...(config.whisper || {}),
            ...(config.asr?.whisper || {})
        },
        sensevoice: {
            ...DEFAULT_ASR_CONFIG.sensevoice,
            ...(config.asr?.sensevoice || {})
        },
        common_hotwords: Array.isArray(config.asr?.common_hotwords) ? config.asr.common_hotwords : [],
        corrections: config.asr?.corrections || [],
        routing: Array.isArray(config.asr?.routing) ? config.asr.routing : []
    };
}

function getSubtitleConfig(config = {}) {
    return {
        ...DEFAULT_SUBTITLE_CONFIG,
        ...(config.subtitle || {})
    };
}

function validateBackendName(backend, source) {
    if (!backend || typeof backend !== 'string') {
        throw new Error(`ASR backend 配置无效 (${source}): 必须是字符串`);
    }

    const normalized = backend.toLowerCase();
    if (!SUPPORTED_BACKENDS.has(normalized)) {
        throw new Error(`ASR backend 配置无效 (${source}): ${backend}，支持: ${Array.from(SUPPORTED_BACKENDS).join(', ')}`);
    }
    return normalized;
}

function matchesRule(match = {}, context = {}) {
    const entries = Object.entries(match).filter(([, value]) => value !== undefined && value !== null && value !== '');
    if (entries.length === 0) {
        throw new Error('ASR routing.match 不能为空');
    }

    return entries.every(([key, expected]) => {
        const actual = context[key];
        return actual !== undefined && actual !== null && String(actual) === String(expected);
    });
}

function resolveAsrBackend(config, context = {}, cliBackend = null) {
    const asrConfig = getAsrConfig(config);

    if (cliBackend) {
        const backend = validateBackendName(cliBackend, '--asr-backend');
        return {
            backend,
            reason: `命令行覆盖 --asr-backend=${backend}`
        };
    }

    for (const [index, rule] of asrConfig.routing.entries()) {
        if (!rule || typeof rule !== 'object') {
            throw new Error(`ASR routing[${index}] 配置无效: 必须是对象`);
        }
        if (!rule.match || typeof rule.match !== 'object') {
            throw new Error(`ASR routing[${index}] 配置无效: 缺少 match`);
        }
        const backend = validateBackendName(rule.backend, `asr.routing[${index}].backend`);
        if (matchesRule(rule.match, context)) {
            return {
                backend,
                reason: `routing[${index}] 命中 ${JSON.stringify(rule.match)}`
            };
        }
    }

    const fallback = asrConfig.default_backend || asrConfig.backend || 'whisper';
    const backend = validateBackendName(fallback, 'asr.default_backend');
    return {
        backend,
        reason: `未命中 routing，使用 default_backend=${backend}`
    };
}

function normalizeHotwordEntry(entry) {
    if (typeof entry === 'string') {
        const word = entry.trim();
        return word ? { word, weight: undefined, aliases: [] } : null;
    }
    if (!entry || typeof entry !== 'object') {
        return null;
    }
    const word = String(entry.word || entry.text || '').trim();
    if (!word) {
        return null;
    }
    const aliases = Array.isArray(entry.aliases)
        ? entry.aliases.map(alias => String(alias || '').trim()).filter(Boolean)
        : [];
    const contextualAliases = Array.isArray(entry.contextual_aliases)
        ? entry.contextual_aliases.map(alias => String(alias || '').trim()).filter(Boolean)
        : [];
    const weight = Number(entry.weight);
    return {
        word,
        weight: Number.isFinite(weight) ? weight : undefined,
        aliases,
        contextual_aliases: contextualAliases,
        require_nearby: Array.isArray(entry.require_nearby)
            ? entry.require_nearby.map(value => String(value || '').trim()).filter(Boolean)
            : undefined
    };
}

function addHotword(target, entry) {
    const normalized = normalizeHotwordEntry(entry);
    if (!normalized) {
        return;
    }
    const existing = target.get(normalized.word);
    if (!existing) {
        target.set(normalized.word, normalized);
        return;
    }
    if (normalized.weight !== undefined && (existing.weight === undefined || normalized.weight > existing.weight)) {
        existing.weight = normalized.weight;
    }
    existing.aliases = Array.from(new Set([...(existing.aliases || []), ...normalized.aliases]));
    existing.contextual_aliases = Array.from(new Set([...(existing.contextual_aliases || []), ...normalized.contextual_aliases]));
    if (!existing.require_nearby && normalized.require_nearby) {
        existing.require_nearby = normalized.require_nearby;
    }
}

function addCorrection(target, from, to, extra = {}) {
    const source = String(from || '').trim();
    const replacement = String(to || '').trim();
    if (!source || !replacement || source === replacement) {
        return;
    }
    target.set(source, {
        from: source,
        to: replacement,
        ...extra
    });
}

function addSafeCorrections(target, corrections) {
    if (!corrections) {
        return;
    }
    if (Array.isArray(corrections)) {
        corrections.forEach((item) => {
            if (Array.isArray(item) && item.length >= 2) {
                addCorrection(target, item[0], item[1]);
            } else if (item && typeof item === 'object') {
                addCorrection(
                    target,
                    item.from || item.alias || item.source || item.wrong,
                    item.to || item.word || item.target || item.correct
                );
            }
        });
        return;
    }
    if (typeof corrections === 'object') {
        Object.entries(corrections).forEach(([from, to]) => addCorrection(target, from, to));
    }
}

function addContextualCorrections(target, corrections) {
    if (!Array.isArray(corrections)) {
        return;
    }
    corrections.forEach((item) => {
        if (!item || typeof item !== 'object') {
            return;
        }
        const requireNearby = Array.isArray(item.require_nearby)
            ? item.require_nearby.map(value => String(value || '').trim()).filter(Boolean)
            : [];
        addCorrection(target, item.from || item.alias || item.source || item.wrong, item.to || item.word || item.target || item.correct, {
            require_nearby: requireNearby
        });
    });
}

function addCorrections(targets, corrections) {
    if (!corrections) {
        return;
    }
    if (corrections.safe || corrections.contextual) {
        addSafeCorrections(targets.safe, corrections.safe);
        addContextualCorrections(targets.contextual, corrections.contextual);
        return;
    }
    addSafeCorrections(targets.safe, corrections);
}

function resolveAsrHotwords(config, context = {}) {
    const asrConfig = getAsrConfig(config);
    const hotwordsByWord = new Map();
    const corrections = {
        safe: new Map(),
        contextual: new Map()
    };

    asrConfig.common_hotwords.forEach(entry => addHotword(hotwordsByWord, entry));
    addCorrections(corrections, asrConfig.corrections);

    for (const rule of asrConfig.routing) {
        if (!rule || typeof rule !== 'object' || !rule.match || typeof rule.match !== 'object') {
            continue;
        }
        if (!matchesRule(rule.match, context)) {
            continue;
        }
        if (Array.isArray(rule.hotwords)) {
            rule.hotwords.forEach(entry => addHotword(hotwordsByWord, entry));
        }
        addCorrections(corrections, rule.corrections);
    }

    const hotwords = Array.from(hotwordsByWord.values());
    hotwords.forEach((entry) => {
        (entry.aliases || []).forEach(alias => addCorrection(corrections.safe, alias, entry.word));
        (entry.contextual_aliases || []).forEach(alias => addCorrection(corrections.contextual, alias, entry.word, {
            require_nearby: entry.require_nearby || DEFAULT_CONTEXTUAL_NEARBY_WORDS
        }));
    });

    return {
        hotwords,
        corrections: {
            safe: Array.from(corrections.safe.values()),
            contextual: Array.from(corrections.contextual.values())
        },
        hotwordText: hotwords.map(entry => entry.word).join(' '),
        hotwordTextWeighted: hotwords
            .map(entry => entry.weight !== undefined ? `${entry.word} ${entry.weight}` : entry.word)
            .join('\n')
    };
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_CONTEXTUAL_NEARBY_WORDS = ['主播', '直播', '开播', 'SUI', '岁己', '饼干岁', 'VR', 'VirtuaReal'];

function normalizeCorrectionsForApply(corrections = []) {
    if (Array.isArray(corrections)) {
        return { safe: corrections, contextual: [] };
    }
    if (corrections && typeof corrections === 'object') {
        return {
            safe: Array.isArray(corrections.safe) ? corrections.safe : [],
            contextual: Array.isArray(corrections.contextual) ? corrections.contextual : []
        };
    }
    return { safe: [], contextual: [] };
}

function applyCorrectionList(text, corrections = []) {
    let output = String(text || '');
    const normalized = Array.isArray(corrections) ? corrections : [];
    const ordered = normalized
        .filter(item => item && item.from && item.to)
        .sort((a, b) => String(b.from).length - String(a.from).length);
    for (const correction of ordered) {
        output = output.replace(new RegExp(escapeRegExp(correction.from), 'g'), correction.to);
    }
    return output;
}

function applyCorrectionsToText(text, corrections = []) {
    const grouped = normalizeCorrectionsForApply(corrections);
    let output = applyCorrectionList(text, grouped.safe);
    const contextual = grouped.contextual.filter((item) => {
        const nearby = Array.isArray(item.require_nearby)
            ? item.require_nearby.map(value => String(value || '').trim()).filter(Boolean)
            : [];
        return nearby.length > 0 && nearby.some(keyword => output.includes(keyword));
    });
    output = applyCorrectionList(output, contextual);
    return output;
}

function applyCorrectionsToAsrResult(result, corrections = []) {
    const grouped = normalizeCorrectionsForApply(corrections);
    if (grouped.safe.length === 0 && grouped.contextual.length === 0) {
        return result;
    }
    return {
        ...result,
        segments: (Array.isArray(result?.segments) ? result.segments : []).map(segment => ({
            ...segment,
            text: applyCorrectionsToText(segment.text, corrections)
        }))
    };
}

function parseCliArgs(args) {
    const inputPaths = [];
    const options = {
        asrBackend: null,
        asrCompare: null
    };

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--asr-backend') {
            options.asrBackend = args[++i];
        } else if (arg.startsWith('--asr-backend=')) {
            options.asrBackend = arg.slice('--asr-backend='.length);
        } else if (arg === '--asr-compare') {
            options.asrCompare = (args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
        } else if (arg.startsWith('--asr-compare=')) {
            options.asrCompare = arg.slice('--asr-compare='.length).split(',').map(s => s.trim()).filter(Boolean);
        } else {
            inputPaths.push(arg);
        }
    }

    if (options.asrBackend) {
        options.asrBackend = validateBackendName(options.asrBackend, '--asr-backend');
    }
    if (options.asrCompare) {
        options.asrCompare = options.asrCompare.map((backend) => validateBackendName(backend, '--asr-compare'));
    }

    return { inputPaths, options };
}

function formatTimestamp(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const ms = Math.floor((safe % 1) * 1000);
    const whole = Math.floor(safe);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function parseTimestamp(value) {
    const match = String(value).trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
    if (!match) return 0;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseSrt(srtPath, backend = 'whisper') {
    const content = fs.readFileSync(srtPath, 'utf8').replace(/\r\n/g, '\n');
    const blocks = content.split(/\n{2,}/);
    const segments = [];

    for (const block of blocks) {
        const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.length < 2) continue;
        const timeLine = lines.find(line => line.includes('-->'));
        if (!timeLine) continue;
        const [startRaw, endRaw] = timeLine.split('-->').map(s => s.trim());
        const textStart = lines.indexOf(timeLine) + 1;
        const text = lines.slice(textStart).join('').trim();
        if (!text) continue;
        segments.push({
            start: parseTimestamp(startRaw),
            end: parseTimestamp(endRaw),
            text
        });
    }

    return { backend, segments };
}

function splitTextByLength(text, maxChars) {
    if (!text || text.length <= maxChars) return [text].filter(Boolean);
    const parts = [];
    let current = '';
    const tokens = String(text).match(/[A-Za-z0-9]+|./gu) || [];
    for (const token of tokens) {
        if (current && current.length + token.length > maxChars) {
            parts.push(current.trim());
            current = token;
        } else {
            current += token;
        }
        if (/[，。？！,.?!]/.test(token)) {
            parts.push(current.trim());
            current = '';
        }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function stripSubtitlePunctuation(text) {
    return String(text || '')
        .replace(/[，。！？；：、,.?!;:"“”‘’'`（）()【】\[\]《》<>…—\-~～]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeAsrResult(result, subtitleConfig = {}) {
    const cfg = { ...DEFAULT_SUBTITLE_CONFIG, ...subtitleConfig };
    const normalized = [];
    const inputSegments = Array.isArray(result?.segments) ? result.segments : [];

    for (const segment of inputSegments) {
        const start = Number(segment.start);
        const end = Number(segment.end);
        const text = String(segment.text || '').trim();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) {
            continue;
        }

        const textParts = splitTextByLength(text, cfg.max_chars_per_segment);
        const duration = end - start;
        const partDuration = duration / Math.max(textParts.length, 1);
        textParts.forEach((part, index) => {
            const partStart = start + partDuration * index;
            const partEnd = index === textParts.length - 1 ? end : start + partDuration * (index + 1);
            normalized.push({
                start: partStart,
                end: Math.max(partEnd, partStart + cfg.min_duration),
                text: part,
                speaker: segment.speaker,
                words: segment.words
            });
        });
    }

    normalized.sort((a, b) => a.start - b.start);

    if (cfg.avoid_overlap) {
        for (let i = 0; i < normalized.length - 1; i += 1) {
            if (normalized[i].end > normalized[i + 1].start) {
                normalized[i].end = Math.max(normalized[i].start + 0.1, normalized[i + 1].start - 0.01);
            }
        }
    }

    return {
        backend: result?.backend || 'unknown',
        language: result?.language,
        segments: normalized,
        raw: result?.raw
    };
}

function writeSrt(result, srtPath, subtitleConfig = {}) {
    const cfg = { ...DEFAULT_SUBTITLE_CONFIG, ...subtitleConfig };
    const lines = [];
    const uniqueSpeakers = new Set(
        Array.isArray(result.segments)
            ? result.segments.map(segment => String(segment.speaker || '').trim()).filter(Boolean)
            : []
    );
    const includeSpeakerLabels = uniqueSpeakers.size > 1;
    let lineIndex = 1;
    result.segments.forEach((segment) => {
        const correctedText = applyCorrectionsToText(segment.text, cfg.corrections);
        const content = cfg.strip_punctuation ? stripSubtitlePunctuation(correctedText) : correctedText;
        if (!content) {
            return;
        }
        const text = includeSpeakerLabels && segment.speaker ? `[${segment.speaker}] ${content}` : content;
        const wrapped = splitTextByLength(text, cfg.max_chars_per_line).join('\n');
        lines.push(String(lineIndex));
        lines.push(`${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}`);
        lines.push(wrapped);
        lines.push('');
        lineIndex += 1;
    });
    fs.writeFileSync(srtPath, `${lines.join('\n').trim()}\n`, 'utf8');
}

function runJsonPython(scriptPath, payload) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = spawn('python', [scriptPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, PYTHONUTF8: '1' }
        });
        const timeoutSeconds = Number(payload?.process_timeout_s || 0);
        const timeout = timeoutSeconds > 0
            ? setTimeout(() => {
                if (settled) return;
                settled = true;
                try {
                    child.kill('SIGTERM');
                } catch {}
                reject(new Error(`SenseVoice backend 超时: ${timeoutSeconds}s`));
            }, timeoutSeconds * 1000)
            : null;
        let stdout = '';
        let stderr = '';
        let stderrLineBuffer = '';
        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => {
            const chunk = data.toString();
            stderr += chunk;
            stderrLineBuffer += chunk;
            const lines = stderrLineBuffer.split(/\r?\n/);
            stderrLineBuffer = lines.pop() || '';
            for (const line of lines) {
                if (line.startsWith('[SenseVoice]')) {
                    process.stdout.write(`${line}\n`);
                }
            }
        });
        child.on('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            reject(error);
        });
        child.on('close', (code) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            if (stderrLineBuffer.startsWith('[SenseVoice]')) {
                process.stdout.write(`${stderrLineBuffer}\n`);
            }
            if (code !== 0) {
                reject(new Error(`SenseVoice backend failed with exit code ${code}: ${stderr || stdout}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (error) {
                reject(new Error(`SenseVoice backend 输出不是有效 JSON: ${error.message}\nstdout=${stdout}\nstderr=${stderr}`));
            }
        });
        child.stdin.end(JSON.stringify(payload));
    });
}

async function transcribeSenseVoice(mediaPath, config = {}, runtimeOptions = {}) {
    const asrConfig = getAsrConfig(config);
    const scriptPath = path.join(__dirname, '..', 'python', 'sensevoice_transcribe.py');
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`SenseVoice Python script not found at: ${scriptPath}`);
    }
    const options = {
        ...asrConfig.sensevoice,
        audio_path: mediaPath,
        hotwords: runtimeOptions.hotwords || [],
        hotword: runtimeOptions.hotwordTextWeighted || runtimeOptions.hotwordText || '',
        hotword_unweighted: runtimeOptions.hotwordText || ''
    };
    return runJsonPython(scriptPath, options);
}

module.exports = {
    DEFAULT_ASR_CONFIG,
    DEFAULT_SUBTITLE_CONFIG,
    SUPPORTED_BACKENDS,
    getAsrConfig,
    getSubtitleConfig,
    resolveAsrBackend,
    resolveAsrHotwords,
    applyCorrectionsToText,
    applyCorrectionsToAsrResult,
    parseCliArgs,
    parseSrt,
    normalizeAsrResult,
    writeSrt,
    transcribeSenseVoice,
    formatTimestamp,
    parseTimestamp,
    stripSubtitlePunctuation
};

