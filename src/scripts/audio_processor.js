const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const configLoader = require('./config-loader');

const stat = promisify(fs.stat);
const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);
const utimes = promisify(fs.utimes);

const DEFAULT_AUDIO_FORMATS = ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac'];
const DEFAULT_VIDEO_FORMATS = ['.mp4', '.flv', '.mkv', '.ts', '.mov'];
let retentionSchedulerTimer = null;

// 获取音频格式配置
function getAudioFormats() {
    const config = configLoader.getConfig();
    return config.audio?.formats || config.audioRecording?.audioFormats || DEFAULT_AUDIO_FORMATS;
}

function getVideoFormats() {
    const config = configLoader.getConfig();
    return config.audio?.videoFormats || DEFAULT_VIDEO_FORMATS;
}

function getAudioRetentionConfig() {
    const config = configLoader.getConfig();
    const storage = config.audio?.storage || {};
    return {
        enabled: storage.retentionEnabled !== false,
        convertAfterDays: Number(storage.convertAfterDays ?? storage.videoRetentionDays ?? 3),
        deleteAfterDays: Number(storage.maxFileAgeDays ?? storage.deleteAfterDays ?? 30),
        includeBak: storage.includeBak !== false,
        scanIntervalHours: Number(storage.scanIntervalHours ?? 24),
        basePaths: Array.from(new Set([
            storage.basePath,
            config.storage?.basePath,
            config.webhook?.endpoints?.mikufans?.basePath,
            config.recorders?.mikufans?.basePath
        ].filter(Boolean).map(p => path.resolve(p))))
    };
}

// 检查是否为音频专用房间
function isAudioOnlyRoom(roomId) {
    const config = configLoader.getConfig();
    const roomIdInt = parseInt(roomId);
    const roomIdStr = String(roomId);
    
    // 优先检查房间特定的audioOnly设置
    if (config.ai?.roomSettings && config.ai.roomSettings[roomIdStr]) {
        const roomConfig = config.ai.roomSettings[roomIdStr];
        if (roomConfig.audioOnly !== undefined) {
            const isAudioRoom = config.audio?.enabled && roomConfig.audioOnly;
            console.log(`🔍 检查房间特定音频专用设置: roomId=${roomId}, isAudioRoom=${isAudioRoom}, roomAudioOnly=${roomConfig.audioOnly}`);
            return isAudioRoom;
        }
    }
    
    // 回退到全局audioOnlyRooms列表
    // 新格式：audio.audioOnlyRooms
    if (config.audio?.enabled && config.audio.audioOnlyRooms) {
        const isAudioRoom = config.audio.audioOnlyRooms.includes(roomIdInt);
        console.log(`🔍 检查全局音频专用房间: roomId=${roomId}, isAudioRoom=${isAudioRoom}`);
        return isAudioRoom;
    }
    // 兼容旧格式：audioProcessing.audioOnlyRooms
    const isAudioRoom = config.audioProcessing?.enabled && config.audioProcessing.audioOnlyRooms?.includes(roomIdInt);
    console.log(`🔍 检查旧格式音频专用房间: roomId=${roomId}, isAudioRoom=${isAudioRoom}`);
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
        
        console.log(`🎵 执行ffmpeg命令: ${ffmpegPath} ${args.join(' ')}`);
        
        const child = spawn(ffmpegPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

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
async function convertVideoToAudio(videoPath, audioFormat = '.m4a') {
    const videoDir = path.dirname(videoPath);
    const videoName = path.basename(videoPath, path.extname(videoPath));
    const audioPath = path.join(videoDir, `${videoName}${audioFormat}`);
    
    // 检查输入文件是否已经是音频格式
    const inputExt = path.extname(videoPath).toLowerCase();
    const audioFormats = getAudioFormats();
    
    if (audioFormats.includes(inputExt)) {
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
    const summary = { scanned: 0, skipped: 0, converted: 0, deleted: 0, failed: 0, roots: retention.basePaths };

    if (!retention.enabled) {
        console.log('onlyAudio retention disabled');
        return summary;
    }

    console.log(`onlyAudio retention scan: convertAfterDays=${retention.convertAfterDays}, deleteAfterDays=${retention.deleteAfterDays}, includeBak=${retention.includeBak}`);

    for (const root of retention.basePaths) {
        if (!fs.existsSync(root)) continue;
        const mediaFiles = await collectMediaFiles(root, { includeBak: retention.includeBak });

        for (const mediaPath of mediaFiles) {
            summary.scanned++;
            const roomId = extractRoomIdFromMediaName(mediaPath);
            if (!roomId || !isAudioOnlyRoom(roomId)) {
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
                        console.log(`[dry-run] delete expired onlyAudio media: ${mediaPath} (${ageDays.toFixed(1)} days)`);
                    } else {
                        await unlink(mediaPath);
                        console.log(`deleted expired onlyAudio media: ${mediaPath} (${ageDays.toFixed(1)} days)`);
                    }
                    summary.deleted++;
                    continue;
                }

                if (isVideoFile(mediaPath) && ageDays >= retention.convertAfterDays) {
                    const targetAudio = path.join(path.dirname(mediaPath), `${path.basename(mediaPath, path.extname(mediaPath))}${audioFormat}`);
                    if (fs.existsSync(targetAudio)) {
                        if (dryRun) {
                            console.log(`[dry-run] delete video with existing audio: ${mediaPath}`);
                        } else {
                            await unlink(mediaPath);
                            console.log(`deleted video with existing audio: ${mediaPath}`);
                        }
                        summary.deleted++;
                        continue;
                    }

                    if (dryRun) {
                        console.log(`[dry-run] convert and delete video: ${mediaPath} -> ${targetAudio}`);
                    } else {
                        const audioPath = await convertVideoToAudio(mediaPath, audioFormat);
                        await utimes(audioPath, stats.atime, stats.mtime);
                        await unlink(mediaPath);
                        console.log(`converted onlyAudio video to audio and deleted source: ${mediaPath}`);
                    }
                    summary.converted++;
                }
            } catch (error) {
                summary.failed++;
                console.warn(`onlyAudio retention failed: ${mediaPath} (${error.message})`);
            }
        }
    }

    console.log(`onlyAudio retention done: scanned=${summary.scanned}, converted=${summary.converted}, deleted=${summary.deleted}, skipped=${summary.skipped}, failed=${summary.failed}`);
    return summary;
}

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
        applyOnlyAudioRetention({ dryRun: process.argv.includes('--dry-run') })
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
