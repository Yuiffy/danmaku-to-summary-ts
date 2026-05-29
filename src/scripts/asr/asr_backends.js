const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SUPPORTED_BACKENDS = new Set(['whisper', 'sensevoice']);

const DEFAULT_ASR_CONFIG = {
    default_backend: 'whisper',
    backend: undefined,
    routing: [],
    whisper: {
        model: 'deepdml/faster-whisper-large-v3-turbo-ct2',
        language: 'zh'
    },
    sensevoice: {
        model: 'iic/SenseVoiceSmall',
        vad_model: 'fsmn-vad',
        punc_model: 'ct-punc',
        spk_model: null,
        language: 'auto',
        device: 'cuda',
        use_itn: true,
        enable_speaker: false,
        preset_spk_num: null,
        speaker_merge_threshold: 0.78
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
    let lineIndex = 1;
    result.segments.forEach((segment) => {
        const content = cfg.strip_punctuation ? stripSubtitlePunctuation(segment.text) : segment.text;
        if (!content) {
            return;
        }
        const text = segment.speaker ? `[${segment.speaker}] ${content}` : content;
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
        const child = spawn('python', [scriptPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, PYTHONUTF8: '1' }
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
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

async function transcribeSenseVoice(mediaPath, config = {}) {
    const asrConfig = getAsrConfig(config);
    const scriptPath = path.join(__dirname, '..', 'python', 'sensevoice_transcribe.py');
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`SenseVoice Python script not found at: ${scriptPath}`);
    }
    const options = {
        ...asrConfig.sensevoice,
        audio_path: mediaPath
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
    parseCliArgs,
    parseSrt,
    normalizeAsrResult,
    writeSrt,
    transcribeSenseVoice,
    formatTimestamp,
    parseTimestamp,
    stripSubtitlePunctuation
};
