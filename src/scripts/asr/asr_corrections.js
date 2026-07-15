let Jieba = null;
let bundledJiebaDict = null;
try {
    ({ Jieba } = require('@node-rs/jieba'));
    ({ dict: bundledJiebaDict } = require('@node-rs/jieba/dict'));
} catch {
    Jieba = null;
    bundledJiebaDict = null;
}

const DEFAULT_CONTEXTUAL_NEARBY_WORDS = ['主播', '直播', '开播', 'SUI', '岁己', '饼干岁', 'VR', 'VirtuaReal'];
const DEFAULT_CONTEXT_WINDOW_TOKENS = 6;
const DEFAULT_AMBIGUOUS_NEARBY_WORDS = DEFAULT_CONTEXTUAL_NEARBY_WORDS;
const WHITESPACE_PATTERN = /\s/;
const PUNCTUATION_PATTERN = /^[\p{P}\p{S}]+$/u;
const WORDLIKE_CHAR_PATTERN = /[\p{L}\p{N}]/u;
const ASCII_WORDLIKE_CHAR_PATTERN = /[A-Za-z0-9]/;
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
const jiebaInstances = new Map();

function normalizeHotwordEntry(entry) {
    if (typeof entry === 'string') {
        const word = entry.trim();
        return word ? {
            word,
            weight: undefined,
            aliases: [],
            contextual_aliases: [],
            ambiguous_aliases: [],
            hotword_terms: [],
            alias_hotwords: true,
            correction_to: word,
            context_window_tokens: undefined,
            match_mode: undefined,
            boundary_sensitive: true
        } : null;
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
    const ambiguousAliases = Array.isArray(entry.ambiguous_aliases)
        ? entry.ambiguous_aliases.map(alias => String(alias || '').trim()).filter(Boolean)
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
        ambiguous_aliases: ambiguousAliases,
        hotword_terms: hotwordTerms,
        alias_hotwords: entry.alias_hotwords !== false && entry.aliases_as_hotwords !== false,
        correction_to: correctionTo,
        protect: entry.protect === false ? false : undefined,
        require_nearby: Array.isArray(entry.require_nearby)
            ? entry.require_nearby.map(value => String(value || '').trim()).filter(Boolean)
            : undefined,
        context_window_tokens: Number(entry.context_window_tokens) > 0 ? Number(entry.context_window_tokens) : undefined,
        match_mode: typeof entry.match_mode === 'string' ? entry.match_mode : undefined,
        boundary_sensitive: entry.boundary_sensitive !== false
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
    existing.ambiguous_aliases = Array.from(new Set([...(existing.ambiguous_aliases || []), ...normalized.ambiguous_aliases]));
    existing.hotword_terms = Array.from(new Set([...(existing.hotword_terms || []), ...normalized.hotword_terms]));
    existing.alias_hotwords = existing.alias_hotwords !== false && normalized.alias_hotwords !== false;
    if (!existing.correction_to && normalized.correction_to) {
        existing.correction_to = normalized.correction_to;
    }
    if (!existing.require_nearby && normalized.require_nearby) {
        existing.require_nearby = normalized.require_nearby;
    }
    if (existing.protect !== false && normalized.protect === false) {
        existing.protect = false;
    }
    if (!existing.context_window_tokens && normalized.context_window_tokens) {
        existing.context_window_tokens = normalized.context_window_tokens;
    }
    if (!existing.match_mode && normalized.match_mode) {
        existing.match_mode = normalized.match_mode;
    }
    if (existing.boundary_sensitive !== false && normalized.boundary_sensitive === false) {
        existing.boundary_sensitive = false;
    }
}

function addCorrection(target, from, to, extra = {}) {
    const source = String(from || '').trim();
    const replacement = String(to || '').trim();
    if (!source || !replacement || source === replacement) {
        return;
    }
    const excludeWhen = Array.isArray(extra.exclude_when)
        ? extra.exclude_when.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    const excludePattern = Array.isArray(extra.exclude_pattern)
        ? extra.exclude_pattern.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    const protect = extra.protect === false ? false : undefined;
    const existing = target.get(source);
    const mergedExcludeWhen = Array.from(new Set([...(existing?.exclude_when || []), ...excludeWhen]));
    const mergedExcludePattern = Array.from(new Set([...(existing?.exclude_pattern || []), ...excludePattern]));
    const next = {
        from: source,
        to: replacement,
        ...existing,
        ...extra,
        protect: existing?.protect === false || protect === false ? false : undefined
    };
    if (mergedExcludeWhen.length > 0) {
        next.exclude_when = mergedExcludeWhen;
    } else {
        delete next.exclude_when;
    }
    if (mergedExcludePattern.length > 0) {
        next.exclude_pattern = mergedExcludePattern;
    } else {
        delete next.exclude_pattern;
    }
    target.set(source, next);
}

function getCorrectionExclusions(exclusions, from) {
    if (!exclusions || typeof exclusions !== 'object' || Array.isArray(exclusions)) {
        return [];
    }
    const values = exclusions[from];
    return Array.isArray(values)
        ? values.map(value => String(value || '').trim()).filter(Boolean)
        : [];
}

function getCorrectionExcludePatterns(excludePatterns, from) {
    if (!excludePatterns || typeof excludePatterns !== 'object' || Array.isArray(excludePatterns)) {
        return [];
    }
    const values = excludePatterns[from];
    return Array.isArray(values)
        ? values.map(value => String(value || '').trim()).filter(Boolean)
        : [];
}

function addSafeCorrections(target, corrections, exclusions = {}, excludePatterns = {}) {
    if (!corrections) {
        return;
    }
    if (Array.isArray(corrections)) {
        corrections.forEach((item) => {
            if (Array.isArray(item) && item.length >= 2) {
                addCorrection(target, item[0], item[1], {
                    exclude_when: getCorrectionExclusions(exclusions, item[0]),
                    exclude_pattern: getCorrectionExcludePatterns(excludePatterns, item[0])
                });
            } else if (item && typeof item === 'object') {
                const from = item.from || item.alias || item.source || item.wrong;
                addCorrection(
                    target,
                    from,
                    item.to || item.word || item.target || item.correct,
                    {
                        exclude_when: item.exclude_when || getCorrectionExclusions(exclusions, from),
                        exclude_pattern: item.exclude_pattern || getCorrectionExcludePatterns(excludePatterns, from),
                        protect: item.protect
                    }
                );
            }
        });
        return;
    }
    if (typeof corrections === 'object') {
        Object.entries(corrections).forEach(([from, to]) => addCorrection(target, from, to, {
            exclude_when: getCorrectionExclusions(exclusions, from),
            exclude_pattern: getCorrectionExcludePatterns(excludePatterns, from)
        }));
    }
}

function addContextualCorrections(target, corrections, exclusions = {}, excludePatterns = {}) {
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
        const from = item.from || item.alias || item.source || item.wrong;
        const extra = {
            require_nearby: requireNearby,
            exclude_when: item.exclude_when || getCorrectionExclusions(exclusions, from),
            exclude_pattern: item.exclude_pattern || getCorrectionExcludePatterns(excludePatterns, from)
        };
        const contextWindowTokens = Number(item.context_window_tokens);
        if (Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
            extra.context_window_tokens = contextWindowTokens;
        }
        if (item.match_mode) {
            extra.match_mode = item.match_mode;
        }
        addCorrection(target, from, item.to || item.word || item.target || item.correct, extra);
    });
}

function addAmbiguousCorrections(target, corrections, exclusions = {}, excludePatterns = {}) {
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
        const from = item.from || item.alias || item.source || item.wrong;
        addCorrection(target, from, item.to || item.word || item.target || item.correct, {
            require_nearby: requireNearby,
            context_window_tokens: Number(item.context_window_tokens) > 0 ? Number(item.context_window_tokens) : undefined,
            match_mode: item.match_mode || 'token',
            boundary_sensitive: item.boundary_sensitive !== false,
            exclude_when: item.exclude_when || getCorrectionExclusions(exclusions, from),
            exclude_pattern: item.exclude_pattern || getCorrectionExcludePatterns(excludePatterns, from)
        });
    });
}

function addCorrections(targets, corrections) {
    if (!corrections) {
        return;
    }
    if (corrections.safe || corrections.contextual || corrections.ambiguous) {
        addSafeCorrections(targets.safe, corrections.safe, corrections.exclude_when, corrections.exclude_pattern);
        addContextualCorrections(targets.contextual, corrections.contextual, corrections.exclude_when, corrections.exclude_pattern);
        addAmbiguousCorrections(targets.ambiguous, corrections.ambiguous, corrections.exclude_when, corrections.exclude_pattern);
        return;
    }
    addSafeCorrections(targets.safe, corrections);
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

function resolveAsrHotwords(config, context = {}, helpers = {}) {
    const getAsrConfig = helpers.getAsrConfig;
    const matchesRule = helpers.matchesRule;
    if (typeof getAsrConfig !== 'function' || typeof matchesRule !== 'function') {
        throw new Error('resolveAsrHotwords requires getAsrConfig() and matchesRule() helpers');
    }

    const asrConfig = getAsrConfig(config);
    const hotwordsByWord = new Map();
    const hotwordTokens = new Map();
    const hotwordPromptTokens = new Map();
    const corrections = {
        safe: new Map(),
        contextual: new Map(),
        ambiguous: new Map()
    };

    asrConfig.common_hotwords.forEach(entry => addHotword(hotwordsByWord, entry));
    addCorrections(corrections, asrConfig.corrections);

    const rawRegistry = config.ai?.streamerRegistry || {};
    const roomId = String(context.room_id || context.roomId || '').trim();
    if (roomId) {
        for (const entry of Object.values(rawRegistry)) {
            const roomIds = Array.isArray(entry.roomIds) ? entry.roomIds.map(r => String(r)) : [];
            if (roomIds.includes(roomId)) {
                if (entry.displayName) {
                    addHotword(hotwordsByWord, { word: entry.displayName });
                }
                if (Array.isArray(entry.speakerLabels)) {
                    entry.speakerLabels.forEach(label => {
                        const normalizedLabel = String(label).trim();
                        if (normalizedLabel && normalizedLabel !== entry.displayName) {
                            addHotword(hotwordsByWord, { word: normalizedLabel });
                        }
                    });
                }
                break;
            }
        }
    }

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
            addCorrection(corrections.safe, alias, correctionTo, { protect: entry.protect });
        });
        (entry.hotword_terms || []).forEach((term) => {
            addHotwordToken(hotwordTokens, term, entry.weight);
            addHotwordToken(hotwordPromptTokens, term, entry.weight);
        });
        (entry.contextual_aliases || []).forEach(alias => addCorrection(corrections.contextual, alias, correctionTo, {
            require_nearby: entry.require_nearby || DEFAULT_CONTEXTUAL_NEARBY_WORDS
        }));
        (entry.ambiguous_aliases || []).forEach(alias => addCorrection(corrections.ambiguous, alias, correctionTo, {
            require_nearby: entry.require_nearby || DEFAULT_AMBIGUOUS_NEARBY_WORDS,
            context_window_tokens: entry.context_window_tokens || DEFAULT_CONTEXT_WINDOW_TOKENS,
            match_mode: entry.match_mode || 'token',
            boundary_sensitive: entry.boundary_sensitive !== false
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
            contextual: Array.from(corrections.contextual.values()),
            ambiguous: Array.from(corrections.ambiguous.values())
        },
        hotwordText: hotwordTokenList.map(entry => entry.word).join(' '),
        hotwordTextWeighted: hotwordTokenList
            .map(entry => entry.weight !== undefined ? `${entry.word} ${entry.weight}` : entry.word)
            .join('\n')
    };
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCorrectionsForApply(corrections = []) {
    if (Array.isArray(corrections)) {
        const safe = new Map();
        addSafeCorrections(safe, corrections);
        return { safe: Array.from(safe.values()), contextual: [], ambiguous: [] };
    }
    if (corrections && typeof corrections === 'object') {
        const safe = new Map();
        const contextual = new Map();
        const ambiguous = new Map();
        addSafeCorrections(safe, corrections.safe, corrections.exclude_when, corrections.exclude_pattern);
        addContextualCorrections(contextual, corrections.contextual, corrections.exclude_when, corrections.exclude_pattern);
        addAmbiguousCorrections(ambiguous, corrections.ambiguous, corrections.exclude_when, corrections.exclude_pattern);
        return {
            safe: Array.from(safe.values()),
            contextual: Array.from(contextual.values()),
            ambiguous: Array.from(ambiguous.values())
        };
    }
    return { safe: [], contextual: [], ambiguous: [] };
}

function makeCorrectionStats() {
    return new Map();
}

function compactCorrectionSample(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90);
}

function recordCorrectionStats(stats, correction, type, count, before, after) {
    if (!stats || count <= 0) {
        return;
    }
    const key = `${type} ${correction.from} ${correction.to}`;
    const existing = stats.get(key) || {
        type,
        from: correction.from,
        to: correction.to,
        count: 0,
        examples: []
    };
    existing.count += count;
    if (existing.examples.length < 3) {
        existing.examples.push({
            before: compactCorrectionSample(before),
            after: compactCorrectionSample(after)
        });
    }
    stats.set(key, existing);
}

function logCorrectionStats(stats, label = 'ASR corrections') {
    if (!stats || stats.size === 0) {
        return;
    }
    const entries = Array.from(stats.values()).sort((a, b) => b.count - a.count);
    const total = entries.reduce((sum, item) => sum + item.count, 0);
    console.log(`[${label}] applied ${total} replacements across ${entries.length} rules`);
    entries.slice(0, 12).forEach((item) => {
        const sample = item.examples[0]
            ? ` sample="${item.examples[0].before}" => "${item.examples[0].after}"`
            : '';
        console.log(`[${label}] ${item.type} ${item.from} -> ${item.to} x${item.count}${sample}`);
    });
    if (entries.length > 12) {
        console.log(`[${label}] ... ${entries.length - 12} more rules omitted`);
    }
}

function isProtectedByExcludedTerm(text, matched, offset, excludedTerms = []) {
    const sourceText = String(text || '');
    const matchStart = Number(offset) || 0;
    const matchEnd = matchStart + String(matched || '').length;
    return excludedTerms.some((term) => {
        const protectedText = String(term || '');
        if (!protectedText) {
            return false;
        }
        let searchStart = 0;
        while (searchStart <= sourceText.length) {
            const protectedStart = sourceText.indexOf(protectedText, searchStart);
            if (protectedStart === -1) {
                return false;
            }
            const protectedEnd = protectedStart + protectedText.length;
            if (protectedStart < matchEnd && matchStart < protectedEnd) {
                return true;
            }
            searchStart = protectedStart + 1;
        }
        return false;
    });
}

function isProtectedByExcludePattern(text, matched, offset, excludePatterns = []) {
    const matchStart = Number(offset) || 0;
    const matchEnd = matchStart + String(matched || '').length;
    return excludePatterns.some((patternText) => {
        let pattern;
        try {
            pattern = new RegExp(patternText, 'g');
        } catch {
            return false;
        }
        let protectedMatch;
        while ((protectedMatch = pattern.exec(text)) !== null) {
            const protectedText = String(protectedMatch[0] || '');
            const protectedStart = protectedMatch.index;
            const protectedEnd = protectedStart + protectedText.length;
            if (protectedStart < matchEnd && matchStart < protectedEnd) {
                return true;
            }
            if (protectedText.length === 0) {
                pattern.lastIndex += 1;
            }
        }
        return false;
    });
}

function isProtectedByTokenBoundary(context, start, end) {
    if (!context || !Array.isArray(context.tokens) || !Array.isArray(context.tokenIndexByChar)) {
        return false;
    }
    const safeStart = Math.max(0, Number(start) || 0);
    const safeEnd = Math.max(safeStart + 1, Number(end) || 0);
    if (safeStart >= context.tokenIndexByChar.length) {
        return false;
    }
    const firstTokenIndex = context.tokenIndexByChar[safeStart];
    const lastTokenIndex = context.tokenIndexByChar[Math.min(safeEnd - 1, context.tokenIndexByChar.length - 1)];
    if (firstTokenIndex < 0 || lastTokenIndex < 0 || firstTokenIndex !== lastTokenIndex) {
        return false;
    }
    const token = context.tokens[firstTokenIndex];
    if (!token || token.isWhitespace || token.isPunctuation) {
        return false;
    }
    return safeStart > token.start || safeEnd < token.end;
}

function isEmbeddedInLargerLatinTerm(text, start, end) {
    const source = String(text || '');
    const previousChar = start > 0 ? source[start - 1] : '';
    const nextChar = end < source.length ? source[end] : '';
    return ASCII_WORDLIKE_CHAR_PATTERN.test(previousChar) || ASCII_WORDLIKE_CHAR_PATTERN.test(nextChar);
}

function shouldProtectSafeCorrection(text, start, end, correction, context = null) {
    if (correction?.protect === false) {
        return false;
    }
    const matched = String(text || '').slice(start, end);
    if (!matched) {
        return false;
    }
    if (!NON_ASCII_PATTERN.test(matched)) {
        return isEmbeddedInLargerLatinTerm(text, start, end);
    }
    return isProtectedByTokenBoundary(context, start, end);
}

function applyCorrectionList(text, corrections = [], stats = null, type = 'safe', options = {}) {
    let output = String(text || '');
    const normalized = Array.isArray(corrections) ? corrections : [];
    const ordered = normalized
        .filter(item => item && item.from && item.to)
        .sort((a, b) => String(b.from).length - String(a.from).length);
    const protectedTerms = type === 'safe' ? collectSafeProtectionTerms(ordered) : [];
    const sharedContextText = options.contextText === undefined || options.contextText === null
        ? null
        : String(options.contextText || '');
    const sharedBaseOffset = sharedContextText === null
        ? 0
        : Math.max(0, Number(options.baseOffset) || 0);
    for (const correction of ordered) {
        const pattern = new RegExp(escapeRegExp(correction.from), 'g');
        const before = output;
        const excludedTerms = Array.isArray(correction.exclude_when)
            ? correction.exclude_when.map(value => String(value || '').trim()).filter(Boolean)
            : [];
        const excludePatterns = Array.isArray(correction.exclude_pattern)
            ? correction.exclude_pattern.map(value => String(value || '').trim()).filter(Boolean)
            : [];
        const boundaryContext = correction.protect === false
            ? null
            : options.boundaryContext || createTranscriptContext(sharedContextText ?? before, { protectedTerms });
        let count = 0;
        output = before.replace(pattern, (matched, offset, wholeText) => {
            const start = Number(offset) || 0;
            const end = start + String(matched || '').length;
            const protectionText = sharedContextText ?? wholeText;
            const protectionStart = sharedContextText === null ? start : sharedBaseOffset + start;
            if (isProtectedByExcludedTerm(protectionText, matched, protectionStart, excludedTerms)) {
                return matched;
            }
            if (excludePatterns.length > 0 && isProtectedByExcludePattern(protectionText, matched, protectionStart, excludePatterns)) {
                return matched;
            }
            if (type === 'safe' && shouldProtectSafeCorrection(
                protectionText,
                protectionStart,
                protectionStart + (end - start),
                correction,
                boundaryContext
            )) {
                return matched;
            }
            count += 1;
            return correction.to;
        });
        if (count === 0) {
            continue;
        }
        recordCorrectionStats(stats, correction, type, count, before, output);
    }
    return output;
}

function applyCorrectionListToSegments(texts = [], corrections = [], stats = null, type = 'safe') {
    const normalized = Array.isArray(corrections) ? corrections : [];
    const ordered = normalized
        .filter(item => item && item.from && item.to)
        .sort((a, b) => String(b.from).length - String(a.from).length);
    let outputTexts = Array.isArray(texts)
        ? texts.map(text => String(text || ''))
        : [];
    if (ordered.length === 0 || outputTexts.length === 0) {
        return outputTexts;
    }

    const protectedTerms = type === 'safe' ? collectSafeProtectionTerms(ordered) : [];
    for (const correction of ordered) {
        const sharedContextText = outputTexts.join('');
        const boundaryContext = type === 'safe' && correction.protect !== false
            ? createTranscriptContext(sharedContextText, { protectedTerms })
            : null;
        let baseOffset = 0;
        outputTexts = outputTexts.map((text) => {
            const currentOffset = baseOffset;
            baseOffset += text.length;
            return applyCorrectionList(text, [correction], stats, type, {
                contextText: sharedContextText,
                baseOffset: currentOffset,
                boundaryContext
            });
        });
    }
    return outputTexts;
}

function collectSafeProtectionTerms(corrections = []) {
    const protectedTerms = new Set();
    const normalized = Array.isArray(corrections) ? corrections : [];
    normalized.forEach((correction) => {
        if (!correction || correction.protect === false) {
            return;
        }
        const source = String(correction.from || '').trim();
        if (!source || !NON_ASCII_PATTERN.test(source)) {
            return;
        }
        protectedTerms.add(source);
    });
    return Array.from(protectedTerms).sort((a, b) => b.length - a.length);
}

function buildSafeProtectionJieba(text, protectedTerms = []) {
    if (!Jieba || !bundledJiebaDict) {
        return null;
    }
    const source = String(text || '');
    const extraTerms = Array.isArray(protectedTerms)
        ? protectedTerms.map(term => String(term || '').trim()).filter(term => term && NON_ASCII_PATTERN.test(term))
        : [];
    const cacheKey = extraTerms.join(' ') || '__base__';
    if (jiebaInstances.has(cacheKey)) {
        return jiebaInstances.get(cacheKey);
    }
    try {
        const customDict = extraTerms.length > 0
            ? Buffer.from(`\n${extraTerms.map(term => `${term} 100000 n`).join('\n')}\n`, 'utf8')
            : Buffer.alloc(0);
        const dictBuffer = customDict.length > 0
            ? Buffer.concat([Buffer.from(bundledJiebaDict), customDict])
            : bundledJiebaDict;
        const instance = Jieba.withDict(dictBuffer);
        jiebaInstances.set(cacheKey, instance);
        return instance;
    } catch {
        jiebaInstances.set(cacheKey, null);
        return null;
    }
}

function getJiebaInstance() {
    if (!Jieba || !bundledJiebaDict) {
        return null;
    }
    const cacheKey = '__base__';
    if (jiebaInstances.has(cacheKey)) {
        return jiebaInstances.get(cacheKey);
    }
    try {
        const instance = Jieba.withDict(bundledJiebaDict);
        jiebaInstances.set(cacheKey, instance);
        return instance;
    } catch {
        jiebaInstances.set(cacheKey, null);
        return null;
    }
}

function createToken(text, start, end) {
    const value = String(text.slice(start, end));
    const isWhitespace = WHITESPACE_PATTERN.test(value);
    const isPunctuation = !isWhitespace && PUNCTUATION_PATTERN.test(value);
    return {
        text: value,
        start,
        end,
        isWhitespace,
        isPunctuation,
        isContextToken: !isWhitespace && !isPunctuation,
        contextIndex: null
    };
}

function buildFallbackTokens(text) {
    const tokens = [];
    const source = String(text || '');
    const pattern = /[A-Za-z0-9]+|\s+|./gu;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        const tokenText = match[0] || '';
        const start = match.index;
        const end = start + tokenText.length;
        tokens.push(createToken(source, start, end));
    }
    return tokens;
}

function buildJiebaTokens(text, instance) {
    const source = String(text || '');
    const rawTokens = instance && typeof instance.cut === 'function'
        ? instance.cut(source, false)
        : [];
    if (!Array.isArray(rawTokens) || rawTokens.length === 0) {
        return [];
    }
    const tokens = [];
    let cursor = 0;
    rawTokens.forEach((rawToken) => {
        const tokenText = String(rawToken || '');
        if (!tokenText) {
            return;
        }
        const start = source.indexOf(tokenText, cursor);
        if (start === -1) {
            return;
        }
        if (start > cursor) {
            const gapText = source.slice(cursor, start);
            const gapPattern = /[A-Za-z0-9]+|\s+|./gu;
            let gapMatch;
            while ((gapMatch = gapPattern.exec(gapText)) !== null) {
                const gapStart = cursor + gapMatch.index;
                const gapEnd = gapStart + gapMatch[0].length;
                tokens.push(createToken(source, gapStart, gapEnd));
            }
        }
        const end = start + tokenText.length;
        tokens.push(createToken(source, start, end));
        cursor = end;
    });
    if (cursor < source.length) {
        const tailText = source.slice(cursor);
        const tailPattern = /[A-Za-z0-9]+|\s+|./gu;
        let tailMatch;
        while ((tailMatch = tailPattern.exec(tailText)) !== null) {
            const tailStart = cursor + tailMatch.index;
            const tailEnd = tailStart + tailMatch[0].length;
            tokens.push(createToken(source, tailStart, tailEnd));
        }
    }
    return tokens;
}

function createTranscriptContext(text, options = {}) {
    const source = String(text || '');
    const explicitJieba = options.jiebaInstance || null;
    const protectedTerms = Array.isArray(options.protectedTerms) ? options.protectedTerms : [];
    const jieba = explicitJieba || buildSafeProtectionJieba(source, protectedTerms) || getJiebaInstance();
    const tokens = (jieba ? buildJiebaTokens(source, jieba) : []).filter(token => token.end > token.start);
    const effectiveTokens = tokens.length > 0 ? tokens : buildFallbackTokens(source);
    const tokenIndexByChar = new Array(source.length).fill(-1);
    let contextIndex = 0;
    effectiveTokens.forEach((token, tokenIndex) => {
        if (token.isContextToken) {
            token.contextIndex = contextIndex;
            contextIndex += 1;
        }
        for (let i = token.start; i < token.end && i < tokenIndexByChar.length; i += 1) {
            tokenIndexByChar[i] = tokenIndex;
        }
    });
    return {
        text: source,
        tokens: effectiveTokens,
        tokenIndexByChar
    };
}

function getContextSpanFromRange(context, start, end) {
    const safeStart = Math.max(0, Number(start) || 0);
    const safeEnd = Math.max(safeStart + 1, Number(end) || 0);
    let first = null;
    let last = null;
    for (let index = safeStart; index < safeEnd && index < context.tokenIndexByChar.length; index += 1) {
        const tokenIndex = context.tokenIndexByChar[index];
        if (tokenIndex < 0) {
            continue;
        }
        const token = context.tokens[tokenIndex];
        if (!token || !token.isContextToken || token.contextIndex === null) {
            continue;
        }
        if (first === null) {
            first = token.contextIndex;
        }
        last = token.contextIndex;
    }
    if (first === null || last === null) {
        return null;
    }
    return { start: first, end: last };
}

function getNearbyKeywords(correction) {
    return Array.isArray(correction?.require_nearby)
        ? correction.require_nearby.map(value => String(value || '').trim()).filter(Boolean)
        : [];
}

function hasAnyNearbyKeyword(text, keywords = []) {
    return keywords.length > 0 && keywords.some(keyword => String(text || '').includes(keyword));
}

function distanceBetweenSpans(a, b) {
    if (a.end < b.start) {
        return b.start - a.end;
    }
    if (b.end < a.start) {
        return a.start - b.end;
    }
    return 0;
}

function hasNearbyKeywordWithinWindow(context, matchStart, matchEnd, keywords = [], window = DEFAULT_CONTEXT_WINDOW_TOKENS) {
    const keywordList = keywords.map(keyword => String(keyword || '').trim()).filter(Boolean);
    if (keywordList.length === 0) {
        return false;
    }
    const matchSpan = getContextSpanFromRange(context, matchStart, matchEnd);
    if (!matchSpan) {
        return false;
    }
    const safeWindow = Math.max(0, Number(window) || 0);
    return keywordList.some((keyword) => {
        let searchStart = 0;
        while (searchStart <= context.text.length) {
            const occurrenceStart = context.text.indexOf(keyword, searchStart);
            if (occurrenceStart === -1) {
                return false;
            }
            const occurrenceEnd = occurrenceStart + keyword.length;
            const keywordSpan = getContextSpanFromRange(context, occurrenceStart, occurrenceEnd);
            if (keywordSpan && distanceBetweenSpans(matchSpan, keywordSpan) <= safeWindow) {
                return true;
            }
            searchStart = occurrenceStart + Math.max(1, keyword.length);
        }
        return false;
    });
}

function hasWordlikeNeighborsOnBothSides(text, start, end) {
    const source = String(text || '');
    const previousChar = start > 0 ? source[start - 1] : '';
    const nextChar = end < source.length ? source[end] : '';
    return WORDLIKE_CHAR_PATTERN.test(previousChar) && WORDLIKE_CHAR_PATTERN.test(nextChar);
}

function shouldApplyAmbiguousCorrection(context, localText, localStart, localEnd, correction, baseOffset = 0) {
    const keywords = getNearbyKeywords(correction);
    if (keywords.length === 0) {
        return false;
    }
    if (correction.boundary_sensitive !== false && hasWordlikeNeighborsOnBothSides(localText, localStart, localEnd)) {
        return false;
    }
    const absoluteStart = Math.max(0, Number(baseOffset) || 0) + localStart;
    const absoluteEnd = absoluteStart + (localEnd - localStart);
    const matchMode = String(correction.match_mode || 'token').trim().toLowerCase();
    const tokenWindow = Number(correction.context_window_tokens) > 0
        ? Number(correction.context_window_tokens)
        : DEFAULT_CONTEXT_WINDOW_TOKENS;
    const hasLocalNearby = hasNearbyKeywordWithinWindow(context, absoluteStart, absoluteEnd, keywords, tokenWindow);
    if (matchMode === 'transcript') {
        return hasAnyNearbyKeyword(context.text, keywords);
    }
    return hasLocalNearby;
}

function applyAmbiguousCorrectionList(text, corrections = [], options = {}) {
    const sourceText = String(text || '');
    const ordered = (Array.isArray(corrections) ? corrections : [])
        .filter(item => item && item.from && item.to)
        .sort((a, b) => String(b.from).length - String(a.from).length);
    if (ordered.length === 0 || !sourceText) {
        return sourceText;
    }
    const transcriptContext = options.transcriptContext || createTranscriptContext(options.transcriptText || sourceText);
    const baseOffset = Math.max(0, Number(options.baseOffset) || 0);
    const candidates = [];

    ordered.forEach((correction, priority) => {
        const pattern = new RegExp(escapeRegExp(correction.from), 'g');
        const excludedTerms = Array.isArray(correction.exclude_when)
            ? correction.exclude_when.map(value => String(value || '').trim()).filter(Boolean)
            : [];
        const excludePatterns = Array.isArray(correction.exclude_pattern)
            ? correction.exclude_pattern.map(value => String(value || '').trim()).filter(Boolean)
            : [];
        let match;
        while ((match = pattern.exec(sourceText)) !== null) {
            const matched = String(match[0] || '');
            const start = match.index;
            const end = start + matched.length;
            if (isProtectedByExcludedTerm(sourceText, matched, start, excludedTerms)) {
                continue;
            }
            if (excludePatterns.length > 0 && isProtectedByExcludePattern(sourceText, matched, start, excludePatterns)) {
                continue;
            }
            if (!shouldApplyAmbiguousCorrection(transcriptContext, sourceText, start, end, correction, baseOffset)) {
                continue;
            }
            candidates.push({
                start,
                end,
                replacement: correction.to,
                correction,
                priority
            });
            if (matched.length === 0) {
                pattern.lastIndex += 1;
            }
        }
    });

    if (candidates.length === 0) {
        return sourceText;
    }

    candidates.sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start;
        const aLength = a.end - a.start;
        const bLength = b.end - b.start;
        if (aLength !== bLength) return bLength - aLength;
        return a.priority - b.priority;
    });

    const accepted = [];
    let coveredUntil = -1;
    candidates.forEach((candidate) => {
        if (candidate.start < coveredUntil) {
            return;
        }
        accepted.push(candidate);
        coveredUntil = candidate.end;
    });

    if (accepted.length === 0) {
        return sourceText;
    }

    let cursor = 0;
    let output = '';
    const counts = new Map();
    accepted.forEach((candidate) => {
        output += sourceText.slice(cursor, candidate.start);
        output += candidate.replacement;
        cursor = candidate.end;
        const key = `${candidate.correction.from} ${candidate.correction.to}`;
        counts.set(key, {
            correction: candidate.correction,
            count: (counts.get(key)?.count || 0) + 1
        });
    });
    output += sourceText.slice(cursor);

    if (options.stats) {
        counts.forEach(({ correction, count }) => {
            recordCorrectionStats(options.stats, correction, 'ambiguous', count, sourceText, output);
        });
    }
    return output;
}

function resolveApplicableCorrections(sourceText, corrections = []) {
    const grouped = normalizeCorrectionsForApply(corrections);
    const safeText = applyCorrectionList(sourceText, grouped.safe);
    const contextual = grouped.contextual.filter((item) => {
        const keywords = getNearbyKeywords(item);
        return keywords.length > 0 && hasAnyNearbyKeyword(safeText, keywords);
    });
    const contextualText = applyCorrectionList(safeText, contextual);
    const ambiguous = grouped.ambiguous.filter((item) => {
        const keywords = getNearbyKeywords(item);
        if (keywords.length === 0) {
            return false;
        }
        const matchMode = String(item.match_mode || 'token').trim().toLowerCase();
        if (matchMode === 'transcript') {
            return hasAnyNearbyKeyword(contextualText, keywords);
        }
        return true;
    });
    return {
        safe: grouped.safe,
        contextual,
        ambiguous
    };
}

function applyResolvedCorrections(text, applicable, options = {}) {
    const stats = options.stats || null;
    const localText = String(text || '');
    const safeAndContextual = applyCorrectionList(
        applyCorrectionList(localText, applicable.safe, stats, 'safe'),
        applicable.contextual,
        stats,
        'contextual'
    );
    if (!Array.isArray(applicable.ambiguous) || applicable.ambiguous.length === 0) {
        return safeAndContextual;
    }
    return applyAmbiguousCorrectionList(safeAndContextual, applicable.ambiguous, {
        stats,
        transcriptContext: options.transcriptContext,
        transcriptText: options.transcriptText,
        baseOffset: options.baseOffset || 0
    });
}

function applyCorrectionsToText(text, corrections = []) {
    const applicable = resolveApplicableCorrections(String(text || ''), corrections);
    const preAmbiguous = applyCorrectionList(
        applyCorrectionList(String(text || ''), applicable.safe),
        applicable.contextual
    );
    const transcriptContext = createTranscriptContext(preAmbiguous);
    return applyResolvedCorrections(String(text || ''), applicable, {
        transcriptContext,
        transcriptText: preAmbiguous,
        baseOffset: 0
    });
}

function getSegmentTokenRanges(texts = []) {
    const sourceText = texts.map(text => String(text || '')).join('');
    const context = createTranscriptContext(sourceText);
    const ranges = [];
    let offset = 0;
    texts.forEach((text) => {
        const value = String(text || '');
        ranges.push({
            start: offset,
            end: offset + value.length
        });
        offset += value.length;
    });
    return { sourceText, context, ranges };
}

function applyCorrectionsToSegments(segments = [], corrections = [], stats = null) {
    const texts = Array.isArray(segments)
        ? segments.map(segment => String(segment?.text || ''))
        : [];
    const applicable = resolveApplicableCorrections(texts.join(''), corrections);
    if (applicable.safe.length === 0 && applicable.contextual.length === 0 && applicable.ambiguous.length === 0) {
        return texts;
    }
    const safeTexts = applyCorrectionListToSegments(texts, applicable.safe, stats, 'safe');
    const preAmbiguousTexts = applyCorrectionListToSegments(safeTexts, applicable.contextual, stats, 'contextual');
    if (applicable.ambiguous.length === 0) {
        return preAmbiguousTexts;
    }
    const { sourceText: transcriptText, context: transcriptContext, ranges } = getSegmentTokenRanges(preAmbiguousTexts);
    return preAmbiguousTexts.map((text, index) => applyAmbiguousCorrectionList(text, applicable.ambiguous, {
        stats,
        transcriptContext,
        transcriptText,
        baseOffset: ranges[index]?.start || 0
    }));
}

function applyCorrectionsToAsrResult(result, corrections = []) {
    const grouped = normalizeCorrectionsForApply(corrections);
    if (grouped.safe.length === 0 && grouped.contextual.length === 0 && grouped.ambiguous.length === 0) {
        return result;
    }
    const stats = makeCorrectionStats();
    const segments = Array.isArray(result?.segments) ? result.segments : [];
    const correctedTexts = applyCorrectionsToSegments(segments, corrections, stats);
    const correctedSegments = segments.map((segment, index) => ({
        ...segment,
        text: correctedTexts[index] || ''
    }));
    logCorrectionStats(stats, 'ASR corrections');
    return {
        ...result,
        segments: correctedSegments
    };
}

module.exports = {
    DEFAULT_CONTEXTUAL_NEARBY_WORDS,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    DEFAULT_AMBIGUOUS_NEARBY_WORDS,
    resolveAsrHotwords,
    normalizeCorrectionsForApply,
    resolveApplicableCorrections,
    applyResolvedCorrections,
    applyCorrectionsToText,
    applyCorrectionsToSegments,
    applyCorrectionsToAsrResult,
    makeCorrectionStats,
    logCorrectionStats
};
