const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const configLoader = require('./config-loader');
const {
    applyFfmpegProcessPriority,
    getFfmpegResourceConfig,
    startResourcePeakMonitor,
    waitForAsrAvailability,
    withFfmpegResourceLimits
} = require('./ffmpeg_resource');

const stat = promisify(fs.stat);
const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);
const utimes = promisify(fs.utimes);
const mkdir = promisify(fs.mkdir);
const rename = promisify(fs.rename);
const copyFile = promisify(fs.copyFile);
const rmdir = promisify(fs.rmdir);
const rm = promisify(fs.rm);

const DEFAULT_AUDIO_FORMATS = ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac', '.opus'];
const DEFAULT_VIDEO_FORMATS = ['.mp4', '.flv', '.mkv', '.ts', '.mov'];
const MIN_VALID_MEDIA_DURATION_SECONDS = 0.1;
const TEMPORARY_AUDIO_STALE_AFTER_MS = 10 * 60 * 1000;
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
let retentionSchedulerTimer = null;

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

// 获取房间ID从文件名（从DDTV文件名中提取）
function extractRoomIdFromMediaName(filename) {
    const base = path.basename(filename);
    const patterns = [
        /^(\d+)_/,
        /(?:^|[^\d])录制-(\d+)-\d{8}-\d{6}/,
        /(?:^|[^\d])(\d+)-\d{8}-\d{6}/
    ];

    for (const pattern of patterns) {
        const match = base.match(pattern);
        if (match) {
            return parseInt(match[1], 10);
        }
    }

    const pathParts = path.normalize(String(filename)).split(path.sep).filter(Boolean).reverse();
    for (const part of pathParts) {
        if (isDayDirectoryName(part)) continue;
        const match = part.match(/^(\d+)_/);
        if (match) return parseInt(match[1], 10);
    }

    return null;
}

function extractRoomIdFromFilename(filename) {
    // DDTV文件名格式通常包含房间ID，例如：26966466_20240101_120000.mp4
    const match = filename.match(/^(\d+)_/);
    return match ? parseInt(match[1]) : extractRoomIdFromMediaName(filename);
}

function getAudioConversionTimeoutMs(durationSeconds, config = configLoader.getConfig()) {
    const configured = Number(config.audio?.ffmpeg?.timeout);
    const durationBudget = isUsableMediaDuration(durationSeconds)
        ? Math.ceil(durationSeconds * 1000 / 20) + 120000
        : 0;
    return Math.min(2147483647, Math.max(
        300000,
        Number.isFinite(configured) && configured > 0 ? configured : 0,
        durationBudget
    ));
}

// 执行ffmpeg命令
async function runFfmpegCommand(args, timeout = 300000) {
    const config = configLoader.getConfig();
    const ffmpegPath = config.audio?.ffmpeg?.path || config.audioProcessing?.ffmpegPath || 'ffmpeg';
    const resourceConfig = getFfmpegResourceConfig(config);
    const stage = '音频处理 ffmpeg';
    const asrState = args.includes('-version')
        ? { asrActive: false }
        : await waitForAsrAvailability(stage, resourceConfig);
    const effectiveResourceConfig = { ...resourceConfig };
    if (asrState.asrActive && Number(effectiveResourceConfig.threads) > 0) {
        effectiveResourceConfig.threads = Math.min(
            Number(effectiveResourceConfig.threads),
            Math.max(1, Number(effectiveResourceConfig.asrGuard?.overlapThreads) || 1)
        );
        console.log(`[resource] ${stage} 与 ASR 重叠，FFmpeg threads=${effectiveResourceConfig.threads}`);
    }
    return new Promise((resolve, reject) => {
        const commandArgs = args.includes('-version')
            ? [...args]
            : withFfmpegResourceLimits(args, effectiveResourceConfig);
        
        console.log(`🎵 执行ffmpeg命令: ${ffmpegPath} ${commandArgs.join(' ')}`);
        
        const child = spawn(ffmpegPath, commandArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false
        });
        applyFfmpegProcessPriority(child.pid, effectiveResourceConfig.priority);
        const peakMonitor = startResourcePeakMonitor(stage, {
            resourceConfig: effectiveResourceConfig
        });

        let stdout = '';
        let stderr = '';
        let timeoutId;
        let timeoutError = null;

        if (timeout > 0) {
            timeoutId = setTimeout(() => {
                timeoutError = new Error(`ffmpeg命令超时 (${timeout}ms)`);
                child.kill('SIGTERM');
            }, timeout);
        }

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
            // 输出进度信息
            if (data.toString().includes('time=')) {
                process.stdout.write('.');
            }
        });

        child.on('close', (code) => {
            if (timeoutId) clearTimeout(timeoutId);
            peakMonitor.stop();

            // Let the child close its output before conversion failure removes it.
            if (timeoutError) {
                reject(timeoutError);
                return;
            }
            
            if (code === 0) {
                console.log('\n✅ ffmpeg命令执行成功');
                resolve({ stdout, stderr });
            } else {
                console.error(`\n❌ ffmpeg命令失败，退出码: ${code}`);
                console.error(`stderr: ${stderr}`);
                reject(new Error(`ffmpeg命令失败，退出码: ${code}`));
            }
        });

        child.on('error', (err) => {
            if (timeoutId) clearTimeout(timeoutId);
            peakMonitor.stop();
            reject(err);
        });
    });
}

// 转换视频为音频
function getFfprobePath() {
    const config = configLoader.getConfig();
    const ffmpegPath = config.audio?.ffmpeg?.path || config.audioProcessing?.ffmpegPath || 'ffmpeg';
    if (path.basename(ffmpegPath).toLowerCase().startsWith('ffmpeg')) {
        return path.join(path.dirname(ffmpegPath), path.basename(ffmpegPath).replace(/^ffmpeg/i, 'ffprobe'));
    }
    return 'ffprobe';
}

function isUsableMediaDuration(duration) {
    return Number.isFinite(duration) && duration >= MIN_VALID_MEDIA_DURATION_SECONDS;
}

function runFfprobeDuration(filePath, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const child = spawn(getFfprobePath(), [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false
        });

        let stdout = '';
        let stderr = '';
        const timeoutId = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`ffprobe timeout (${timeout}ms): ${filePath}`));
        }, timeout);

        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('close', code => {
            clearTimeout(timeoutId);
            if (code !== 0) {
                reject(new Error(`ffprobe failed (${code}): ${stderr}`));
                return;
            }
            const duration = Number(String(stdout).trim());
            if (!isUsableMediaDuration(duration)) {
                reject(new Error(`ffprobe returned invalid duration for ${filePath}: ${stdout}`));
                return;
            }
            resolve(duration);
        });
        child.on('error', error => {
            clearTimeout(timeoutId);
            reject(error);
        });
    });
}

function runFfprobeAudioStreamCount(filePath, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const child = spawn(getFfprobePath(), [
            '-v', 'error',
            '-select_streams', 'a',
            '-show_entries', 'stream=index',
            '-of', 'csv=p=0',
            filePath
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false
        });

        let stdout = '';
        let stderr = '';
        const timeoutId = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`ffprobe audio stream timeout (${timeout}ms): ${filePath}`));
        }, timeout);

        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('close', code => {
            clearTimeout(timeoutId);
            if (code !== 0) {
                reject(new Error(`ffprobe audio stream failed (${code}): ${stderr}`));
                return;
            }
            const count = String(stdout)
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean).length;
            resolve(count);
        });
        child.on('error', error => {
            clearTimeout(timeoutId);
            reject(error);
        });
    });
}

async function hasAudioStream(filePath) {
    return (await runFfprobeAudioStreamCount(filePath)) > 0;
}

async function assertConvertibleAudioMedia(filePath) {
    const [streamCount, duration] = await Promise.all([
        runFfprobeAudioStreamCount(filePath),
        runFfprobeDuration(filePath)
    ]);
    if (streamCount <= 0) throw createNoAudioStreamError(filePath);
    return duration;
}

function createNoAudioStreamError(filePath) {
    const error = new Error(`input has no audio stream: ${filePath}`);
    error.code = 'NO_AUDIO_STREAM';
    return error;
}

function isNoAudioStreamError(error) {
    return error?.code === 'NO_AUDIO_STREAM' || /Output file does not contain any stream|has no audio stream/i.test(error?.message || '');
}

async function verifyConvertedAudio(sourcePath, targetPath) {
    const [sourceDuration, targetDuration] = await Promise.all([
        runFfprobeDuration(sourcePath),
        runFfprobeDuration(targetPath)
    ]);
    const delta = Math.abs(sourceDuration - targetDuration);
    if (delta > Math.max(2, sourceDuration * 0.001)) {
        throw new Error(`duration mismatch: source=${sourceDuration}s target=${targetDuration}s`);
    }
    return { sourceDuration, targetDuration };
}

async function convertVideoToAudio(videoPath, audioProfileOrFormat = null) {
    const outputConfig = getAudioOutputConfig(audioProfileOrFormat);
    const audioPath = getOutputAudioPath(videoPath, outputConfig);
    
    // 检查输入文件是否已经是音频格式
    const inputExt = path.extname(videoPath).toLowerCase();
    const audioFormats = getAudioFormats();
    
    if (audioFormats.includes(inputExt) && path.resolve(videoPath) === path.resolve(audioPath)) {
        console.log(`ℹ️  输入文件已经是音频格式 (${inputExt})，跳过转换`);
        return videoPath;
    }
    
    console.log(`🔊 开始转换视频为音频:`);
    console.log(`   输入: ${path.basename(videoPath)}`);
    console.log(`   输出: ${path.basename(audioPath)}`);
    
    try {
        // 检查输入文件是否存在
        await stat(videoPath);
        
        // 构建ffmpeg参数
        const args = [
            '-i', videoPath,          // 输入文件
            '-vn',                    // 禁用视频流
            '-c:a', 'copy',           // 复制音频流，不重新编码
            '-y',                     // 覆盖输出文件
            audioPath
        ];
        
        await runFfmpegCommand(args);
        
        // 检查输出文件
        const audioStats = await stat(audioPath);
        console.log(`✅ 音频文件生成成功: ${path.basename(audioPath)} (${(audioStats.size / 1024 / 1024).toFixed(2)} MB)`);
        
        return audioPath;
    } catch (error) {
        console.error(`❌ 音频转换失败: ${error.message}`);
        throw error;
    }
}

// 处理音频专用房间的视频
convertVideoToAudio = async function convertMediaToConfiguredAudio(mediaPath, audioProfileOrFormat = null) {
    const outputConfig = getAudioOutputConfig(audioProfileOrFormat);
    const audioPath = getOutputAudioPath(mediaPath, outputConfig);
    const tempAudioPath = path.join(
        path.dirname(audioPath),
        `${path.basename(audioPath, outputConfig.format)}.tmp-${process.pid}-${Date.now()}${outputConfig.format}`
    );
    const inputExt = path.extname(mediaPath).toLowerCase();
    const audioFormats = getAudioFormats();

    if (audioFormats.includes(inputExt) && path.resolve(mediaPath) === path.resolve(audioPath)) {
        await runFfprobeDuration(mediaPath);
        console.log(`input is already target audio format (${inputExt}), skip: ${path.basename(mediaPath)}`);
        return mediaPath;
    }

    if (fs.existsSync(audioPath)) {
        await verifyConvertedAudio(mediaPath, audioPath);
        console.log(`existing target audio verified, skip conversion: ${path.basename(audioPath)}`);
        return audioPath;
    }

    console.log('start audio conversion:');
    console.log(`   input: ${path.basename(mediaPath)}`);
    console.log(`   output: ${path.basename(audioPath)}`);
    console.log(`   profile: ${outputConfig.profileName} (${outputConfig.ffmpegArgs.join(' ')})`);

    try {
        await stat(mediaPath);
        const duration = await assertConvertibleAudioMedia(mediaPath);
        await rm(tempAudioPath, { force: true }).catch(() => {});
        const args = [
            '-i', mediaPath,
            '-vn',
            ...outputConfig.ffmpegArgs,
            '-y',
            tempAudioPath
        ];

        await runFfmpegCommand(args, getAudioConversionTimeoutMs(duration));
        await verifyConvertedAudio(mediaPath, tempAudioPath);
        await rename(tempAudioPath, audioPath);

        const audioStats = await stat(audioPath);
        console.log(`audio file generated: ${path.basename(audioPath)} (${(audioStats.size / 1024 / 1024).toFixed(2)} MB)`);

        return audioPath;
    } catch (error) {
        await rm(tempAudioPath, { force: true }).catch(() => {});
        console.error(`audio conversion failed: ${error.message}`);
        throw error;
    }
};

async function processAudioOnlyRoom(videoPath, roomId = null) {
    const config = configLoader.getConfig();
    const filename = path.basename(videoPath);
    
    // 如果没有提供roomId，从文件名提取
    if (!roomId) {
        roomId = extractRoomIdFromFilename(filename);
    }
    
    if (!roomId) {
        console.log(`⚠️  无法从文件名提取房间ID: ${filename}`);
        return null;
    }
    
    if (!isAudioOnlyRoom(roomId)) {
        console.log(`ℹ️  房间 ${roomId} 不是音频专用房间`);
        return null;
    }
    
    console.log(`🎯 检测到音频专用房间 ${roomId}，开始处理...`);
    
    try {
        // 获取音频格式配置
        const retention = getAudioRetentionConfig();
        if (retention.enabled) {
            console.log(`onlyAudio retention: convert after ${retention.convertAfterDays} days, delete after ${retention.deleteAfterDays} days`);
        }
        return { audioPath: videoPath, videoPathToDelete: null, delayedAudioRetention: true };
        const audioFormat = config.audio?.defaultFormat || config.audioRecording?.defaultFormat || '.m4a';
        
        // 转换视频为音频
        const audioPath = await convertVideoToAudio(videoPath, audioFormat);
        
        // 记录是否需要延迟删除原始视频（在切片完成后删除，以便切片能使用视频源）
        const actuallyConverted = audioPath !== videoPath;
        const keepOriginal = config.audio?.storage?.keepOriginalVideo !== undefined ? config.audio.storage.keepOriginalVideo : config.audioProcessing?.keepOriginalVideo;
        const shouldDeleteVideo = actuallyConverted && keepOriginal === false;

        if (actuallyConverted && !shouldDeleteVideo) {
            console.log(`💾 保留原始视频文件`);
        } else if (!actuallyConverted) {
            console.log(`💾 输入文件已是音频格式，无需删除`);
        } else if (shouldDeleteVideo) {
            console.log(`📋 原始视频将在切片完成后删除: ${path.basename(videoPath)}`);
        }

        return { audioPath, videoPathToDelete: shouldDeleteVideo ? videoPath : null };
    } catch (error) {
        console.error(`❌ 音频专用房间处理失败: ${error.message}`);
        return null;
    }
}

// 检查ffmpeg是否可用
function isVideoFile(filePath) {
    return getVideoFormats().includes(path.extname(filePath).toLowerCase());
}

function isAudioFilePath(filePath) {
    return getAudioFormats().includes(path.extname(filePath).toLowerCase());
}

function getFileAgeDays(stats, now = Date.now()) {
    return (now - stats.mtimeMs) / (24 * 60 * 60 * 1000);
}

function isSubPath(childPath, parentPath) {
    const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertStrictSubPath(childPath, parentPath, label) {
    const child = path.resolve(childPath);
    const parent = path.resolve(parentPath);
    if (child === parent || !isSubPath(child, parent)) {
        throw new Error(`refusing to modify ${label} outside expected root: ${child} (root: ${parent})`);
    }
}

function isBakEntryName(name) {
    const lowerName = String(name || '').toLowerCase();
    return lowerName === 'bak' ||
        lowerName.startsWith('bak_') ||
        lowerName.endsWith('.bak') ||
        /\.bak[_-]\d/.test(lowerName);
}

function isMergedRecordingVideo(filePath) {
    if (!isVideoFile(filePath)) return false;
    const baseName = path.basename(filePath, path.extname(filePath));
    return /(?:^|[_-])merged(?:$|[_-])/i.test(baseName);
}

function getArchiveCandidateDir(mediaPath, sourceRoot) {
    const relative = path.relative(sourceRoot, mediaPath);
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length >= 3 && /^\d{4}_\d{2}_\d{2}$/.test(parts[1])) {
        return path.join(sourceRoot, parts[0], parts[1]);
    }
    return path.dirname(mediaPath);
}

function isDayDirectoryName(name) {
    return /^\d{4}_\d{2}_\d{2}$/.test(name);
}

function getDayDirectoryAgeDays(dayDir, now = Date.now()) {
    const match = path.basename(dayDir).match(/^(\d{4})_(\d{2})_(\d{2})$/);
    if (!match) return null;

    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const day = Number(match[3]);
    const start = new Date(year, monthIndex, day);
    if (start.getFullYear() !== year || start.getMonth() !== monthIndex || start.getDate() !== day) {
        return null;
    }

    const endOfDay = new Date(year, monthIndex, day + 1).getTime();
    return (now - endOfDay) / (24 * 60 * 60 * 1000);
}

function isTemporaryAudioOutput(filePath) {
    return /\.tmp-\d+-\d+\.opus$/i.test(path.basename(filePath));
}

function isPathInsideNamedDirectory(filePath, directoryNames) {
    const names = directoryNames instanceof Set
        ? directoryNames
        : new Set(Array.from(directoryNames || [], value => String(value).toLowerCase()));
    return path.normalize(path.dirname(filePath))
        .split(path.sep)
        .some(part => names.has(part.toLowerCase()));
}

function isStaleTemporaryAudioOutput(stats, now = Date.now()) {
    return now - stats.mtimeMs >= TEMPORARY_AUDIO_STALE_AFTER_MS;
}

function needsConfiguredAudioConversion(mediaPath, outputConfig) {
    return isVideoFile(mediaPath) ||
        (isAudioFilePath(mediaPath) && path.extname(mediaPath).toLowerCase() !== outputConfig.format);
}

async function removeBakEntries(dir) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (isBakEntryName(entry.name)) {
            await rm(fullPath, { recursive: true, force: true });
            continue;
        }
        if (entry.isDirectory()) {
            await removeBakEntries(fullPath);
        }
    }
}

async function collectConvertedBackupCandidates(dayDir, retention, outputConfig, options = {}) {
    if (retention.convertAfterDays === null) return [];
    const now = options.now ?? Date.now();
    const verify = options.verifyMedia || assertConvertibleAudioMedia;
    const entries = await readdir(dayDir, { withFileTypes: true });
    const backupDirs = entries.filter(entry => entry.isDirectory() && isBakEntryName(entry.name));
    if (!backupDirs.length) return [];

    const rootMedia = entries.filter(entry => entry.isFile() &&
        (isVideoFile(entry.name) || isAudioFilePath(entry.name)) && !isTemporaryAudioOutput(entry.name));
    // A remaining source, including failed/unreadable media, must retain its backups.
    if (rootMedia.some(entry => needsConfiguredAudioConversion(entry.name, outputConfig))) return [];
    const merged = rootMedia.filter(entry => /(?:^|[_-])merged(?:$|[_-])/i.test(
        path.basename(entry.name, path.extname(entry.name))
    ));
    if (!merged.length) return [];

    for (const entry of merged) {
        const fullPath = path.join(dayDir, entry.name);
        const stats = await stat(fullPath);
        const ageDays = getFileAgeDays(stats, now);
        if (ageDays < retention.convertAfterDays ||
            (retention.maxProcessAgeDays != null && ageDays > retention.maxProcessAgeDays)) return [];
        await verify(fullPath);
    }

    const candidates = [];
    for (const entry of backupDirs) {
        const fullPath = path.join(dayDir, entry.name);
        let bytes = 0;
        let fileCount = 0;
        let eligible = true;
        async function inspect(dir) {
            const children = await readdir(dir, { withFileTypes: true });
            for (const child of children) {
                const childPath = path.join(dir, child.name);
                if (child.isSymbolicLink()) {
                    eligible = false;
                } else if (child.isDirectory()) {
                    await inspect(childPath);
                } else if (child.isFile()) {
                    const stats = await stat(childPath);
                    if (getFileAgeDays(stats, now) < retention.convertAfterDays) eligible = false;
                    bytes += stats.size;
                    fileCount++;
                } else {
                    eligible = false;
                }
            }
        }
        await inspect(fullPath);
        if (eligible && fileCount) candidates.push({ path: fullPath, bytes, fileCount });
    }
    return candidates;
}

async function pruneConvertedRoomBackups(root, retention, outputConfig, context) {
    if (!retention.deleteBakAfterConversion || retention.convertAfterDays === null) return;
    const days = await collectArchivableDayDirectories(root, retention);
    for (const { dayDir, audioOnly } of days) {
        if (context.isLimitReached()) break;
        if (!audioOnly || getDayDirectoryAgeDays(dayDir, context.now) < retention.convertAfterDays) continue;
        assertStrictSubPath(dayDir, root, 'converted backup day');
        try {
            const candidates = await collectConvertedBackupCandidates(dayDir, retention, outputConfig, { now: context.now });
            for (const candidate of candidates) {
                if (context.isLimitReached()) break;
                assertStrictSubPath(candidate.path, dayDir, 'converted backup');
                if (context.dryRun) {
                    debugLog(`[dry-run] delete backups after verified audio conversion: ${candidate.path} (${candidate.bytes} bytes)`);
                } else {
                    await rm(candidate.path, { recursive: true, force: false });
                    console.log(`deleted backups after verified audio conversion: ${candidate.path} (${candidate.bytes} bytes)`);
                }
                context.summary.prunedBackupDirectories++;
                context.summary.prunedBackupBytes += candidate.bytes;
                context.incrementAction();
            }
        } catch (error) {
            context.summary.failed++;
            console.warn(`converted backup cleanup failed: ${dayDir} (${error.message})`);
        }
    }
}

async function collectPrunableArchiveVideos(dayDir) {
    const resolvedDayDir = path.resolve(dayDir);
    const rootVideos = [];
    const nestedVideos = [];

    async function walk(currentDir) {
        let entries;
        try {
            entries = await readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (isBakEntryName(entry.name)) continue;
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile() && isVideoFile(fullPath)) {
                if (path.resolve(currentDir) === resolvedDayDir) {
                    rootVideos.push(fullPath);
                } else {
                    nestedVideos.push(fullPath);
                }
            }
        }
    }

    await walk(resolvedDayDir);
    const hasMergedRecording = rootVideos.some(isMergedRecordingVideo);
    const disposableRootVideos = hasMergedRecording
        ? rootVideos.filter(videoPath => !isMergedRecordingVideo(videoPath))
        : [];
    return [...nestedVideos, ...disposableRootVideos];
}

async function collectTemporaryAudioOutputs(dayDir) {
    const mediaFiles = await collectMediaFiles(dayDir, { includeBak: false });
    return mediaFiles.filter(isTemporaryAudioOutput);
}

async function collectNamedDirectories(rootDir, directoryNames) {
    const names = directoryNames instanceof Set
        ? directoryNames
        : new Set(Array.from(directoryNames || [], value => String(value).toLowerCase()));
    const results = [];

    async function walk(currentDir) {
        let entries;
        try {
            entries = await readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const fullPath = path.join(currentDir, entry.name);
            if (names.has(entry.name.toLowerCase())) {
                results.push(fullPath);
                continue;
            }
            await walk(fullPath);
        }
    }

    await walk(rootDir);
    return results;
}

async function getRecursiveSize(targetPath) {
    const stats = await stat(targetPath).catch(() => null);
    if (!stats) return 0;
    if (!stats.isDirectory()) return stats.size;

    const entries = await readdir(targetPath, { withFileTypes: true }).catch(() => []);
    const sizes = await Promise.all(entries.map(entry => getRecursiveSize(path.join(targetPath, entry.name))));
    return sizes.reduce((total, size) => total + size, 0);
}

async function pruneStaleTemporaryAudioOutputs(mediaFiles, context) {
    const prunedPaths = new Set();
    for (const mediaPath of mediaFiles) {
        if (context.isLimitReached() || !isTemporaryAudioOutput(mediaPath)) continue;
        const stats = await stat(mediaPath).catch(() => null);
        if (!stats || !isStaleTemporaryAudioOutput(stats, context.now)) continue;

        if (context.dryRun) {
            debugLog(`[dry-run] delete stale temporary audio output: ${mediaPath}`);
        } else {
            try {
                await unlink(mediaPath);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    context.summary.failed++;
                    console.warn(`stale temporary audio cleanup failed: ${mediaPath} (${error.message})`);
                    continue;
                }
            }
        }
        prunedPaths.add(path.resolve(mediaPath));
        context.summary.prunedTemporaryFiles++;
        context.incrementAction();
    }
    return mediaFiles.filter(mediaPath => !prunedPaths.has(path.resolve(mediaPath)));
}

async function pruneArchiveEntries(entryPaths) {
    for (const entryPath of entryPaths) {
        await rm(entryPath, { recursive: true, force: true });
    }
}

async function copyRecursive(sourcePath, targetPath) {
    const stats = await stat(sourcePath);
    if (stats.isDirectory()) {
        await mkdir(targetPath, { recursive: true });
        const entries = await readdir(sourcePath, { withFileTypes: true });
        for (const entry of entries) {
            await copyRecursive(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
        }
        return;
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    await utimes(targetPath, stats.atime, stats.mtime);
}

async function movePath(sourcePath, targetPath) {
    await mkdir(path.dirname(targetPath), { recursive: true });
    try {
        await rename(sourcePath, targetPath);
        return;
    } catch (error) {
        if (error.code !== 'EXDEV') {
            throw error;
        }
    }

    await copyRecursive(sourcePath, targetPath);
    await rm(sourcePath, { recursive: true, force: true });
}

async function moveDirectoryContents(sourceDir, targetDir) {
    await mkdir(targetDir, { recursive: true });
    const entries = await readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);

        if (!fs.existsSync(targetPath)) {
            await movePath(sourcePath, targetPath);
            continue;
        }

        if (entry.isDirectory()) {
            await moveDirectoryContents(sourcePath, targetPath);
            await rmdir(sourcePath).catch(() => {});
            continue;
        }

        const parsed = path.parse(entry.name);
        const conflictPath = path.join(targetDir, `${parsed.name}.conflict-${Date.now()}${parsed.ext}`);
        await movePath(sourcePath, conflictPath);
    }
}

async function cleanupEmptyParents(startDir, stopRoot) {
    let current = path.resolve(startDir);
    const stop = path.resolve(stopRoot);

    while (isSubPath(current, stop) && current !== stop) {
        try {
            await rmdir(current);
        } catch {
            break;
        }
        current = path.dirname(current);
    }
}

async function archiveDayDirectory(dayDir, sourceRoot, retention, pruneFilePaths = []) {
    assertStrictSubPath(dayDir, sourceRoot, 'archive source');
    for (const filePath of pruneFilePaths) {
        assertStrictSubPath(filePath, dayDir, 'prune target');
    }

    const relativeDir = path.relative(sourceRoot, dayDir);
    const targetDir = path.join(retention.archiveTargetBasePath, relativeDir);
    assertStrictSubPath(targetDir, retention.archiveTargetBasePath, 'archive target');

    if (retention.deleteBakBeforeArchive) {
        await removeBakEntries(dayDir);
    }
    await pruneArchiveEntries(pruneFilePaths);

    await moveDirectoryContents(dayDir, targetDir);
    await cleanupEmptyParents(dayDir, sourceRoot);
    debugLog(`archived onlyAudio day directory: ${dayDir} -> ${targetDir}`);
    return targetDir;
}

async function collectArchivableDayDirectories(rootDir, retention) {
    const dayDirs = [];
    let roomEntries;
    try {
        roomEntries = await readdir(rootDir, { withFileTypes: true });
    } catch (error) {
        console.warn(`scan archive root failed: ${rootDir} (${error.message})`);
        return dayDirs;
    }

    for (const roomEntry of roomEntries) {
        if (!roomEntry.isDirectory()) continue;

        const roomDir = path.join(rootDir, roomEntry.name);
        const roomId = extractRoomIdFromMediaName(roomEntry.name);
        if (!roomId) continue;
        const audioOnly = isAudioOnlyRoom(roomId, { mediaPath: roomDir });
        const additionalArchive = retention.additionalArchiveRoomIds.has(String(roomId));
        if (!audioOnly && !additionalArchive && !retention.archiveAllRoomDirectories) continue;

        let dateEntries;
        try {
            dateEntries = await readdir(roomDir, { withFileTypes: true });
        } catch (error) {
            console.warn(`scan archive room directory failed: ${roomDir} (${error.message})`);
            continue;
        }

        for (const dateEntry of dateEntries) {
            if (dateEntry.isDirectory() && isDayDirectoryName(dateEntry.name)) {
                dayDirs.push({
                    dayDir: path.join(roomDir, dateEntry.name),
                    roomId: String(roomId),
                    audioOnly,
                    pruneNonMergedVideos: retention.pruneNonMergedVideosBeforeArchiveRoomIds.has(String(roomId))
                });
            }
        }
    }

    return dayDirs;
}

async function hasPendingAudioConversionInDirectory(dayDir, retention, outputConfig, now, unconvertibleMediaPaths = new Set()) {
    const mediaFiles = await collectMediaFiles(dayDir, { includeBak: retention.includeBak });

    for (const mediaPath of mediaFiles) {
        if (isPathInsideNamedDirectory(mediaPath, retention.expiringClipDirectoryNames)) {
            debugLog(`archive ignores expiring clip media: ${mediaPath}`);
            continue;
        }
        if (isTemporaryAudioOutput(mediaPath)) {
            debugLog(`archive ignores temporary audio output: ${mediaPath}`);
            continue;
        }
        if (!needsConfiguredAudioConversion(mediaPath, outputConfig)) continue;
        if (unconvertibleMediaPaths.has(path.resolve(mediaPath))) continue;

        let stats;
        try {
            stats = await stat(mediaPath);
        } catch {
            return true;
        }

        const ageDays = getFileAgeDays(stats, now);
        if (retention.maxProcessAgeDays !== null && ageDays > retention.maxProcessAgeDays) {
            continue;
        }
        if (retention.convertAfterDays !== null && ageDays >= retention.convertAfterDays) {
            try {
                await assertConvertibleAudioMedia(mediaPath);
                debugLog(`archive pending configured audio conversion: ${mediaPath}`);
                return true;
            } catch (error) {
                unconvertibleMediaPaths.add(path.resolve(mediaPath));
                console.warn(`archive ignores unreadable media: ${mediaPath} (${error.message})`);
            }
        }
    }

    return false;
}

async function archiveEligibleDayDirectories(root, retention, outputConfig, context) {
    const { dryRun, now, summary, archivedDirs, isLimitReached, unconvertibleMediaPaths } = context;
    if (!retention.archiveEnabled || retention.archiveAfterDays === null) return;

    const dayDirs = await collectArchivableDayDirectories(root, retention);
    for (const candidate of dayDirs) {
        const { dayDir, audioOnly, pruneNonMergedVideos } = candidate;
        if (isLimitReached()) break;
        if (archivedDirs.has(dayDir) || !fs.existsSync(dayDir)) continue;

        const pruneVideoPaths = pruneNonMergedVideos ? await collectPrunableArchiveVideos(dayDir) : [];
        const expiringClipDirectoryPaths = pruneNonMergedVideos
            ? []
            : await collectNamedDirectories(dayDir, retention.expiringClipDirectoryNames);
        const temporaryAudioPaths = await collectTemporaryAudioOutputs(dayDir);
        const pruneFilePaths = [...new Set([
            ...expiringClipDirectoryPaths,
            ...pruneVideoPaths,
            ...temporaryAudioPaths
        ])];
        const pruneVideoBytes = (await Promise.all(
            pruneVideoPaths.map(filePath => stat(filePath).then(stats => stats.size).catch(() => 0))
        )).reduce((total, size) => total + size, 0);
        const prunedClipBytes = (await Promise.all(
            expiringClipDirectoryPaths.map(getRecursiveSize)
        )).reduce((total, size) => total + size, 0);
        const dirAgeDays = getDayDirectoryAgeDays(dayDir, now);
        if (dirAgeDays === null) continue;
        if (dirAgeDays < retention.archiveAfterDays) continue;

        if (audioOnly && await hasPendingAudioConversionInDirectory(dayDir, retention, outputConfig, now, unconvertibleMediaPaths)) {
            debugLog(`archive skip pending conversion: ${dayDir}`);
            summary.skipped++;
            continue;
        }

        try {
            if (dryRun) {
                const targetDir = path.join(retention.archiveTargetBasePath, path.relative(root, dayDir));
                debugLog(`[dry-run] archive day directory: ${dayDir} -> ${targetDir} (${dirAgeDays.toFixed(1)} days, pruneVideos=${pruneVideoPaths.length}, pruneClipDirs=${expiringClipDirectoryPaths.length})`);
            } else {
                await archiveDayDirectory(dayDir, root, retention, pruneFilePaths);
            }
        } catch (error) {
            summary.failed++;
            console.warn(`archive day directory failed: ${dayDir} (${error.message})`);
            continue;
        }
        archivedDirs.add(dayDir);
        summary.archived++;
        summary.prunedVideos += pruneVideoPaths.length;
        summary.prunedVideoBytes += pruneVideoBytes;
        summary.prunedClipDirectories += expiringClipDirectoryPaths.length;
        summary.prunedClipBytes += prunedClipBytes;
        summary.prunedTemporaryFiles += temporaryAudioPaths.length;
        context.incrementAction();
    }
}

async function collectMediaFiles(rootDir, options = {}) {
    const includeBak = options.includeBak !== false;
    const maxDepth = options.maxDepth ?? 16;
    const results = [];

    async function walk(dir, depth) {
        if (depth > maxDepth) return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (error) {
            console.warn(`scan directory failed: ${dir} (${error.message})`);
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!includeBak && isBakEntryName(entry.name)) continue;
                await walk(fullPath, depth + 1);
            } else if (entry.isFile() && (isVideoFile(fullPath) || isAudioFilePath(fullPath))) {
                results.push(fullPath);
            }
        }
    }

    await walk(rootDir, 0);
    return results;
}

async function applyOnlyAudioRetention(options = {}) {
    const retention = getAudioRetentionConfig();
    const dryRun = options.dryRun === true;
    const now = options.now || Date.now();
    const config = configLoader.getConfig();
    const audioFormat = config.audio?.defaultFormat || config.audioRecording?.defaultFormat || '.m4a';
    const summary = { scanned: 0, skipped: 0, skippedOld: 0, converted: 0, deleted: 0, failed: 0, roots: retention.basePaths };

    if (!retention.enabled) {
        console.log('onlyAudio retention disabled');
        return summary;
    }

    debugLog(`onlyAudio retention scan started: convertAfterDays=${retention.convertAfterDays}, deleteAfterDays=${retention.deleteAfterDays}, maxProcessAgeDays=${retention.maxProcessAgeDays ?? 'disabled'}, includeBak=${retention.includeBak}, roots=${retention.basePaths.join(';')}`);

    for (const root of retention.basePaths) {
        if (!fs.existsSync(root)) continue;
        const mediaFiles = await collectMediaFiles(root, { includeBak: retention.includeBak });

        for (const mediaPath of mediaFiles) {
            summary.scanned++;
            const roomId = extractRoomIdFromMediaName(mediaPath);
            if (!roomId) {
                debugLog(`onlyAudio retention skip: reason=noRoomId, file=${path.basename(mediaPath)}, path=${mediaPath}`);
                summary.skipped++;
                continue;
            }

            if (!isAudioOnlyRoom(roomId, { mediaPath })) {
                summary.skipped++;
                continue;
            }

            let stats;
            try {
                stats = await stat(mediaPath);
            } catch (error) {
                summary.failed++;
                console.warn(`stat failed: ${mediaPath} (${error.message})`);
                continue;
            }

            const ageDays = getFileAgeDays(stats, now);
            try {
                if (ageDays >= retention.deleteAfterDays) {
                    if (dryRun) {
                        debugLog(`[dry-run] delete expired onlyAudio media: ${mediaPath} (${ageDays.toFixed(1)} days)`);
                    } else {
                        await unlink(mediaPath);
                        debugLog(`deleted expired onlyAudio media: ${mediaPath} (${ageDays.toFixed(1)} days)`);
                    }
                    summary.deleted++;
                    continue;
                }

                if (retention.maxProcessAgeDays !== null && ageDays > retention.maxProcessAgeDays) {
                    debugLog(`onlyAudio retention skip old media: ${mediaPath} (${ageDays.toFixed(1)} days > ${retention.maxProcessAgeDays} days)`);
                    summary.skipped++;
                    summary.skippedOld++;
                    continue;
                }

                if (isVideoFile(mediaPath) && ageDays >= retention.convertAfterDays) {
                    const targetAudio = path.join(path.dirname(mediaPath), `${path.basename(mediaPath, path.extname(mediaPath))}${audioFormat}`);
                    if (fs.existsSync(targetAudio)) {
                        if (dryRun) {
                            debugLog(`[dry-run] delete video with existing audio: ${mediaPath}`);
                        } else {
                            await unlink(mediaPath);
                            debugLog(`deleted video with existing audio: ${mediaPath}`);
                        }
                        summary.deleted++;
                        continue;
                    }

                    if (dryRun) {
                        debugLog(`[dry-run] convert and delete video: ${mediaPath} -> ${targetAudio}`);
                    } else {
                        const audioPath = await convertVideoToAudio(mediaPath, audioFormat);
                        await utimes(audioPath, stats.atime, stats.mtime);
                        await unlink(mediaPath);
                        debugLog(`converted onlyAudio video to audio and deleted source: ${mediaPath}`);
                    }
                    summary.converted++;
                }
            } catch (error) {
                summary.failed++;
                console.warn(`onlyAudio retention failed: ${mediaPath} (${error.message})`);
            }
        }
    }

    console.log(`onlyAudio retention done: scanned=${summary.scanned}, converted=${summary.converted}, deleted=${summary.deleted}, skipped=${summary.skipped}, skippedOld=${summary.skippedOld}, failed=${summary.failed}`);
    return summary;
}

applyOnlyAudioRetention = async function applyConfiguredOnlyAudioRetention(options = {}) {
    const retention = getAudioRetentionConfig();
    const dryRun = options.dryRun === true;
    const now = options.now || Date.now();
    const maxActions = Number.isFinite(Number(options.limit ?? options.maxActions))
        ? Math.max(0, Number(options.limit ?? options.maxActions))
        : null;
    let actionCount = 0;
    const outputConfig = getAudioOutputConfig();
    const summary = {
        scanned: 0,
        skipped: 0,
        skippedOld: 0,
        converted: 0,
        deleted: 0,
        archived: 0,
        prunedVideos: 0,
        prunedVideoBytes: 0,
        prunedClipDirectories: 0,
        prunedClipBytes: 0,
        prunedTemporaryFiles: 0,
        prunedBackupDirectories: 0,
        prunedBackupBytes: 0,
        failed: 0,
        roots: retention.basePaths,
        outputProfile: outputConfig.profileName,
        outputFormat: outputConfig.format,
        archiveTargetBasePath: retention.archiveEnabled ? retention.archiveTargetBasePath : null
    };
    const archivedDirs = new Set();
    const unconvertibleMediaPaths = new Set();
    const isLimitReached = () => maxActions !== null && actionCount >= maxActions;

    if (!retention.enabled) {
        console.log('onlyAudio retention disabled');
        return summary;
    }

    debugLog(`onlyAudio retention scan started: outputProfile=${outputConfig.profileName}, convertAfterDays=${retention.convertAfterDays}, deleteAfterDays=${retention.deleteAfterDays ?? 'disabled'}, archiveEnabled=${retention.archiveEnabled}, archiveAfterDays=${retention.archiveAfterDays ?? 'disabled'}, archiveTarget=${retention.archiveTargetBasePath}, maxProcessAgeDays=${retention.maxProcessAgeDays ?? 'disabled'}, includeBak=${retention.includeBak}, roots=${retention.basePaths.join(';')}`);

    for (const root of retention.basePaths) {
        if (isLimitReached()) break;
        if (!fs.existsSync(root)) continue;
        if (options.backupsOnly === true) {
            await pruneConvertedRoomBackups(root, retention, outputConfig, {
                dryRun, now, summary, isLimitReached,
                incrementAction: () => { actionCount++; }
            });
            continue;
        }
        let mediaFiles = await collectMediaFiles(root, { includeBak: retention.includeBak });
        mediaFiles = await pruneStaleTemporaryAudioOutputs(mediaFiles, {
            dryRun,
            now,
            summary,
            isLimitReached,
            incrementAction: () => { actionCount++; }
        });

        for (let mediaPath of mediaFiles) {
            if (isLimitReached()) break;
            if (Array.from(archivedDirs).some(dir => isSubPath(mediaPath, dir))) {
                summary.skipped++;
                continue;
            }

            summary.scanned++;
            const roomId = extractRoomIdFromMediaName(mediaPath);
            if (!roomId) {
                debugLog(`onlyAudio retention skip: reason=noRoomId, file=${path.basename(mediaPath)}, path=${mediaPath}`);
                summary.skipped++;
                continue;
            }

            if (!isAudioOnlyRoom(roomId, { mediaPath })) {
                summary.skipped++;
                continue;
            }

            if (!retention.pruneNonMergedVideosBeforeArchiveRoomIds.has(String(roomId)) &&
                isPathInsideNamedDirectory(mediaPath, retention.expiringClipDirectoryNames)) {
                debugLog(`onlyAudio retention keeps clip media until archive expiry: ${mediaPath}`);
                summary.skipped++;
                continue;
            }

            let stats;
            try {
                stats = await stat(mediaPath);
            } catch (error) {
                summary.failed++;
                console.warn(`stat failed: ${mediaPath} (${error.message})`);
                continue;
            }

            const ageDays = getFileAgeDays(stats, now);
            try {
                if (retention.maxProcessAgeDays !== null && ageDays > retention.maxProcessAgeDays) {
                    debugLog(`onlyAudio retention skip old media: ${mediaPath} (${ageDays.toFixed(1)} days > ${retention.maxProcessAgeDays} days)`);
                    summary.skipped++;
                    summary.skippedOld++;
                    continue;
                }

                const needsAudioConversion = needsConfiguredAudioConversion(mediaPath, outputConfig);

                if (needsAudioConversion && retention.convertAfterDays !== null && ageDays >= retention.convertAfterDays) {
                    try {
                        await assertConvertibleAudioMedia(mediaPath);
                    } catch (error) {
                        unconvertibleMediaPaths.add(path.resolve(mediaPath));
                        summary.skipped++;
                        console.warn(`onlyAudio retention skipped unreadable media: ${mediaPath} (${error.message})`);
                        continue;
                    }
                    const targetAudio = getOutputAudioPath(mediaPath, outputConfig);
                    if (fs.existsSync(targetAudio)) {
                        let existingTargetVerified = false;
                        try {
                            await verifyConvertedAudio(mediaPath, targetAudio);
                            existingTargetVerified = true;
                        } catch (verifyError) {
                            console.warn(`existing target audio failed verification: ${targetAudio} (${verifyError.message})`);
                            if (!dryRun) {
                                await unlink(targetAudio).catch(() => {});
                            }
                        }

                        if (existingTargetVerified) {
                            if (dryRun) {
                                debugLog(`[dry-run] delete source with verified target audio: ${mediaPath}`);
                            } else {
                                await unlink(mediaPath);
                                debugLog(`deleted source with verified target audio: ${mediaPath}`);
                            }
                            summary.deleted++;
                            actionCount++;
                            mediaPath = targetAudio;
                            stats = await stat(targetAudio).catch(() => stats);
                        } else if (dryRun) {
                            debugLog(`[dry-run] reconvert source after invalid target audio: ${mediaPath} -> ${targetAudio}`);
                            summary.converted++;
                            actionCount++;
                        } else {
                            const audioPath = await convertVideoToAudio(mediaPath, outputConfig.profileName);
                            await utimes(audioPath, stats.atime, stats.mtime);
                            await unlink(mediaPath);
                            debugLog(`reconverted onlyAudio media after invalid target and deleted source: ${mediaPath}`);
                            mediaPath = audioPath;
                            stats = await stat(audioPath);
                            summary.converted++;
                            actionCount++;
                        }
                    } else if (dryRun) {
                        debugLog(`[dry-run] convert and delete source: ${mediaPath} -> ${targetAudio}`);
                        summary.converted++;
                        actionCount++;
                    } else {
                        const audioPath = await convertVideoToAudio(mediaPath, outputConfig.profileName);
                        await utimes(audioPath, stats.atime, stats.mtime);
                        await unlink(mediaPath);
                        debugLog(`converted onlyAudio media to configured audio and deleted source: ${mediaPath}`);
                        mediaPath = audioPath;
                        stats = await stat(audioPath);
                        summary.converted++;
                        actionCount++;
                    }
                }

                if (retention.deleteAfterDays !== null && ageDays >= retention.deleteAfterDays) {
                    if (dryRun) {
                        debugLog(`[dry-run] delete expired onlyAudio media: ${mediaPath} (${ageDays.toFixed(1)} days)`);
                    } else {
                        await unlink(mediaPath);
                        debugLog(`deleted expired onlyAudio media: ${mediaPath} (${ageDays.toFixed(1)} days)`);
                    }
                    summary.deleted++;
                    actionCount++;
                }
            } catch (error) {
                if (isNoAudioStreamError(error)) {
                    unconvertibleMediaPaths.add(path.resolve(mediaPath));
                    summary.skipped++;
                    console.warn(`onlyAudio retention skipped media without audio stream: ${mediaPath} (${error.message})`);
                } else {
                    summary.failed++;
                    console.warn(`onlyAudio retention failed: ${mediaPath} (${error.message})`);
                }
            }
        }

        await pruneConvertedRoomBackups(root, retention, outputConfig, {
            dryRun,
            now,
            summary,
            isLimitReached,
            incrementAction: () => { actionCount++; }
        });

        await archiveEligibleDayDirectories(root, retention, outputConfig, {
            dryRun,
            now,
            summary,
            archivedDirs,
            unconvertibleMediaPaths,
            isLimitReached,
            incrementAction: () => { actionCount++; }
        });
    }

    summary.actionLimit = maxActions;
    summary.limitReached = isLimitReached();
    console.log(`onlyAudio retention done: scanned=${summary.scanned}, converted=${summary.converted}, archived=${summary.archived}, prunedVideos=${summary.prunedVideos}, prunedClipDirs=${summary.prunedClipDirectories}, prunedBackupDirs=${summary.prunedBackupDirectories}, prunedBackupBytes=${summary.prunedBackupBytes}, deleted=${summary.deleted}, skipped=${summary.skipped}, skippedOld=${summary.skippedOld}, failed=${summary.failed}, limitReached=${summary.limitReached}`);
    return summary;
};

function startOnlyAudioRetentionScheduler() {
    if (retentionSchedulerTimer) return retentionSchedulerTimer;

    const retention = getAudioRetentionConfig();
    if (!retention.enabled) return null;

    const intervalMs = Math.max(1, retention.scanIntervalHours) * 60 * 60 * 1000;
    applyOnlyAudioRetention().catch(error => console.warn(`onlyAudio retention scan failed: ${error.message}`));
    const timer = setInterval(() => {
        applyOnlyAudioRetention().catch(error => console.warn(`onlyAudio retention scan failed: ${error.message}`));
    }, intervalMs);

    if (typeof timer.unref === 'function') timer.unref();
    console.log(`onlyAudio retention scheduler started: every ${retention.scanIntervalHours} hours`);
    retentionSchedulerTimer = timer;
    return timer;
}

async function checkFfmpegAvailability() {
    try {
        await runFfmpegCommand(['-version'], 10000);
        console.log('✅ ffmpeg可用');
        return true;
    } catch (error) {
        console.error(`❌ ffmpeg不可用: ${error.message}`);
        console.log('请确保ffmpeg已安装并添加到PATH环境变量中');
        return false;
    }
}

// 主处理函数（供外部调用）
async function processVideoForAudio(videoPath, roomId = null) {
    const config = configLoader.getConfig();
    
    const audioEnabled = config.audio?.enabled !== undefined ? config.audio.enabled : config.audioProcessing?.enabled;
    if (!audioEnabled) {
        console.log('ℹ️  音频处理功能已禁用');
        return null;
    }
    
    // 检查ffmpeg是否可用
    const ffmpegAvailable = await checkFfmpegAvailability();
    if (!ffmpegAvailable) {
        console.log('⚠️  ffmpeg不可用，跳过音频处理');
        return null;
    }
    
    // 检查文件是否存在
    try {
        await stat(videoPath);
    } catch (error) {
        console.error(`❌ 视频文件不存在: ${videoPath}`);
        return null;
    }
    
    // 处理音频专用房间
    return await processAudioOnlyRoom(videoPath, roomId);
}

// 导出函数
module.exports = {
    isAudioOnlyRoom,
    extractRoomIdFromFilename,
    extractRoomIdFromMediaName,
    convertVideoToAudio,
    processAudioOnlyRoom,
    applyOnlyAudioRetention,
    startOnlyAudioRetentionScheduler,
    checkFfmpegAvailability,
    processVideoForAudio,
    getAudioConversionTimeoutMs,
    runFfmpegCommand,
    collectConvertedBackupCandidates,
    isBakEntryName,
    isMergedRecordingVideo,
    collectPrunableArchiveVideos,
    collectTemporaryAudioOutputs,
    collectNamedDirectories,
    pruneArchiveEntries,
    isPathInsideNamedDirectory,
    isStaleTemporaryAudioOutput,
    isUsableMediaDuration,
    getDayDirectoryAgeDays
};

// 命令行测试
if (require.main === module) {
    if (process.argv.includes('--retention')) {
        const limitIndex = process.argv.indexOf('--limit');
        const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : null;
        applyOnlyAudioRetention({ dryRun: process.argv.includes('--dry-run'),
            backupsOnly: process.argv.includes('--backups-only'), limit })
            .then(summary => {
                console.log(JSON.stringify(summary, null, 2));
            })
            .catch(error => {
                console.error(`retention scan failed: ${error.message}`);
                process.exit(1);
            });
        return;
    }

    const videoPath = process.argv[2];
    if (!videoPath) {
        console.log('用法: node audio_processor.js <视频文件路径>');
        process.exit(1);
    }
    
    (async () => {
        try {
            const result = await processVideoForAudio(videoPath);
            if (result) {
                console.log(`🎉 处理完成，音频文件: ${result}`);
            } else {
                console.log('ℹ️  无需音频处理');
            }
        } catch (error) {
            console.error(`💥 处理失败: ${error.message}`);
            process.exit(1);
        }
    })();
}
