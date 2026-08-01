const fs = require('fs');
const http = require('http');
const path = require('path');

const SCHEMA_VERSION = 1;
const DEFAULT_LOOKBACK_HOURS = 36;
const DEFAULT_NEARBY_HOURS = 6;
const DEFAULT_FUTURE_GRACE_MINUTES = 15;
const DEFAULT_DYNAMIC_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_DYNAMIC_CONTENT_CHARS = 320;

function normalizeText(value) {
    return String(value || '').replace(/\s+/gu, ' ').trim();
}

function truncateText(value, maxChars = MAX_DYNAMIC_CONTENT_CHARS) {
    const chars = Array.from(normalizeText(value));
    if (chars.length <= maxChars) {
        return chars.join('');
    }
    return `${chars.slice(0, maxChars).join('')}...`;
}

function parseRecordingInfo(highlightPath) {
    const filename = path.basename(String(highlightPath || ''));
    const baseName = filename.replace(/_AI_HIGHLIGHT\.txt$/iu, '');
    const match = baseName.match(/^录制-(\d+)-(\d{8})-(\d{6})-([^-]+)-(.+)$/u);
    if (!match) {
        return {
            roomId: null,
            liveTitle: null,
            recordingStartTime: null,
            recordingStartLocalTime: null,
            titleSource: null
        };
    }

    const [, roomId, datePart, timePart, , rawTitle] = match;
    const liveTitle = normalizeText(rawTitle.replace(/_merged(?:_\d+)?$/iu, '')) || null;
    const localIso = [
        datePart.slice(0, 4), '-', datePart.slice(4, 6), '-', datePart.slice(6, 8),
        'T', timePart.slice(0, 2), ':', timePart.slice(2, 4), ':', timePart.slice(4, 6),
        '+08:00'
    ].join('');
    const start = new Date(localIso);

    return {
        roomId,
        liveTitle,
        recordingStartTime: Number.isNaN(start.getTime()) ? null : start.toISOString(),
        recordingStartLocalTime: `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)} ${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)} UTC+8`,
        titleSource: liveTitle ? 'recording-filename' : null
    };
}

function getLiveContextPath(highlightPath) {
    const parsed = path.parse(highlightPath);
    const baseName = parsed.name.replace(/_AI_HIGHLIGHT$/iu, '');
    return path.join(parsed.dir, `${baseName}_LIVE_CONTEXT.json`);
}

function getRoomSettings(config, roomId) {
    if (!roomId) {
        return {};
    }
    const key = String(roomId);
    return config?.ai?.roomSettings?.[key] || config?.roomSettings?.[key] || {};
}

function findStreamerConfig(config, roomId) {
    if (!roomId) {
        return null;
    }
    const key = String(roomId);
    const registry = config?.ai?.streamerRegistry || config?.streamerRegistry || {};
    return Object.values(registry).find((streamer) => (
        Array.isArray(streamer?.roomIds) && streamer.roomIds.some((value) => String(value) === key)
    )) || null;
}

function getRoomUid(config, roomId) {
    const roomSettings = getRoomSettings(config, roomId);
    if (roomSettings.uid) {
        return String(roomSettings.uid);
    }

    const streamer = findStreamerConfig(config, roomId);
    if (streamer?.uid) {
        return String(streamer.uid);
    }

    const anchors = config?.bilibili?.anchors || {};
    const anchor = Object.values(anchors).find((item) => String(item?.roomId || '') === String(roomId || ''));
    return anchor?.uid ? String(anchor.uid) : null;
}

function getContentHints(config, roomId) {
    const roomSettings = getRoomSettings(config, roomId);
    const streamer = findStreamerConfig(config, roomId);
    const rawHints = roomSettings.contentHints ?? streamer?.contentHints;
    if (Array.isArray(rawHints)) {
        return rawHints.map(normalizeText).filter(Boolean);
    }
    const hint = normalizeText(rawHints);
    return hint ? [hint] : [];
}

function filterRecentDynamics(dynamics, recordingStartTime, options = {}) {
    const limit = Number(options.limit || DEFAULT_DYNAMIC_LIMIT);
    const lookbackHours = Number(options.lookbackHours || DEFAULT_LOOKBACK_HOURS);
    const nearbyHours = Number(options.nearbyHours || DEFAULT_NEARBY_HOURS);
    const futureGraceMinutes = Number(options.futureGraceMinutes || DEFAULT_FUTURE_GRACE_MINUTES);
    const startMs = new Date(recordingStartTime || '').getTime();

    let candidates = (Array.isArray(dynamics) ? dynamics : []).map((item) => {
        const publishMs = new Date(item?.publishTime || '').getTime();
        const content = truncateText(item?.content);
        if (!content || Number.isNaN(publishMs)) {
            return null;
        }
        return {
            id: String(item?.id || ''),
            publishTime: new Date(publishMs).toISOString(),
            content,
            _publishMs: publishMs
        };
    }).filter(Boolean);

    if (!Number.isNaN(startMs)) {
        const lowerBound = startMs - lookbackHours * 60 * 60 * 1000;
        const upperBound = startMs + futureGraceMinutes * 60 * 1000;
        candidates = candidates.filter((item) => item._publishMs >= lowerBound && item._publishMs <= upperBound);
    }

    candidates.sort((a, b) => b._publishMs - a._publishMs);

    if (!Number.isNaN(startMs)) {
        const nearbyLowerBound = startMs - nearbyHours * 60 * 60 * 1000;
        const nearby = candidates.filter((item) => item._publishMs >= nearbyLowerBound);
        if (nearby.length > 0) {
            candidates = nearby;
        }
    }

    return candidates.slice(0, Math.max(0, limit)).map(({ _publishMs, ...item }) => item);
}

function requestJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, { headers: { Accept: 'application/json' } }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                body += chunk;
            });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new Error(`动态接口返回无效JSON: ${error.message}`));
                }
            });
        });

        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`动态接口超时 (${timeoutMs}ms)`));
        });
        request.on('error', reject);
    });
}

async function fetchRecentDynamics(config, roomId, recordingStartTime, options = {}) {
    const uid = getRoomUid(config, roomId);
    if (!uid) {
        return { status: 'skipped-no-uid', uid: null, dynamics: [] };
    }

    const contextConfig = config?.ai?.generationContext?.recentDynamics || {};
    if (contextConfig.enabled === false) {
        return { status: 'disabled', uid, dynamics: [] };
    }

    const port = Number(contextConfig.localApiPort || config?.webhook?.port || process.env.PORT || 15121);
    const timeoutMs = Number(contextConfig.timeoutMs || DEFAULT_TIMEOUT_MS);
    const fetcher = options.fetcher || requestJson;
    const url = `http://127.0.0.1:${port}/api/bilibili/dynamics/${encodeURIComponent(uid)}`;
    const payload = await fetcher(url, timeoutMs);
    if (!payload?.success || !Array.isArray(payload?.data?.dynamics)) {
        throw new Error(payload?.error || '动态接口返回结构无效');
    }

    return {
        status: 'success',
        uid,
        dynamics: filterRecentDynamics(payload.data.dynamics, recordingStartTime, {
            limit: contextConfig.limit,
            lookbackHours: contextConfig.lookbackHours,
            nearbyHours: contextConfig.nearbyHours,
            futureGraceMinutes: contextConfig.futureGraceMinutes
        })
    };
}

function buildBaseContext(highlightPath, roomId, config) {
    const recording = parseRecordingInfo(highlightPath);
    const finalRoomId = String(roomId || recording.roomId || '') || null;
    return {
        schemaVersion: SCHEMA_VERSION,
        roomId: finalRoomId,
        liveTitle: recording.liveTitle,
        recordingStartTime: recording.recordingStartTime,
        recordingStartLocalTime: recording.recordingStartLocalTime,
        contentHints: getContentHints(config, finalRoomId),
        recentDynamics: [],
        sources: {
            liveTitle: recording.titleSource,
            recentDynamics: 'not-requested'
        },
        generatedAt: new Date().toISOString()
    };
}

function writeLiveGenerationContext(highlightPath, context) {
    const outputPath = getLiveContextPath(highlightPath);
    fs.writeFileSync(outputPath, JSON.stringify(context, null, 2), 'utf8');
    return outputPath;
}

async function prepareLiveGenerationContext(highlightPath, roomId, config, options = {}) {
    const context = buildBaseContext(highlightPath, roomId, config);
    try {
        const dynamicResult = await fetchRecentDynamics(
            config,
            context.roomId,
            context.recordingStartTime,
            options
        );
        context.recentDynamics = dynamicResult.dynamics;
        context.sources.recentDynamics = dynamicResult.status;
        if (dynamicResult.uid) {
            context.anchorUid = dynamicResult.uid;
        }
    } catch (error) {
        context.sources.recentDynamics = 'failed';
        context.recentDynamicsError = String(error?.message || error);
    }

    const outputPath = writeLiveGenerationContext(highlightPath, context);
    return { context, outputPath };
}

function loadLiveGenerationContext(highlightPath, roomId, config) {
    const contextPath = getLiveContextPath(highlightPath);
    if (fs.existsSync(contextPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
            if (parsed && parsed.schemaVersion === SCHEMA_VERSION) {
                return parsed;
            }
        } catch (error) {
            console.warn(`⚠️  读取直播事实上下文失败，将仅使用文件名: ${error.message}`);
        }
    }
    return buildBaseContext(highlightPath, roomId, config);
}

function formatLiveGenerationContext(context) {
    if (!context) {
        return '';
    }

    const lines = [
        '【本场事实上下文（高优先级约束）】',
        `- 直播标题：${context.liveTitle || '未取得'}`,
        `- 开播时间（北京时间）：${context.recordingStartLocalTime || '未取得'}。判断早/午/晚必须以此为准，不能因主播说“刚起床”等作息描述改写客观时段。`
    ];

    if (Array.isArray(context.recentDynamics) && context.recentDynamics.length > 0) {
        lines.push('- 开播前近期动态（仅用于确认本场主题/预告，不得把动态里未在本场发生的事写成直播内容）：');
        context.recentDynamics.forEach((item) => {
            lines.push(`  - [${item.publishTime}] ${item.content}`);
        });
    }

    if (Array.isArray(context.contentHints) && context.contentHints.length > 0) {
        lines.push('- 主播内容歧义提示（只用于解释本场已经出现的词句，不得主动补写）：');
        context.contentHints.forEach((hint) => lines.push(`  - ${hint}`));
    }

    lines.push(
        '【事实证据优先级】直播标题与明确语音 > 同场弹幕 > 开播前近期动态 > 稳定人设、兴趣、口头禅与模型常识。',
        '稳定人设、兴趣和口头禅不是本场发生的事实，只能消解正文中确实存在且没有冲突证据的歧义；一旦高优先级证据指向其他游戏、活动或人物，必须服从高优先级证据。',
        '当直播标题、明确语音或开播前动态中至少两类证据一致确认具体游戏/活动时，回复和画面应自然点明该名称，不要退化成泛化的“某游戏”“抽卡界面”；只有证据不足或互相冲突时才使用中性描述。',
        '不得因为人物设定中的某款游戏或口头禅，擅自给本场添加对应游戏界面、角色、Logo或台词。游戏/活动无法确认时使用中性描述，不猜具体作品。'
    );

    return lines.join('\n');
}

module.exports = {
    SCHEMA_VERSION,
    parseRecordingInfo,
    getLiveContextPath,
    getRoomUid,
    getContentHints,
    filterRecentDynamics,
    buildBaseContext,
    prepareLiveGenerationContext,
    loadLiveGenerationContext,
    formatLiveGenerationContext
};
