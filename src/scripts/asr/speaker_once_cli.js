#!/usr/bin/env node

const configLoader = require('../config-loader');
const registry = require('./speaker_once_registry');

function normalizeLookup(value) {
    return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

function resolveRoom(target, config = configLoader.getConfig()) {
    const raw = String(target || '').trim();
    if (/^\d+$/.test(raw)) {
        return { roomId: raw, roomName: null, key: null };
    }
    if (!raw) throw new Error('请提供直播间 ID 或主播名称');

    const registryConfig = config.ai?.streamerRegistry || config.streamerRegistry || {};
    const needle = normalizeLookup(raw);
    const matches = [];
    for (const [key, entry] of Object.entries(registryConfig)) {
        const roomIds = Array.isArray(entry?.roomIds) ? entry.roomIds.map(String) : [];
        const labels = [
            key,
            entry?.displayName,
            entry?.aiClipName,
            ...(entry?.searchTags || []),
            ...(entry?.mentionLabels || []),
            ...(entry?.speakerLabels || [])
        ].filter(Boolean).map(normalizeLookup);
        if (labels.includes(needle) && roomIds.length > 0) {
            matches.push({ roomId: roomIds[0], roomName: entry.displayName || key, key });
        }
    }
    const unique = matches.filter((item, index, items) =>
        items.findIndex(candidate => candidate.roomId === item.roomId) === index
    );
    if (unique.length === 0) throw new Error(`未在 streamerRegistry 找到主播: ${raw}`);
    if (unique.length > 1) {
        throw new Error(`主播名称不唯一: ${raw} -> ${unique.map(item => `${item.roomName}(${item.roomId})`).join(', ')}`);
    }
    return unique[0];
}

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        const key = arg.slice(2);
        if (key === 'json') {
            flags.json = true;
            continue;
        }
        flags[key] = argv[index + 1];
        index += 1;
    }
    return { positional, flags };
}

function parseStartAt(value) {
    const raw = String(value || '').trim();
    const localMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    const parsed = localMatch
        ? new Date(
            Number(localMatch[1]), Number(localMatch[2]) - 1, Number(localMatch[3]),
            Number(localMatch[4]), Number(localMatch[5]), Number(localMatch[6] || 0)
        )
        : new Date(raw);
    if (!raw || Number.isNaN(parsed.getTime())) throw new Error(`预约开始时间无效: ${value}`);
    return parsed.toISOString();
}

function printUsage() {
    console.log('用法:');
    console.log('  npm run asr:speaker-once -- enable <直播间ID|主播名> [--start-at ISO时间] [--window-hours 24] [--expires-hours 24] [--reason 文本] [--requested-by openclaw]');
    console.log('  npm run asr:speaker-once -- cancel <直播间ID|主播名>');
    console.log('  npm run asr:speaker-once -- status [直播间ID|主播名] [--json]');
}

function main(argv = process.argv.slice(2)) {
    const { positional, flags } = parseArgs(argv);
    const action = String(positional[0] || '').toLowerCase();
    const target = positional[1];

    if (action === 'enable' || action === 'arm') {
        const resolved = resolveRoom(target);
        const startAt = flags['start-at'] === undefined ? null : parseStartAt(flags['start-at']);
        const request = registry.arm(resolved.roomId, {
            roomName: resolved.roomName,
            requestedBy: flags['requested-by'] || 'cli',
            reason: flags.reason,
            startAt,
            windowHours: flags['window-hours'] === undefined ? 24 : Number(flags['window-hours']),
            expiresHours: flags['expires-hours'] === undefined ? 24 : Number(flags['expires-hours'])
        });
        console.log(`✅ 已开启一次性说话人识别: ${resolved.roomName || 'room'} (${resolved.roomId})`);
        if (request.scheduledAt) {
            console.log(`   生效范围: 结束时间位于预约窗口内的第一场直播`);
            console.log(`   预约窗口: ${request.scheduledAt} ~ ${request.expiresAt}`);
        } else {
            console.log(`   生效范围: 该直播间下一个尚未开始的 ASR 任务`);
            console.log(`   过期时间: ${request.expiresAt || '不过期'}`);
        }
        return request;
    }

    if (action === 'cancel' || action === 'disable') {
        const resolved = resolveRoom(target);
        const request = registry.cancel(resolved.roomId, { requestedBy: flags['requested-by'] || 'cli' });
        console.log(request
            ? `✅ 已取消一次性说话人识别: ${resolved.roomName || 'room'} (${resolved.roomId})`
            : `ℹ️  当前没有待生效开关: ${resolved.roomName || 'room'} (${resolved.roomId})`);
        return request;
    }

    if (action === 'status' || action === 'list') {
        const requests = registry.list();
        let filtered = requests;
        if (target) {
            const resolved = resolveRoom(target);
            filtered = requests.filter(item => item.roomId === resolved.roomId);
        }
        if (flags.json) {
            console.log(JSON.stringify(filtered, null, 2));
        } else if (filtered.length === 0) {
            console.log('ℹ️  当前没有待生效的一次性说话人识别开关');
        } else {
            console.log('📋 待生效的一次性说话人识别开关:');
            filtered.forEach(item => {
                const scope = item.scheduledAt
                    ? `window=${item.scheduledAt}..${item.expiresAt}`
                    : `expires=${item.expiresAt || 'never'}`;
                console.log(`   - ${item.roomName || 'room'} (${item.roomId}), ${scope}, by=${item.requestedBy}`);
            });
        }
        return filtered;
    }

    printUsage();
    throw new Error(`未知操作: ${action || '(empty)'}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`❌ ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { main, parseArgs, parseStartAt, resolveRoom, normalizeLookup };
