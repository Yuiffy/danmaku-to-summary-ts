const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const aiTextGenerator = require('./ai_text_generator');
const configLoader = require('./config-loader');
const fullLiveContext = require('./full_live_context');
const liveGenerationContext = require('./live_generation_context');

const LIVE_CONTENT_SCHEMA_VERSION = 1;
const LIVE_CONTENT_PROMPT_VERSION = 1;
const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_PROMPT_CACHE_ROLLOUT_PERCENT = 100;
const DEFAULT_FAILURE_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000;
const ACTIVITY_TYPES = new Set([
    'chat',
    'singing',
    'watch_movie',
    'watch_anime',
    'watch_bilibili',
    'game',
    'other'
]);

function sha256Text(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function getLiveContentSummaryPath(highlightPath) {
    const parsed = path.parse(String(highlightPath || ''));
    if (!parsed.name) {
        throw new Error('highlightPath is required');
    }
    const baseName = parsed.name.replace(/_AI_HIGHLIGHT$/iu, '');
    return path.join(parsed.dir, `${baseName}_LIVE_CONTENT.json`);
}

function getFullLiveContextExperiment(config, roomId) {
    if (!roomId) return null;
    const roomConfig = config?.ai?.roomSettings?.[String(roomId)] || null;
    const experiment = roomConfig?.fullLiveContextExperiment;
    return experiment?.enabled === true ? experiment : null;
}

function isExperimentTaskEnabled(experiment, task) {
    return Boolean(
        experiment
        && Array.isArray(experiment.tasks)
        && experiment.tasks.map(value => String(value)).includes(String(task))
    );
}

function getSummaryDeliveryMode(experiment) {
    return experiment?.summaryDeliveryMode === 'attach_if_ready'
        ? 'attach_if_ready'
        : 'separate';
}

function loadFullContextPayload(highlightPath, explicitPath = null) {
    if (!explicitPath) {
        return fullLiveContext.loadFullLiveContextSidecar(highlightPath);
    }
    if (!fs.existsSync(explicitPath)) {
        return null;
    }
    const payload = JSON.parse(fs.readFileSync(explicitPath, 'utf8'));
    if (Number(payload?.schemaVersion) !== fullLiveContext.FULL_LIVE_CONTEXT_SCHEMA_VERSION) {
        throw new Error(`unsupported full live context schemaVersion: ${payload?.schemaVersion}`);
    }
    if (sha256Text(payload.sourceText) !== payload.sourceSha256) {
        throw new Error(`full live context source hash mismatch: ${explicitPath}`);
    }
    if (sha256Text(payload.sharedPrefix) !== payload.sharedPrefixSha256) {
        throw new Error(`full live context shared prefix hash mismatch: ${explicitPath}`);
    }
    return payload;
}

function buildLiveContentSummaryPrompt(sharedPrefix) {
    if (!String(sharedPrefix || '').startsWith(liveGenerationContext.SHARED_PROMPT_CACHE_START)) {
        throw new Error('sharedPrefix is missing the prompt-cache start marker');
    }
    if (!String(sharedPrefix).endsWith(liveGenerationContext.SHARED_PROMPT_CACHE_END)) {
        throw new Error('sharedPrefix is missing the prompt-cache end marker');
    }

    const taskSuffix = [
        `【本场直播极简梗概任务 v${LIVE_CONTENT_PROMPT_VERSION}】`,
        '通读上方整场字幕和弹幕，提取可供每日搬运汇总使用的结构化梗概。',
        '只依据明确证据，不补充常识，不把观众弹幕说成主播实际做过的事。',
        'overview：一句极简中文概括本场做了什么，例如“杂谈、唱歌、看B站视频、玩《游戏名》”；不超过80字。',
        'activityTypes：只能从 chat、singing、watch_movie、watch_anime、watch_bilibili、game、other 中选择并去重。',
        'songs：只列本场明确实际演唱或播放表演的歌曲名；仅提到、点歌未唱、无法确认歌名时不要列。',
        'games：只列本场明确实际游玩的游戏名；只聊天提到时不要列。',
        'topics：列出0-10个今天明确聊到的极简话题，每项尽量4-14字，例如“妈妈做火烧云”“男人打架”“最喜欢的前辈”；纯歌回或没有明确话题时可为空数组，不要写空泛的“日常杂谈”。',
        '确实没有歌曲或游戏时必须使用空数组。无法确认的项目宁可不写，不要猜。',
        '只输出一个合法 JSON 对象，不要 Markdown、代码围栏、解释或额外文字：',
        '{"overview":"杂谈、唱歌、玩《xx》","activityTypes":["chat","singing","game"],"songs":[],"games":["xx"],"topics":["话题一","话题二"]}'
    ].join('\n');
    return `${sharedPrefix}\n\n${taskSuffix}`;
}

function parseJsonObject(text) {
    const raw = String(text || '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) {
        throw new Error(`AI did not return a JSON object: ${raw.slice(0, 180)}`);
    }
    return JSON.parse(raw.slice(start, end + 1));
}

function truncateChars(value, maxChars) {
    return Array.from(String(value || '').replace(/\s+/gu, ' ').trim())
        .slice(0, maxChars)
        .join('');
}

function normalizeStringArray(value, field, options = {}) {
    if (!Array.isArray(value)) {
        throw new Error(`${field} must be an array`);
    }
    const maxItems = Math.max(0, Number(options.maxItems) || 20);
    const maxItemChars = Math.max(1, Number(options.maxItemChars) || 48);
    const items = value.map(item => {
        if (typeof item !== 'string') {
            throw new Error(`${field} must contain strings only`);
        }
        return truncateChars(item, maxItemChars);
    }).filter(Boolean);
    return Array.from(new Set(items)).slice(0, maxItems);
}

function normalizeLiveContent(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('live content summary must be an object');
    }
    const overview = truncateChars(raw.overview, 120);
    if (!overview) {
        throw new Error('overview is required');
    }
    const activityTypes = normalizeStringArray(raw.activityTypes, 'activityTypes', {
        maxItems: ACTIVITY_TYPES.size,
        maxItemChars: 24
    });
    const invalidType = activityTypes.find(item => !ACTIVITY_TYPES.has(item));
    if (invalidType) {
        throw new Error(`unsupported activity type: ${invalidType}`);
    }
    return {
        overview,
        activityTypes,
        songs: normalizeStringArray(raw.songs, 'songs', { maxItems: 40, maxItemChars: 80 }),
        games: normalizeStringArray(raw.games, 'games', { maxItems: 12, maxItemChars: 80 }),
        topics: normalizeStringArray(raw.topics, 'topics', { maxItems: 12, maxItemChars: 32 })
    };
}

function numberOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractGenerationMetrics(meta = {}) {
    const attempts = Array.isArray(meta.attempts) ? meta.attempts : [];
    const successfulAttempt = [...attempts].reverse().find(attempt => attempt?.status === 'success') || {};
    const promptTokens = numberOrNull(successfulAttempt.promptTokens);
    const cachedTokens = numberOrNull(successfulAttempt.cachedTokens);
    const uncachedPromptTokens = promptTokens !== null && cachedTokens !== null
        ? Math.max(0, promptTokens - cachedTokens)
        : null;
    const cacheHitRatio = promptTokens && cachedTokens !== null
        ? Number((cachedTokens / promptTokens).toFixed(4))
        : null;
    return {
        provider: meta.provider || successfulAttempt.provider || 'unknown',
        model: meta.model || successfulAttempt.model || 'unknown',
        fallback: Boolean(meta.fallback),
        promptTokens,
        cachedTokens,
        uncachedPromptTokens,
        cacheWriteTokens: numberOrNull(successfulAttempt.cacheWriteTokens),
        completionTokens: numberOrNull(successfulAttempt.completionTokens),
        reasoningTokens: numberOrNull(successfulAttempt.reasoningTokens),
        totalTokens: numberOrNull(successfulAttempt.totalTokens),
        cacheHitRatio,
        explicitPromptCache: successfulAttempt.explicitPromptCache || null,
        sharedPromptCacheKey: successfulAttempt.sharedPromptCacheKey || null,
        sharedPromptPrefixChars: numberOrNull(successfulAttempt.sharedPromptPrefixChars),
        attempts
    };
}

function logGenerationMetrics(metrics, roomId) {
    const ratio = metrics.cacheHitRatio === null
        ? 'unknown'
        : `${(metrics.cacheHitRatio * 100).toFixed(1)}%`;
    console.log(
        `[AI_USAGE][live-content-summary][room=${roomId || 'unknown'}] `
        + `provider=${metrics.provider} model=${metrics.model} `
        + `prompt=${metrics.promptTokens ?? 'unknown'} cached=${metrics.cachedTokens ?? 'unknown'} `
        + `uncached=${metrics.promptTokens !== null && metrics.cachedTokens !== null
            ? Math.max(0, metrics.promptTokens - metrics.cachedTokens)
            : 'unknown'} `
        + `cacheWrite=${metrics.cacheWriteTokens ?? 'unknown'} completion=${metrics.completionTokens ?? 'unknown'} `
        + `reasoning=${metrics.reasoningTokens ?? 'unknown'} total=${metrics.totalTokens ?? 'unknown'} `
        + `cacheHitRatio=${ratio}`
    );
}

function readReusableSummary(outputPath, sourceSha256, sharedPrefixSha256, options = {}) {
    if (!fs.existsSync(outputPath)) return null;
    try {
        const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        const sourceMatches = (
            existing?.schemaVersion === LIVE_CONTENT_SCHEMA_VERSION
            && existing?.source?.sourceSha256 === sourceSha256
            && existing?.source?.sharedPrefixSha256 === sharedPrefixSha256
            && existing?.source?.promptVersion === LIVE_CONTENT_PROMPT_VERSION
        );
        if (sourceMatches && existing?.status === 'success') {
            return existing;
        }
        const cooldownMs = Math.max(
            0,
            Number(options.failureRetryCooldownMs ?? DEFAULT_FAILURE_RETRY_COOLDOWN_MS) || 0
        );
        const generatedAtMs = Date.parse(String(existing?.generatedAt || ''));
        if (
            sourceMatches
            && existing?.status === 'failed'
            && cooldownMs > 0
            && Number.isFinite(generatedAtMs)
            && Date.now() - generatedAtMs < cooldownMs
        ) {
            return existing;
        }
    } catch (error) {
        console.warn(`读取既有直播梗概失败，将重新生成: ${error.message}`);
    }
    return null;
}

function writeJsonAtomic(outputPath, payload) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, outputPath);
}

function acquireLock(lockPath) {
    try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
        fs.closeSync(fd);
        return true;
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
            const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
            if (ageMs > LOCK_STALE_MS) {
                fs.unlinkSync(lockPath);
                return acquireLock(lockPath);
            }
        } catch (statError) {
            if (statError?.code === 'ENOENT') return acquireLock(lockPath);
        }
        return false;
    }
}

function releaseLock(lockPath) {
    try {
        fs.unlinkSync(lockPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.warn(`删除直播梗概锁失败: ${error.message}`);
        }
    }
}

function buildSourceMetadata(fullContextPayload) {
    return {
        coverage: 'full_srt_and_merged_danmaku',
        sourceSha256: fullContextPayload.sourceSha256,
        sharedPrefixSha256: fullContextPayload.sharedPrefixSha256,
        fullLiveSharedPrefixVersion: fullContextPayload.fullLiveSharedPrefixVersion,
        promptVersion: LIVE_CONTENT_PROMPT_VERSION,
        counts: fullContextPayload.counts || null
    };
}

async function generateLiveContentSummary(options = {}) {
    const highlightPath = options.highlightPath;
    const roomId = String(options.roomId || '').trim() || null;
    const config = options.config || configLoader.getConfig();
    const experiment = options.experiment || getFullLiveContextExperiment(config, roomId);
    if (!isExperimentTaskEnabled(experiment, 'summary')) {
        return null;
    }

    const outputPath = options.outputPath || getLiveContentSummaryPath(highlightPath);
    const fullContextPayload = loadFullContextPayload(highlightPath, options.fullLiveContextPath);
    if (!fullContextPayload) {
        throw new Error('full live context sidecar is not ready');
    }
    const reusable = readReusableSummary(
        outputPath,
        fullContextPayload.sourceSha256,
        fullContextPayload.sharedPrefixSha256,
        experiment
    );
    if (reusable) {
        console.log(
            reusable.status === 'success'
                ? `复用同源直播梗概: ${path.basename(outputPath)}`
                : `同源直播梗概仍在失败冷却期，跳过重复请求: ${path.basename(outputPath)}`
        );
        return { outputPath, payload: reusable, reused: true };
    }

    const lockPath = `${outputPath}.lock`;
    if (!acquireLock(lockPath)) {
        console.log(`直播梗概已由其他进程生成中: ${path.basename(outputPath)}`);
        return { outputPath, payload: null, reused: false, pending: true };
    }

    const source = buildSourceMetadata(fullContextPayload);
    const prompt = buildLiveContentSummaryPrompt(fullContextPayload.sharedPrefix);
    const generationAttempts = [];
    try {
        const maxAttempts = Math.max(1, Number(experiment.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
        const model = experiment.model || DEFAULT_MODEL;
        const promptCacheRolloutPercent = Number.isFinite(Number(experiment.promptCacheRolloutPercent))
            ? Number(experiment.promptCacheRolloutPercent)
            : DEFAULT_PROMPT_CACHE_ROLLOUT_PERCENT;
        const generateText = options.generateText || aiTextGenerator.generateTextWithDaiYu;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const attemptPrompt = attempt === 1
                    ? prompt
                    : `${prompt}\n\n【格式纠错】上一版不是合法结构。所有五个字段都必须存在，songs、games、topics、activityTypes 必须是 JSON 数组。`;
                const result = await generateText(attemptPrompt, {
                    primaryModel: model,
                    wordLimit: 800,
                    timeoutMs: Number(experiment.timeoutMs) || 600000,
                    maxTokens: Number(experiment.maxTokens) || 2000,
                    thinkingBudgetTokens: Number(experiment.thinkingBudgetTokens) || 2000,
                    fallbackModelsEnabled: false,
                    promptCacheRolloutPercent
                });
                generationAttempts.push(...(Array.isArray(result?.meta?.attempts) ? result.meta.attempts : []));
                const content = normalizeLiveContent(parseJsonObject(result?.text));
                const generation = extractGenerationMetrics({
                    ...(result?.meta || {}),
                    attempts: generationAttempts
                });
                const payload = {
                    schemaVersion: LIVE_CONTENT_SCHEMA_VERSION,
                    status: 'success',
                    roomId,
                    source,
                    content,
                    generation,
                    generatedAt: new Date().toISOString()
                };
                writeJsonAtomic(outputPath, payload);
                logGenerationMetrics(generation, roomId);
                console.log(`直播梗概已保存: ${path.basename(outputPath)}`);
                return { outputPath, payload, reused: false };
            } catch (error) {
                generationAttempts.push({
                    provider: 'liveContentSummary',
                    model: experiment.model || DEFAULT_MODEL,
                    status: 'failure',
                    error: String(error?.message || error).slice(0, 500),
                    summaryAttempt: attempt
                });
                console.warn(`直播梗概生成失败 (${attempt}/${maxAttempts}): ${error.message}`);
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        const lastFailure = [...generationAttempts].reverse().find(item => item?.status === 'failure');
        const failurePayload = {
            schemaVersion: LIVE_CONTENT_SCHEMA_VERSION,
            status: 'failed',
            roomId,
            source,
            error: lastFailure?.error || 'live content summary generation failed',
            generation: {
                provider: 'daiYu',
                model: experiment.model || DEFAULT_MODEL,
                attempts: generationAttempts
            },
            generatedAt: new Date().toISOString()
        };
        writeJsonAtomic(outputPath, failurePayload);
        return { outputPath, payload: failurePayload, reused: false };
    } finally {
        releaseLock(lockPath);
    }
}

module.exports = {
    LIVE_CONTENT_SCHEMA_VERSION,
    LIVE_CONTENT_PROMPT_VERSION,
    ACTIVITY_TYPES,
    getLiveContentSummaryPath,
    getFullLiveContextExperiment,
    isExperimentTaskEnabled,
    getSummaryDeliveryMode,
    loadFullContextPayload,
    buildLiveContentSummaryPrompt,
    parseJsonObject,
    normalizeLiveContent,
    extractGenerationMetrics,
    readReusableSummary,
    generateLiveContentSummary
};
