const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SUPPORTED_BACKENDS = new Set(['whisper', 'sensevoice', 'fun_asr_nano', 'fun_asr_nano_vllm']);
const BACKEND_ALIASES = new Map([
    ['fun-asr-nano', 'fun_asr_nano'],
    ['fun-asr-nano-vllm', 'fun_asr_nano_vllm'],
    ['fun_asr_nano-vllm', 'fun_asr_nano_vllm']
]);

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
        python_executable: null,
        python_args: [],
        python_path_map: [],
        use_itn: true,
        max_vad_segment_s: 8,
        merge_length_s: 8,
        process_timeout_s: 1800,
        enable_speaker: false,
        preset_spk_num: null,
        speaker_merge_threshold: 0.78,
        speaker_references: [],
        speaker_reference_threshold: 0.45
    },
    fun_asr_nano: {
        model: 'FunAudioLLM/Fun-ASR-Nano-2512',
        vad_model: 'fsmn-vad',
        punc_model: null,
        spk_model: null,
        language: '中文',
        device: 'cuda',
        python_executable: null,
        python_args: [],
        python_path_map: [],
        use_itn: true,
        max_vad_segment_s: 8,
        merge_length_s: 8,
        process_timeout_s: 1800,
        enable_speaker: false,
        preset_spk_num: null,
        speaker_merge_threshold: 0.78,
        speaker_references: [],
        speaker_reference_threshold: 0.45
    },
    fun_asr_nano_vllm: {
        model: 'FunAudioLLM/Fun-ASR-Nano-2512',
        vad_model: 'fsmn-vad',
        punc_model: null,
        spk_model: 'cam++',
        language: '中文',
        device: 'cuda',
        python_executable: null,
        python_args: [],
        python_path_map: [],
        use_itn: true,
        process_timeout_s: 3600,
        enable_speaker: true,
        preset_spk_num: null,
        speaker_merge_threshold: 0.78,
        speaker_references: [],
        speaker_reference_threshold: 0.45,
        hub: 'ms',
        dtype: 'bf16',
        tensor_parallel_size: 1,
        gpu_memory_utilization: 0.8,
        max_model_len: 4096,
        max_new_tokens: 512,
        batch_size_s: 300,
        enforce_eager: false
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
        fun_asr_nano: {
            ...DEFAULT_ASR_CONFIG.fun_asr_nano,
            ...(config.asr?.fun_asr_nano || {})
        },
        fun_asr_nano_vllm: {
            ...DEFAULT_ASR_CONFIG.fun_asr_nano_vllm,
            ...(config.asr?.fun_asr_nano_vllm || {})
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

    const normalized = normalizeBackendName(backend);
    if (!SUPPORTED_BACKENDS.has(normalized)) {
        throw new Error(`ASR backend 配置无效 (${source}): ${backend}，支持: ${Array.from(SUPPORTED_BACKENDS).join(', ')}`);
    }
    return normalized;
}

function normalizeBackendName(backend) {
    const normalized = String(backend || '').trim().toLowerCase();
    return BACKEND_ALIASES.get(normalized) || normalized;
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
        return word ? { word, weight: undefined, aliases: [], hotword_terms: [], alias_hotwords: true, correction_to: word } : null;
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
    const hotwordTerms = Array.isArray(entry.hotword_terms)
        ? entry.hotword_terms.map(term => String(term || '').trim()).filter(Boolean)
        : [];
    const weight = Number(entry.weight);
    const correctionTo = String(entry.correction_to || entry.rewrite_to || entry.normalize_to || word).trim() || word;
    return {
        word,
        weight: Number.isFinite(weight) ? weight : undefined,
        aliases,
        contextual_aliases: contextualAliases,
        hotword_terms: hotwordTerms,
        alias_hotwords: entry.alias_hotwords !== false && entry.aliases_as_hotwords !== false,
        correction_to: correctionTo,
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
    existing.hotword_terms = Array.from(new Set([...(existing.hotword_terms || []), ...normalized.hotword_terms]));
    existing.alias_hotwords = existing.alias_hotwords !== false && normalized.alias_hotwords !== false;
    if (!existing.correction_to && normalized.correction_to) {
        existing.correction_to = normalized.correction_to;
    }
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
    const hotwordTokens = new Map();
    const hotwordPromptTokens = new Map();
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
        const correctionTo = entry.correction_to || entry.word;
        addHotwordToken(hotwordTokens, entry.word, entry.weight);
        addHotwordToken(hotwordPromptTokens, entry.word, entry.weight);
        (entry.aliases || []).forEach(alias => {
            addHotwordToken(hotwordTokens, alias, entry.weight);
            if (entry.alias_hotwords !== false) {
                addHotwordToken(hotwordPromptTokens, alias, entry.weight);
            }
            addCorrection(corrections.safe, alias, correctionTo);
        });
        (entry.hotword_terms || []).forEach((term) => {
            addHotwordToken(hotwordTokens, term, entry.weight);
            addHotwordToken(hotwordPromptTokens, term, entry.weight);
        });
        (entry.contextual_aliases || []).forEach(alias => addCorrection(corrections.contextual, alias, correctionTo, {
            require_nearby: entry.require_nearby || DEFAULT_CONTEXTUAL_NEARBY_WORDS
        }));
    });

    const hotwordTokenList = Array.from(hotwordTokens.values());
    const hotwordPromptTokenList = Array.from(hotwordPromptTokens.values());
    return {
        hotwords,
        hotwordTokens: hotwordTokenList,
        hotwordPromptTokens: hotwordPromptTokenList,
        hotwordWords: hotwordPromptTokenList.map(entry => entry.word),
        corrections: {
            safe: Array.from(corrections.safe.values()),
            contextual: Array.from(corrections.contextual.values())
        },
        hotwordText: hotwordTokenList.map(entry => entry.word).join(' '),
        hotwordTextWeighted: hotwordTokenList
            .map(entry => entry.weight !== undefined ? `${entry.word} ${entry.weight}` : entry.word)
            .join('\n')
    };
}

function addHotwordToken(target, word, weight) {
    const token = String(word || '').trim();
    if (!token) {
        return;
    }
    const existing = target.get(token);
    if (!existing) {
        target.set(token, {
            word: token,
            weight: Number.isFinite(Number(weight)) ? Number(weight) : undefined
        });
        return;
    }
    const nextWeight = Number(weight);
    if (Number.isFinite(nextWeight) && (existing.weight === undefined || nextWeight > existing.weight)) {
        existing.weight = nextWeight;
    }
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
                speaker_score: segment.speaker_score,
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

function normalizeLabel(value) {
    return String(value || '').trim().toLowerCase();
}

function isUnknownSpeakerLabel(label) {
    const value = String(label || '').trim();
    return !value || value === 'UNKNOWN' || /^SPEAKER_\d+$/i.test(value);
}

function resolveStreamerRegistry(config = {}) {
    const raw = config.ai?.streamerRegistry || {};
    const registry = {};
    Object.entries(raw).forEach(([streamerId, entry]) => {
        if (!entry || typeof entry !== 'object') {
            return;
        }
        const displayName = String(entry.displayName || streamerId).trim();
        const labels = new Set([
            streamerId,
            displayName,
            ...(Array.isArray(entry.speakerLabels) ? entry.speakerLabels : []),
            ...(Array.isArray(entry.aliases) ? entry.aliases : [])
        ].map(value => String(value || '').trim()).filter(Boolean));
        registry[streamerId] = {
            id: streamerId,
            ...entry,
            displayName,
            speakerLabels: Array.from(labels)
        };
    });
    return registry;
}

function mapSpeakerLabelToStreamerId(label, registry = {}) {
    const normalized = normalizeLabel(label);
    if (!normalized || isUnknownSpeakerLabel(label)) {
        return null;
    }
    for (const [streamerId, entry] of Object.entries(registry)) {
        const labels = Array.isArray(entry.speakerLabels) ? entry.speakerLabels : [];
        if (labels.some(candidate => normalizeLabel(candidate) === normalized)) {
            return streamerId;
        }
    }
    return null;
}

function getMultiReferenceConfig(config = {}, roomId = null) {
    const globalConfig = config.ai?.comic?.multiReferenceImages || {};
    const roomConfig = roomId
        ? (config.ai?.roomSettings?.[String(roomId)]?.multiReferenceImages || {})
        : {};
    return {
        enabled: false,
        maxExtraCharacters: 2,
        minSpeakerScore: 0.50,
        minSpeechSeconds: 8,
        includeUnknownSpeakers: false,
        useMentionedOnlyAsContext: true,
        appendCharacterDescriptions: true,
        imageOrder: ['host', 'appeared_streamers', 'cover', 'screenshots', 'default'],
        ...globalConfig,
        ...roomConfig
    };
}

function findHostStreamerId(roomId, registry = {}) {
    const room = String(roomId || '').trim();
    if (!room) {
        return null;
    }
    for (const [streamerId, entry] of Object.entries(registry)) {
        const roomIds = Array.isArray(entry.roomIds) ? entry.roomIds.map(value => String(value)) : [];
        if (roomIds.includes(room)) {
            return streamerId;
        }
    }
    return null;
}

function summarizeAsrSpeakers(result, config = {}, context = {}) {
    const registry = resolveStreamerRegistry(config);
    const roomId = context.room_id || context.roomId || context.hostRoomId || null;
    const multiConfig = getMultiReferenceConfig(config, roomId);
    const stats = new Map();
    const segments = Array.isArray(result?.segments) ? result.segments : [];

    segments.forEach((segment) => {
        const label = String(segment.speaker || '').trim() || 'UNKNOWN';
        const start = Number(segment.start);
        const end = Number(segment.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            return;
        }
        const duration = end - start;
        const rawScore = segment.speaker_score;
        const score = rawScore === undefined || rawScore === null || rawScore === ''
            ? NaN
            : Number(rawScore);
        if (!stats.has(label)) {
            stats.set(label, {
                label,
                totalSpeechSeconds: 0,
                segmentCount: 0,
                scoreSum: 0,
                scoreCount: 0,
                maxScore: null,
                isUnknown: isUnknownSpeakerLabel(label)
            });
        }
        const item = stats.get(label);
        item.totalSpeechSeconds += duration;
        item.segmentCount += 1;
        if (Number.isFinite(score)) {
            item.scoreSum += score;
            item.scoreCount += 1;
            item.maxScore = item.maxScore === null ? score : Math.max(item.maxScore, score);
        }
    });

    const speakers = Array.from(stats.values())
        .map(item => ({
            label: item.label,
            totalSpeechSeconds: Number(item.totalSpeechSeconds.toFixed(3)),
            segmentCount: item.segmentCount,
            avgScore: item.scoreCount > 0 ? Number((item.scoreSum / item.scoreCount).toFixed(4)) : null,
            maxScore: item.maxScore === null ? null : Number(item.maxScore.toFixed(4)),
            isUnknown: item.isUnknown
        }))
        .sort((a, b) => b.totalSpeechSeconds - a.totalSpeechSeconds);

    const hostStreamerId = findHostStreamerId(roomId, registry);
    const appearedStreamerIds = [];
    speakers.forEach((speaker) => {
        const streamerId = mapSpeakerLabelToStreamerId(speaker.label, registry);
        if (!streamerId) {
            if (speaker.isUnknown) {
                console.log(`[ASR] speaker summary: 跳过未映射 speaker=${speaker.label}`);
            } else {
                console.log(`[ASR] speaker summary: speaker=${speaker.label} 未命中 streamerRegistry`);
            }
            return;
        }
        const enoughSpeech = speaker.totalSpeechSeconds >= Number(multiConfig.minSpeechSeconds || 0);
        const scoreMissing = speaker.avgScore === null;
        const enoughScore = scoreMissing || speaker.avgScore >= Number(multiConfig.minSpeakerScore || 0);
        if (!enoughSpeech) {
            console.log(`[ASR] speaker summary: 过滤 ${speaker.label} -> ${streamerId}，出声 ${speaker.totalSpeechSeconds.toFixed(1)}s < ${multiConfig.minSpeechSeconds}s`);
            return;
        }
        if (!enoughScore) {
            console.log(`[ASR] speaker summary: 过滤 ${speaker.label} -> ${streamerId}，avgScore ${speaker.avgScore} < ${multiConfig.minSpeakerScore}`);
            return;
        }
        if (scoreMissing) {
            console.log(`[ASR] speaker summary: ${speaker.label} -> ${streamerId} 无 speaker_score，仅按出声时长通过`);
        } else {
            console.log(`[ASR] speaker summary: ${speaker.label} -> ${streamerId} 通过，出声 ${speaker.totalSpeechSeconds.toFixed(1)}s, avgScore=${speaker.avgScore}`);
        }
        if (!appearedStreamerIds.includes(streamerId)) {
            appearedStreamerIds.push(streamerId);
        }
    });

    const extraAppearedStreamerIds = appearedStreamerIds
        .filter(streamerId => streamerId !== hostStreamerId)
        .slice(0, Math.max(0, Number(multiConfig.maxExtraCharacters || 0)));

    return {
        input: context.input || context.mediaPath || null,
        backend: result?.backend || 'unknown',
        hostRoomId: roomId ? String(roomId) : null,
        speakers,
        appearedStreamerIds,
        extraAppearedStreamerIds
    };
}

function writeAsrSpeakersSidecar(result, srtPath, config = {}, context = {}) {
    try {
        if (!srtPath) {
            return null;
        }
        const summary = summarizeAsrSpeakers(result, config, {
            ...context,
            input: context.input || context.mediaPath
        });
        const parsed = path.parse(srtPath);
        const sidecarPath = path.join(parsed.dir, `${parsed.name}.asr_speakers.json`);
        fs.writeFileSync(sidecarPath, JSON.stringify(summary, null, 2), 'utf8');
        console.log(`[ASR] speaker summary sidecar: ${path.basename(sidecarPath)} (extra=${summary.extraAppearedStreamerIds.join(', ') || 'none'})`);
        return sidecarPath;
    } catch (error) {
        console.warn(`⚠️  写入 ASR speaker summary 失败，继续后续流程: ${error.message}`);
        return null;
    }
}

function writeSrt(result, srtPath, subtitleConfig = {}) {
    const cfg = { ...DEFAULT_SUBTITLE_CONFIG, ...subtitleConfig };
    const lines = [];
    let lineIndex = 1;
    result.segments.forEach((segment) => {
        const correctedText = applyCorrectionsToText(segment.text, cfg.corrections);
        const content = cfg.strip_punctuation ? stripSubtitlePunctuation(correctedText) : correctedText;
        if (!content) {
            return;
        }
        const text = content;
        const wrapped = splitTextByLength(text, cfg.max_chars_per_line).join('\n');
        lines.push(String(lineIndex));
        lines.push(`${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}`);
        lines.push(wrapped);
        lines.push('');
        lineIndex += 1;
    });
    fs.writeFileSync(srtPath, `${lines.join('\n').trim()}\n`, 'utf8');
}

function wrapSpeakerReviewText(prefix, content, maxChars) {
    const safeMax = Math.max(Number(maxChars) || 30, prefix.length + 4);
    const contentMax = Math.max(4, safeMax - prefix.length);
    const parts = splitTextByLength(content, contentMax);
    if (parts.length === 0) {
        return [prefix.trim()];
    }
    return [
        `${prefix}${parts[0]}`,
        ...parts.slice(1)
    ];
}

function getUniqueSpeakerLabels(result) {
    return new Set(
        Array.isArray(result?.segments)
            ? result.segments.map(segment => String(segment.speaker || '').trim()).filter(Boolean)
            : []
    );
}

function writeSpeakerReviewSrt(result, srtPath, subtitleConfig = {}) {
    try {
        const uniqueSpeakers = getUniqueSpeakerLabels(result);
        if (uniqueSpeakers.size === 0 || !srtPath) {
            return null;
        }

        const parsed = path.parse(srtPath);
        const reviewPath = path.join(parsed.dir, `${parsed.name}.speaker.srt`);
        const cfg = { ...DEFAULT_SUBTITLE_CONFIG, ...subtitleConfig };
        const lines = [];
        let lineIndex = 1;

        result.segments.forEach((segment) => {
            const correctedText = applyCorrectionsToText(segment.text, cfg.corrections);
            const content = cfg.strip_punctuation ? stripSubtitlePunctuation(correctedText) : correctedText;
            if (!content) {
                return;
            }
            const speaker = String(segment.speaker || 'UNKNOWN').trim() || 'UNKNOWN';
            const score = segment.speaker_score === undefined || segment.speaker_score === null || segment.speaker_score === ''
                ? ''
                : ` ${Number(segment.speaker_score).toFixed(2)}`;
            const prefix = `[${speaker}${score}] `;
            const wrapped = wrapSpeakerReviewText(prefix, content, cfg.max_chars_per_line).join('\n');
            lines.push(String(lineIndex));
            lines.push(`${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}`);
            lines.push(wrapped);
            lines.push('');
            lineIndex += 1;
        });

        fs.writeFileSync(reviewPath, `${lines.join('\n').trim()}\n`, 'utf8');
        console.log(`[ASR] speaker review SRT: ${path.basename(reviewPath)} (speakers=${Array.from(uniqueSpeakers).join(', ')})`);
        return reviewPath;
    } catch (error) {
        console.warn(`⚠️  写入 speaker review SRT 失败，继续后续流程: ${error.message}`);
        return null;
    }
}

function resolvePythonCommand(options = {}) {
    const executable = String(
        options.python_executable
        || options.pythonPath
        || options.python_path
        || process.env.ASR_PYTHON
        || 'python'
    ).trim() || 'python';
    const args = Array.isArray(options.python_args)
        ? options.python_args.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    return { executable, args };
}

function normalizePathForMap(value) {
    return String(value || '').replace(/\\/g, '/');
}

function getPythonPathMap(options = {}) {
    const raw = options.python_path_map || options.pythonPathMap || [];
    if (Array.isArray(raw)) {
        return raw
            .map((item) => {
                if (Array.isArray(item) && item.length >= 2) {
                    return { from: item[0], to: item[1] };
                }
                if (item && typeof item === 'object') {
                    return { from: item.from || item.source, to: item.to || item.target };
                }
                return null;
            })
            .filter(item => item && item.from && item.to)
            .map(item => ({
                from: normalizePathForMap(item.from),
                to: normalizePathForMap(item.to)
            }))
            .sort((a, b) => b.from.length - a.from.length);
    }
    if (raw && typeof raw === 'object') {
        return Object.entries(raw)
            .map(([from, to]) => ({ from: normalizePathForMap(from), to: normalizePathForMap(to) }))
            .sort((a, b) => b.from.length - a.from.length);
    }
    return [];
}

function translatePythonPath(value, options = {}) {
    if (typeof value !== 'string' || !value.trim()) {
        return value;
    }
    const normalized = normalizePathForMap(value);
    const normalizedLower = normalized.toLowerCase();
    for (const mapping of getPythonPathMap(options)) {
        const from = mapping.from;
        const fromLower = from.toLowerCase();
        if (normalizedLower === fromLower || normalizedLower.startsWith(fromLower)) {
            const suffix = normalized.slice(from.length).replace(/^\/+/, '');
            const target = mapping.to.replace(/\/+$/, '');
            return suffix ? `${target}/${suffix}` : target;
        }
    }
    return value;
}

function shouldTranslatePayloadKey(key) {
    return /(^|_)(path|file)$/i.test(String(key || '')) || /Path$|File$/i.test(String(key || ''));
}

function translatePythonPayloadPaths(value, options = {}, key = '') {
    if (Array.isArray(value)) {
        return value.map(item => translatePythonPayloadPaths(item, options, key));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entryValue]) => [
                entryKey,
                translatePythonPayloadPaths(entryValue, options, entryKey)
            ])
        );
    }
    if (typeof value === 'string' && shouldTranslatePayloadKey(key)) {
        return translatePythonPath(value, options);
    }
    return value;
}

function runJsonPython(scriptPath, payload, label = 'ASR backend') {
    return new Promise((resolve, reject) => {
        let settled = false;
        const pythonCommand = resolvePythonCommand(payload);
        const pythonScriptPath = translatePythonPath(scriptPath, payload);
        const child = spawn(pythonCommand.executable, [...pythonCommand.args, pythonScriptPath], {
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
                reject(new Error(`${label} 超时: ${timeoutSeconds}s`));
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
                if (line.startsWith('[ASR]')) {
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
            if (stderrLineBuffer.startsWith('[ASR]')) {
                process.stdout.write(`${stderrLineBuffer}\n`);
            }
            if (code !== 0) {
                reject(new Error(`${label} failed with exit code ${code}: ${stderr || stdout}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (error) {
                reject(new Error(`${label} 输出不是有效 JSON: ${error.message}\nstdout=${stdout}\nstderr=${stderr}`));
            }
        });
        child.stdin.end(JSON.stringify(translatePythonPayloadPaths(payload, payload)));
    });
}

function buildHotwordWords(runtimeOptions = {}) {
    if (Array.isArray(runtimeOptions.hotwordWords)) {
        return runtimeOptions.hotwordWords.map(word => String(word || '').trim()).filter(Boolean);
    }
    if (Array.isArray(runtimeOptions.hotwordTokens)) {
        return runtimeOptions.hotwordTokens.map(item => String(item?.word || '').trim()).filter(Boolean);
    }
    if (Array.isArray(runtimeOptions.hotwords)) {
        return runtimeOptions.hotwords.map(item => String(item?.word || item || '').trim()).filter(Boolean);
    }
    return [];
}

async function transcribeFunAsrBackend(mediaPath, config = {}, runtimeOptions = {}, backend = 'sensevoice') {
    const asrConfig = getAsrConfig(config);
    const scriptPath = path.join(__dirname, '..', 'python', 'sensevoice_transcribe.py');
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`ASR Python script not found at: ${scriptPath}`);
    }
    const backendConfig = asrConfig[backend] || asrConfig.sensevoice;
    const nanoLike = backend === 'fun_asr_nano' || backend === 'fun_asr_nano_vllm';
    const options = {
        ...backendConfig,
        backend,
        audio_path: mediaPath,
        hotwords: nanoLike
            ? buildHotwordWords(runtimeOptions)
            : (runtimeOptions.hotwords || []),
        hotword: runtimeOptions.hotwordTextWeighted || runtimeOptions.hotwordText || '',
        hotword_unweighted: runtimeOptions.hotwordText || ''
    };
    const label = backend === 'fun_asr_nano_vllm'
        ? 'Fun-ASR-Nano vLLM backend'
        : (backend === 'fun_asr_nano' ? 'Fun-ASR-Nano backend' : 'SenseVoice backend');
    return runJsonPython(scriptPath, options, label);
}

async function transcribeSenseVoice(mediaPath, config = {}, runtimeOptions = {}) {
    return transcribeFunAsrBackend(mediaPath, config, runtimeOptions, 'sensevoice');
}

async function transcribeFunAsrNano(mediaPath, config = {}, runtimeOptions = {}) {
    return transcribeFunAsrBackend(mediaPath, config, runtimeOptions, 'fun_asr_nano');
}

async function transcribeFunAsrNanoVllm(mediaPath, config = {}, runtimeOptions = {}) {
    return transcribeFunAsrBackend(mediaPath, config, runtimeOptions, 'fun_asr_nano_vllm');
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
    resolveStreamerRegistry,
    mapSpeakerLabelToStreamerId,
    summarizeAsrSpeakers,
    writeAsrSpeakersSidecar,
    writeSpeakerReviewSrt,
    writeSrt,
    resolvePythonCommand,
    translatePythonPath,
    translatePythonPayloadPaths,
    transcribeSenseVoice,
    transcribeFunAsrNano,
    transcribeFunAsrNanoVllm,
    formatTimestamp,
    parseTimestamp,
    stripSubtitlePunctuation
};

