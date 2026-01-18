const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const configLoader = require('./config-loader');

const stat = promisify(fs.stat);
const unlink = promisify(fs.unlink);

// 检查是否为音频专用房间
function isAudioOnlyRoom(roomId) {
    const config = configLoader.getConfig();
    const roomIdInt = parseInt(roomId);
    
    // 新格式：audio.audioOnlyRooms
    if (config.audio?.enabled && config.audio.audioOnlyRooms) {
        return config.audio.audioOnlyRooms.includes(roomIdInt);
    }
    // 兼容旧格式：audioProcessing.audioOnlyRooms
    return config.audioProcessing?.enabled && config.audioProcessing.audioOnlyRooms?.includes(roomIdInt);
}

// 获取房间ID从文件名（从DDTV文件名中提取）
function extractRoomIdFromFilename(filename) {
    // DDTV文件名格式通常包含房间ID，例如：26966466_20240101_120000.mp4
    const match = filename.match(/^(\d+)_/);
    return match ? parseInt(match[1]) : null;
}

// 执行ffmpeg命令
function runFfmpegCommand(args, timeout = 300000) {
    return new Promise((resolve, reject) => {
        const config = configLoader.getConfig();
        const ffmpegPath = config.audio?.ffmpeg?.path || config.audioProcessing?.ffmpegPath || 'ffmpeg';
        
        console.log(`🎵 执行ffmpeg命令: ${ffmpegPath} ${args.join(' ')}`);
        
        const child = spawn(ffmpegPath, args, {
            stdio: ['ignore', 'pipe', 'pipe']
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
        const audioFormat = config.audio?.defaultFormat || config.audioRecording?.defaultFormat || '.m4a';
        
        // 转换视频为音频
        const audioPath = await convertVideoToAudio(videoPath, audioFormat);
        
        // 是否删除原始视频
        const keepOriginal = config.audio?.storage?.keepOriginalVideo !== undefined ? config.audio.storage.keepOriginalVideo : config.audioProcessing?.keepOriginalVideo;
        if (keepOriginal === false) {
            console.log(`🗑️  删除原始视频文件: ${path.basename(videoPath)}`);
            try {
                await unlink(videoPath);
                console.log(`✅ 原始视频已删除`);
            } catch (deleteError) {
                console.error(`⚠️  删除原始视频失败: ${deleteError.message}`);
            }
        } else {
            console.log(`💾 保留原始视频文件`);
        }
        
        return audioPath;
    } catch (error) {
        console.error(`❌ 音频专用房间处理失败: ${error.message}`);
        return null;
    }
}

// 检查ffmpeg是否可用
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
    convertVideoToAudio,
    processAudioOnlyRoom,
    checkFfmpegAvailability,
    processVideoForAudio
};

// 命令行测试
if (require.main === module) {
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