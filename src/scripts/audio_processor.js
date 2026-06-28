const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const configLoader = require('./config-loader');
const {
    applyFfmpegProcessPriority,
    getFfmpegResourceConfig,
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
        scanIntervalHours: Number(storage.scanIntervalHours ?? 24),
        archiveEnabled: storage.archiveEnabled === true || Boolean(storage.archiveTargetBasePath || storage.archiveBasePath),
        archiveAfterDays: toOptionalDays(storage.archiveAfterDays ?? storage.moveToArchiveAfterDays, defaultArchiveAfterDays),
        archiveTargetBasePath: path.resolve(archiveTargetBasePath),
        deleteBakBeforeArchive: storage.deleteBakBeforeArchive !== false,
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

    return null;
}

function extractRoomIdFromFilename(filename) {
    // DDTV文件名格式通常包含房间ID，例如：26966466_20240101_120000.mp4
    const match = filename.match(/^(\d+)_/);
    return match ? parseInt(match[1]) : extractRoomIdFromMediaName(filename);
}

// 执行ffmpeg命令
function runFfmpegCommand(args, timeout = 300000) {
    return new Promise((resolve, reject) => {
        const config = configLoader.getConfig();
        const ffmpegPath = config.audio?.ffmpeg?.path || config.audioProcessing?.ffmpegPath || 'ffmpeg';
        const resourceConfig = getFfmpegResourceConfig(config);
        const commandArgs = args.includes('-version') ? [...args] : withFfmpegResourceLimits(args, resourceConfig);
        
        console.log(`🎵 执行ffmpeg命令: ${ffmpegPath} ${commandArgs.join(' ')}`);
        
        const child = spawn(ffmpegPath, commandArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        applyFfmpegProcessPriority(child.pid, resourceConfig.priority);

        let stdout = '';
        let stderr = '';
        let timeoutId;

        if (timeout > 0) {
            timeoutId = setTimeout(() => {
                child.kill('SIGTERM');
                reject(new Error(`ffmpeg命令超时 (${timeout}ms)`));
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

function runFfprobeDuration(filePath, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const child = spawn(getFfprobePath(), [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
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
            if (!Number.isFinite(duration) || duration <= 0) {
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
        await rm(tempAudioPath, { force: true }).catch(() => {});
        const args = [
            '-i', mediaPath,
            '-vn',
            ...outputConfig.ffmpegArgs,
            '-y',
            tempAudioPath
        ];

        await runFfmpegCommand(args);
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

function getArchiveCandidateDir(mediaPath, sourceRoot) {
    const relative = path.relative(sourceRoot, mediaPath);
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length >= 3 && /^\d{4}_\d{2}_\d{2}$/.test(parts[1])) {
        return path.join(sourceRoot, parts[0], parts[1]);
    }
    return path.dirname(mediaPath);
}

async function getNewestFileMtimeMs(dir, options = {}) {
    const excludeBak = options.excludeBak !== false;
    let newest = 0;

    async function walk(currentDir) {
        let entries;
        try {
            entries = await readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const lowerName = entry.name.toLowerCase();
            if (excludeBak && (lowerName === 'bak' || lowerName.endsWith('.bak'))) {
                continue;
            }

            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }

            if (!entry.isFile()) continue;
            try {
                const stats = await stat(fullPath);
                newest = Math.max(newest, stats.mtimeMs);
            } catch {
                // Ignore files that disappear during a scan.
            }
        }
    }

    await walk(dir);
    return newest;
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
        const lowerName = entry.name.toLowerCase();
        if (lowerName === 'bak' || lowerName.endsWith('.bak')) {
            await rm(fullPath, { recursive: true, force: true });
            continue;
        }
        if (entry.isDirectory()) {
            await removeBakEntries(fullPath);
        }
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

async function archiveDayDirectory(dayDir, sourceRoot, retention) {
    if (retention.deleteBakBeforeArchive) {
        await removeBakEntries(dayDir);
    }

    const relativeDir = path.relative(sourceRoot, dayDir);
    const targetDir = path.join(retention.archiveTargetBasePath, relativeDir);
    await moveDirectoryContents(dayDir, targetDir);
    await cleanupEmptyParents(dayDir, sourceRoot);
    debugLog(`archived onlyAudio day directory: ${dayDir} -> ${targetDir}`);
    return targetDir;
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
                if (!includeBak && entry.name.toLowerCase() === 'bak') continue;
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
        failed: 0,
        roots: retention.basePaths,
        outputProfile: outputConfig.profileName,
        outputFormat: outputConfig.format,
        archiveTargetBasePath: retention.archiveEnabled ? retention.archiveTargetBasePath : null
    };
    const archivedDirs = new Set();
    const isLimitReached = () => maxActions !== null && actionCount >= maxActions;

    if (!retention.enabled) {
        console.log('onlyAudio retention disabled');
        return summary;
    }

    debugLog(`onlyAudio retention scan started: outputProfile=${outputConfig.profileName}, convertAfterDays=${retention.convertAfterDays}, deleteAfterDays=${retention.deleteAfterDays ?? 'disabled'}, archiveEnabled=${retention.archiveEnabled}, archiveAfterDays=${retention.archiveAfterDays ?? 'disabled'}, archiveTarget=${retention.archiveTargetBasePath}, maxProcessAgeDays=${retention.maxProcessAgeDays ?? 'disabled'}, includeBak=${retention.includeBak}, roots=${retention.basePaths.join(';')}`);

    for (const root of retention.basePaths) {
        if (isLimitReached()) break;
        if (!fs.existsSync(root)) continue;
        const mediaFiles = await collectMediaFiles(root, { includeBak: retention.includeBak });

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

                const needsAudioConversion = isVideoFile(mediaPath) ||
                    (isAudioFilePath(mediaPath) && path.extname(mediaPath).toLowerCase() !== outputConfig.format);

                if (needsAudioConversion && retention.convertAfterDays !== null && ageDays >= retention.convertAfterDays) {
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

                if (retention.archiveEnabled && retention.archiveAfterDays !== null) {
                    const dayDir = getArchiveCandidateDir(mediaPath, root);
                    if (!archivedDirs.has(dayDir) && fs.existsSync(dayDir)) {
                        const newestMtime = await getNewestFileMtimeMs(dayDir, { excludeBak: retention.deleteBakBeforeArchive });
                        const dirAgeDays = newestMtime > 0 ? (now - newestMtime) / (24 * 60 * 60 * 1000) : ageDays;
                        if (dirAgeDays >= retention.archiveAfterDays) {
                            if (dryRun) {
                                const targetDir = path.join(retention.archiveTargetBasePath, path.relative(root, dayDir));
                                debugLog(`[dry-run] archive day directory: ${dayDir} -> ${targetDir} (${dirAgeDays.toFixed(1)} days)`);
                            } else {
                                await archiveDayDirectory(dayDir, root, retention);
                            }
                            archivedDirs.add(dayDir);
                            summary.archived++;
                            actionCount++;
                            continue;
                        }
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
                summary.failed++;
                console.warn(`onlyAudio retention failed: ${mediaPath} (${error.message})`);
            }
        }
    }

    summary.actionLimit = maxActions;
    summary.limitReached = isLimitReached();
    console.log(`onlyAudio retention done: scanned=${summary.scanned}, converted=${summary.converted}, archived=${summary.archived}, deleted=${summary.deleted}, skipped=${summary.skipped}, skippedOld=${summary.skippedOld}, failed=${summary.failed}, limitReached=${summary.limitReached}`);
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
    processVideoForAudio
};

// 命令行测试
if (require.main === module) {
    if (process.argv.includes('--retention')) {
        const limitIndex = process.argv.indexOf('--limit');
        const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : null;
        applyOnlyAudioRetention({ dryRun: process.argv.includes('--dry-run'), limit })
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
