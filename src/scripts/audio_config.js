'use strict';

// Audio format, room and retention policy shared by the source CLI.
const path = require('path');
const configLoader = require('./config-loader');

const DEFAULT_AUDIO_FORMATS = ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac', '.opus'];
const DEFAULT_VIDEO_FORMATS = ['.mp4', '.flv', '.mkv', '.ts', '.mov'];
const DEFAULT_AUDIO_OUTPUT_PROFILES = {
    copyM4a: {
        format: '.m4a',
        ffmpegArgs: ['-c:a', 'copy']
    },
    opus48k: {
        format: '.opus',
        ffmpegArgs: ['-c:a', 'libopus', '-b:a', '48k']
    },
    aac64k: {
        format: '.m4a',
        outputSuffix: '_64k',
        ffmpegArgs: ['-c:a', 'aac', '-b:a', '64k']
    }
};

function isDebugLoggingEnabled() {
    return String(process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
}

function debugLog(message) {
    if (isDebugLoggingEnabled()) {
        console.debug(message);
    }
}

// 获取音频格式配置
function getAudioFormats() {
    const config = configLoader.getConfig();
    return config.audio?.formats || config.audioRecording?.audioFormats || DEFAULT_AUDIO_FORMATS;
}

function normalizeExt(ext, fallback = '.m4a') {
    const value = String(ext || fallback).trim();
    if (!value) return fallback;
    return (value.startsWith('.') ? value : `.${value}`).toLowerCase();
}

function getAudioOutputConfig(requestedProfileOrFormat = null) {
    const config = configLoader.getConfig();
    const configuredProfiles = config.audio?.outputProfiles || {};
    const profiles = { ...DEFAULT_AUDIO_OUTPUT_PROFILES, ...configuredProfiles };
    const selector = requestedProfileOrFormat ||
        config.audio?.defaultProfile ||
        config.audio?.conversion?.defaultProfile ||
        config.audio?.defaultFormat ||
        config.audioRecording?.defaultFormat ||
        '.m4a';

    let profileName = null;
    let profile = null;

    if (typeof selector === 'string' && profiles[selector]) {
        profileName = selector;
        profile = profiles[selector];
    } else {
        const selectorExt = normalizeExt(selector);
        profileName = Object.keys(profiles).find(name => normalizeExt(profiles[name]?.format || profiles[name]?.extension) === selectorExt) || null;
        profile = profileName ? profiles[profileName] : { format: selectorExt, ffmpegArgs: ['-c:a', 'copy'] };
    }

    const format = normalizeExt(profile.format || profile.extension || selector);
    let ffmpegArgs = Array.isArray(profile.ffmpegArgs) ? [...profile.ffmpegArgs] : null;
    if (!ffmpegArgs) {
        const codec = profile.codec || profile.audioCodec || 'copy';
        ffmpegArgs = ['-c:a', codec];
        if (profile.bitrate) {
            ffmpegArgs.push('-b:a', String(profile.bitrate));
        }
    }

    return {
        profileName: profileName || String(selector),
        format,
        outputSuffix: profile.outputSuffix || '',
        ffmpegArgs
    };
}

function getOutputAudioPath(inputPath, outputConfig = getAudioOutputConfig()) {
    const dir = path.dirname(inputPath);
    const baseName = path.basename(inputPath, path.extname(inputPath));
    return path.join(dir, `${baseName}${outputConfig.outputSuffix || ''}${outputConfig.format}`);
}

function getVideoFormats() {
    const config = configLoader.getConfig();
    return config.audio?.videoFormats || DEFAULT_VIDEO_FORMATS;
}

function getAudioRetentionConfig() {
    const config = configLoader.getConfig();
    const storage = config.audio?.storage || {};
    const convertAfterDays = toOptionalDays(storage.convertAfterDays ?? storage.videoRetentionDays, 3);
    const archiveExtraDays = toOptionalDays(storage.archiveExtraDays, 30);
    const defaultArchiveAfterDays = convertAfterDays === null || archiveExtraDays === null ? null : convertAfterDays + archiveExtraDays;
    const archiveTargetBasePath = storage.archiveTargetBasePath || storage.archiveBasePath || 'E:/EFiles/Evideo/DDTV录播-E';
    return {
        enabled: storage.retentionEnabled !== false,
        convertAfterDays,
        deleteAfterDays: toOptionalDays(storage.maxFileAgeDays ?? storage.deleteAfterDays, null),
        maxProcessAgeDays: storage.maxProcessAgeDays === null || storage.maxProcessAgeDays === false || storage.maxProcessAgeDays === undefined
            ? null
            : Number(storage.maxProcessAgeDays),
        includeBak: storage.includeBak !== false,
        deleteBakAfterConversion: storage.deleteBakAfterConversion === true,
        scanIntervalHours: Number(storage.scanIntervalHours ?? 24),
        archiveEnabled: storage.archiveEnabled === true || Boolean(storage.archiveTargetBasePath || storage.archiveBasePath),
        archiveAfterDays: toOptionalDays(storage.moveToArchiveAfterDays ?? storage.archiveAfterDays, defaultArchiveAfterDays),
        archiveTargetBasePath: path.resolve(archiveTargetBasePath),
        deleteBakBeforeArchive: storage.deleteBakBeforeArchive !== false,
        additionalArchiveRoomIds: new Set((storage.additionalArchiveRoomIds || []).map(value => String(value))),
        archiveAllRoomDirectories: storage.archiveAllRoomDirectories === true,
        pruneNonMergedVideosBeforeArchiveRoomIds: new Set((storage.pruneNonMergedVideosBeforeArchiveRoomIds || []).map(value => String(value))),
        expiringClipDirectoryNames: new Set([
            config.clipTopics?.outputDirName || 'topic_clips'
        ].map(value => String(value).toLowerCase())),
        basePaths: Array.from(new Set([
            storage.basePath,
            config.storage?.basePath,
            config.webhook?.endpoints?.mikufans?.basePath,
            config.recorders?.mikufans?.basePath
        ].filter(Boolean).map(p => path.resolve(p))))
    };
}

function toOptionalDays(value, fallback) {
    const raw = value === undefined ? fallback : value;
    if (raw === null || raw === false) return null;
    const num = Number(raw);
    return Number.isFinite(num) && num >= 0 ? num : null;
}

function formatAudioOnlyDebugContext(context = {}) {
    const parts = [];
    if (context.mediaPath) {
        parts.push(`file=${path.basename(context.mediaPath)}`);
        parts.push(`path=${context.mediaPath}`);
    }
    return parts.length ? `, ${parts.join(', ')}` : '';
}

// 检查是否为音频专用房间
function isAudioOnlyRoom(roomId, context = {}) {
    const config = configLoader.getConfig();
    const roomIdInt = parseInt(roomId);
    const roomIdStr = String(roomId);
    const debugContext = formatAudioOnlyDebugContext(context);

    // 优先检查房间特定的audioOnly设置
    if (config.ai?.roomSettings && config.ai.roomSettings[roomIdStr]) {
        const roomConfig = config.ai.roomSettings[roomIdStr];
        if (roomConfig.audioOnly !== undefined) {
            const isAudioRoom = config.audio?.enabled && roomConfig.audioOnly;
            debugLog(`🔍 检查房间特定音频专用设置: roomId=${roomId}, isAudioRoom=${isAudioRoom}, roomAudioOnly=${roomConfig.audioOnly}${debugContext}`);
            return isAudioRoom;
        }
    }

    // 回退到全局audioOnlyRooms列表
    // 新格式：audio.audioOnlyRooms
    if (config.audio?.enabled && config.audio.audioOnlyRooms) {
        const isAudioRoom = config.audio.audioOnlyRooms.includes(roomIdInt);
        debugLog(`🔍 检查全局音频专用房间: roomId=${roomId}, isAudioRoom=${isAudioRoom}${debugContext}`);
        return isAudioRoom;
    }
    // 兼容旧格式：audioProcessing.audioOnlyRooms
    const isAudioRoom = config.audioProcessing?.enabled && config.audioProcessing.audioOnlyRooms?.includes(roomIdInt);
    debugLog(`🔍 检查旧格式音频专用房间: roomId=${roomId}, isAudioRoom=${isAudioRoom}${debugContext}`);
    return isAudioRoom;
}

module.exports = { debugLog, getAudioFormats, getAudioOutputConfig, getOutputAudioPath, getVideoFormats, getAudioRetentionConfig, isAudioOnlyRoom };
