#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');

// 导入新模块
const configLoader = require('./config-loader');
const audioProcessor = require('./audio_processor');
const aiTextGenerator = require('./ai_text_generator');
const aiComicGenerator = require('./ai_comic_generator');

// 获取音频格式配置
function getAudioFormats() {
    const config = configLoader.getConfig();
    const defaultAudioFormats = ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac'];
    return config.audio?.formats || config.audioRecording?.audioFormats || defaultAudioFormats;
}

// 获取支持的媒体文件扩展名
function getMediaExtensions() {
    const audioFormats = getAudioFormats();
    const videoExtensions = ['.mp4', '.flv', '.mkv', '.ts', '.mov'];
    return [...videoExtensions, ...audioFormats];
}

const MEDIA_EXTS = getMediaExtensions();

function isMediaFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MEDIA_EXTS.includes(ext);
}

function isAudioFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const audioFormats = getAudioFormats();
    return audioFormats.includes(ext);
}

function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, stdio: 'inherit' });
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });
        child.on('error', reject);
    });
}

// 获取视频时长（秒）
async function getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        let output = '';
        let error = '';
        
        ffprobe.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        ffprobe.stderr.on('data', (data) => {
            error += data.toString();
        });
        
        ffprobe.on('close', (code) => {
            if (code === 0 && output.trim()) {
                const duration = parseFloat(output.trim());
                if (!isNaN(duration)) {
                    resolve(duration);
                } else {
                    reject(new Error(`Invalid duration: ${output}`));
                }
            } else {
                reject(new Error(`ffprobe failed: ${error || 'unknown error'}`));
            }
        });
        
        ffprobe.on('error', reject);
    });
}

// Whisper 文件锁 - 防止并发调用导致 GPU 冲突
const WHISPER_LOCK_FILE = path.join(__dirname, '.whisper_lock');
const WHISPER_LOCK_TIMEOUT = 60 * 60 * 1000; // 1小时超时
const WHISPER_LOCK_RETRY_INTERVAL = 10000; // 10秒重试间隔
const WHISPER_MAX_RETRIES = 180; // 最多重试 180 次（6分钟）

async function acquireWhisperLock() {
    const startTime = Date.now();
    
    for (let i = 0; i < WHISPER_MAX_RETRIES; i++) {
        try {
            // 尝试创建锁文件
            const fd = fs.openSync(WHISPER_LOCK_FILE, 'wx');
            const lockData = {
                pid: process.pid,
                startTime: new Date().toISOString(),
                timestamp: Date.now()
            };
            fs.writeSync(fd, JSON.stringify(lockData, null, 2));
            fs.closeSync(fd);
            console.log('🔒 获取 Whisper 锁成功');
            return;
        } catch (error) {
            if (error.code === 'EEXIST') {
                // 检查锁是否过期
                try {
                    const lockContent = fs.readFileSync(WHISPER_LOCK_FILE, 'utf8');
                    const lock = JSON.parse(lockContent);
                    const age = Date.now() - lock.timestamp;
                    
                    if (age > WHISPER_LOCK_TIMEOUT) {
                        console.warn(`⚠️  检测到过期锁文件 (${(age / 60000).toFixed(1)} 分钟前)，尝试删除...`);
                        fs.unlinkSync(WHISPER_LOCK_FILE);
                        continue; // 重试
                    }
                    
                    const elapsed = Date.now() - startTime;
                    console.log(`⏳ 等待 Whisper 锁释放... (${(elapsed / 1000).toFixed(0)}s)`);
                } catch (readError) {
                    // 锁文件损坏，删除重试
                    console.warn('⚠️  锁文件损坏，尝试删除...');
                    try {
                        fs.unlinkSync(WHISPER_LOCK_FILE);
                    } catch (e) {
                        // 忽略删除失败
                    }
                }
                
                // 等待后重试
                await new Promise(r => setTimeout(r, WHISPER_LOCK_RETRY_INTERVAL));
            } else {
                throw error;
            }
        }
    }
    
    throw new Error(`获取 Whisper 锁超时 (超过 ${WHISPER_MAX_RETRIES * WHISPER_LOCK_RETRY_INTERVAL / 1000} 秒)`);
}

function releaseWhisperLock() {
    try {
        if (fs.existsSync(WHISPER_LOCK_FILE)) {
            fs.unlinkSync(WHISPER_LOCK_FILE);
            console.log('🔓 释放 Whisper 锁');
        }
    } catch (error) {
        console.warn(`⚠️  释放 Whisper 锁时出错: ${error.message}`);
    }
}

// 带重试的命令执行函数
async function runCommandWithRetry(command, args, options = {}, maxRetries = 2) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`尝试执行 (第 ${attempt}/${maxRetries} 次): ${command} ${args.join(' ')}`);
            await runCommand(command, args, options);
            return; // 成功则返回
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                console.warn(`⚠️  第 ${attempt} 次尝试失败: ${error.message}`);
                console.log(`⏳ 等待5秒后进行第 ${attempt + 1} 次尝试...`);
                await new Promise(r => setTimeout(r, 5000)); // 等待5秒后重试
            }
        }
    }
    throw lastError; // 所有重试都失败则抛出错误
}

async function processMedia(mediaPath) {
    const dir = path.dirname(mediaPath);
    const nameNoExt = path.basename(mediaPath, path.extname(mediaPath));
    const srtPath = path.join(dir, `${nameNoExt}.srt`);

    const pythonScript = path.join(__dirname, 'python', 'batch_whisper.py');

    if (!fs.existsSync(pythonScript)) {
        throw new Error(`Python script not found at: ${pythonScript}`);
    }

    if (!fs.existsSync(srtPath)) {
        // 检查视频时长，小于30秒则跳过Whisper处理
        if (!isAudioFile(mediaPath)) {
            try {
                console.log(`🔍 分析视频时长...`);
                const duration = await getVideoDuration(mediaPath);
                const minDurationSeconds = 30; // 最小视频时长：30秒
                
                if (duration < minDurationSeconds) {
                    console.log(`⏭️  视频时长过短 (${duration.toFixed(1)}秒 < ${minDurationSeconds}秒)，跳过Whisper处理`);
                    return null;
                }
                
                const minutes = Math.floor(duration / 60);
                const seconds = Math.floor(duration % 60);
                const ms = Math.floor((duration % 1) * 1000);
                console.log(`-> ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`);
            } catch (error) {
                console.warn(`⚠️  获取视频时长失败: ${error.message}，继续处理`);
            }
        }
        
        const fileType = isAudioFile(mediaPath) ? 'Audio' : 'Video';
        console.log(`\n-> [ASR] Generating Subtitles (Whisper)...`);
        console.log(`   Target: ${path.basename(mediaPath)} (${fileType})`);

        // 获取 Whisper 锁，防止并发调用导致 GPU 冲突
        await acquireWhisperLock();
        
        try {
            await runCommand('python', [pythonScript, mediaPath], {
                env: { ...process.env, PYTHONUTF8: '1' }
            });
        } finally {
            // 释放锁
            releaseWhisperLock();
        }
    } else {
        console.log(`-> [Skip] Subtitle exists: ${path.basename(srtPath)}`);
    }

    if (fs.existsSync(srtPath)) {
        return srtPath;
    }
    return null;
}

// 音频处理
async function processAudioIfNeeded(mediaPath, roomId = null) {
    console.log('\n🔊 检查音频处理需求...');
    
    try {
        const result = await audioProcessor.processVideoForAudio(mediaPath, roomId);
        if (result) {
            console.log(`✅ 音频处理完成，使用音频文件: ${path.basename(result)}`);
            return result; // 返回音频文件路径
        }
    } catch (error) {
        console.error(`⚠️  音频处理失败: ${error.message}`);
    }
    
    return mediaPath; // 返回原始文件路径
}

// AI文本生成
async function generateAiText(highlightPath, roomId = null) {
    console.log('\n🤖 开始AI文本生成...');
    
    try {
        const result = await aiTextGenerator.generateGoodnightReply(highlightPath, roomId);
        if (result) {
            console.log(`✅ AI文本生成完成: ${path.basename(result)}`);
            return result;
        }
    } catch (error) {
        console.error(`⚠️  AI文本生成失败: ${error.message}`);
    }
    
    return null;
}

// AI漫画生成
async function generateAiComic(highlightPath, roomId = null) {
    console.log('\n🎨 开始AI漫画生成...');
    
    try {
        const result = await aiComicGenerator.generateComicFromHighlight(highlightPath, roomId);
        if (result) {
            console.log(`✅ AI漫画生成完成: ${path.basename(result)}`);
            return result;
        }
    } catch (error) {
        console.error(`⚠️  AI漫画生成失败: ${error.message}`);
    }
    
    return null;
}

// 触发延迟回复任务（已废弃，现在由 MikufansWebhookHandler 直接调用）
async function triggerDelayedReply(roomId, goodnightTextPath, comicImagePath) {
    console.log(`ℹ️  延迟回复触发已移至父进程，此函数已废弃`);
    console.log(`   房间ID: ${roomId}`);
    console.log(`   晚安回复: ${goodnightTextPath}`);
    console.log(`   漫画: ${comicImagePath}`);
}

// 检查房间是否启用AI功能
function shouldGenerateAiForRoom(roomId) {
    const config = configLoader.getConfig();
    const roomStr = String(roomId);
    
    if (config.ai?.roomSettings && config.ai.roomSettings[roomStr]) {
        const roomConfig = config.ai.roomSettings[roomStr];
        return {
            text: roomConfig.enableTextGeneration !== false,
            comic: roomConfig.enableComicGeneration !== false
        };
    }
    // 兼容旧格式 roomSettings（直接在config下）
    if (config.roomSettings && config.roomSettings[roomStr]) {
        const roomConfig = config.roomSettings[roomStr];
        return {
            text: roomConfig.enableTextGeneration !== false,
            comic: roomConfig.enableComicGeneration !== false
        };
    }
    
    // 默认启用所有AI功能
    return { text: true, comic: true };
}

// 从文件名提取房间ID
function extractRoomIdFromFilename(filename) {
    // 尝试匹配 "录制-23197314-..." 或 "23197314-..." 格式
    const match = filename.match(/(?:录制-)?(\d+)-/);
    return match ? parseInt(match[1]) : null;
}

const main = async () => {
    const inputPaths = process.argv.slice(2);

    if (inputPaths.length === 0) {
        console.error('X Error: No files detected! Please drag files onto the icon.');
        process.exit(1);
    }

    // 获取房间ID（从环境变量或文件名）
    const roomId = process.env.ROOM_ID ? parseInt(process.env.ROOM_ID) : null;

    console.log('===========================================');
    console.log('      Live Summary 增强版自动化工厂       ');
    console.log('      (支持音频处理 + AI生成)             ');
    console.log('===========================================');

    let mediaFiles = [];
    let xmlFiles = [];
    let filesToProcess = [];
    let fileSnapshots = new Map();  // 用于记录文件快照

    console.log('-> Analyzing input files...');

    inputPaths.forEach(filePath => {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const fileName = path.basename(filePath);

            if (isMediaFile(filePath)) {
                const fileType = isAudioFile(filePath) ? 'Audio' : 'Video';
                console.log(`   [${fileType}] Found: ${fileName}`);
                mediaFiles.push(filePath);
            } else if (ext === '.xml') {
                console.log(`   [XML]   Found: ${fileName}`);
                xmlFiles.push(filePath);
                filesToProcess.push(filePath);
            } else if (ext === '.srt') {
                console.log(`   [SRT]   Found: ${fileName}`);
                filesToProcess.push(filePath);
            }
        }
    });

    // 处理媒体文件（音频处理 + ASR）
    const processedMediaFiles = [];
    for (const mediaFile of mediaFiles) {
        console.log(`\n--- 处理媒体文件: ${path.basename(mediaFile)} ---`);
        
        // 1. 音频处理（如果需要）
        const processedFile = await processAudioIfNeeded(mediaFile, roomId);
        
        // 2. ASR生成字幕
        const srtPath = await processMedia(processedFile);
        
        if (srtPath) {
            processedMediaFiles.push(processedFile); // 记录处理后的文件
            filesToProcess.push(srtPath);
        }
    }

    console.log('\n--------------------------------------------');

    // 在处理开始前记录文件列表快照，用于后续过滤本次生成的文件
    if (filesToProcess.length > 0) {
        const outputDir = path.dirname(filesToProcess[0]);
        try {
            const existingFiles = fs.readdirSync(outputDir);
            existingFiles.forEach(file => {
                const filePath = path.join(outputDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    fileSnapshots.set(file, stats.mtimeMs);
                } catch (e) {
                    fileSnapshots.set(file, 0);
                }
            });
        } catch (e) {
            // 忽略错误
        }
    }

    // Node.js Fusion（弹幕融合）
    let generatedHighlightFile = null;
    let outputDir = null;
    
    if (filesToProcess.length === 0) {
        console.log('X Warning: No valid SRT or XML files to process.');
    } else {
        console.log('-> [Fusion] Merging Subtitles and Danmaku...');

        const nodeScript = path.join(__dirname, 'do_fusion_summary.js');

        // 获取输出目录
        outputDir = path.dirname(filesToProcess[0]);

        if (!fs.existsSync(nodeScript)) {
            console.error(`X Error: Node.js script not found at: ${nodeScript}`);
        } else {
            // 获取输出目录和基础名称
            const baseName = path.basename(filesToProcess[0]).replace(/\.(srt|xml|mp4|flv|mkv)$/i, '').replace(/_fix$/, '');
            generatedHighlightFile = path.join(outputDir, `${baseName}_AI_HIGHLIGHT.txt`);
            
            try {
                await runCommandWithRetry('node', [nodeScript, ...filesToProcess], {}, 2);
            } catch (error) {
                console.error(`❌ Fusion处理失败（经过重试）: ${error.message}`);
                // 继续处理而不中断，因为可能已经部分生成了数据
            }
        }
    }

    // AI生成阶段
    console.log('\n--------------------------------------------');
    console.log('-> [AI Generation] Starting AI content generation...');
    
    try {
        // 使用 do_fusion_summary 生成的文件
        if (generatedHighlightFile && fs.existsSync(generatedHighlightFile)) {
            const highlightPath = generatedHighlightFile;
            const highlightFile = path.basename(highlightPath);
            // 优先使用环境变量中的 roomId，如果没有再从文件名提取
            const finalRoomId = roomId || extractRoomIdFromFilename(highlightFile);
            
            console.log(`📌 处理 do_fusion_summary 生成的文件: ${highlightFile}`);
            console.log(`\n--- 处理: ${highlightFile} ---`);
            
            // 检查AI_HIGHLIGHT文件大小，小于0.5KB则跳过AI生成
            const highlightStats = fs.statSync(highlightPath);
            const highlightSizeKB = highlightStats.size / 1024;
            const minHighlightSizeKB = 0.5; // 最小AI_HIGHLIGHT文件大小：0.5KB
            
            console.log(`📊 AI_HIGHLIGHT文件大小: ${highlightSizeKB.toFixed(2)}KB`);
            
            if (highlightSizeKB < minHighlightSizeKB) {
                console.log(`⏭️  AI_HIGHLIGHT文件过小 (${highlightSizeKB.toFixed(2)}KB < ${minHighlightSizeKB}KB)，跳过AI生成`);
                return;
            }
            
            // 检查视频时长（从SRT文件获取）
            const srtFile = filesToProcess.find(f => f.endsWith('.srt'));
            if (srtFile && fs.existsSync(srtFile)) {
                const srtContent = fs.readFileSync(srtFile, 'utf8');
                const timeMatches = srtContent.match(/\d{2}:\d{2}:\d{2},\d{3}/g);
                if (timeMatches && timeMatches.length > 0) {
                    const lastTimeStr = timeMatches[timeMatches.length - 1];
                    const [h, m, s] = lastTimeStr.split(':').map(Number);
                    const totalSeconds = h * 3600 + m * 60 + s;
                    const minDurationSeconds = 30; // 最小视频时长：30秒
                    
                    console.log(`⏱️  视频时长: ${totalSeconds}秒`);
                    
                    if (totalSeconds < minDurationSeconds) {
                        console.log(`⏭️  视频时长过短 (${totalSeconds}秒 < ${minDurationSeconds}秒)，跳过AI生成`);
                        return;
                    }
                }
            }
            
            // 检查房间AI设置
            const aiSettings = finalRoomId ? shouldGenerateAiForRoom(finalRoomId) : { text: true, comic: true };
            
            console.log(`🏠 房间ID: ${finalRoomId}`);
            console.log(`   AI文本生成: ${aiSettings.text ? '启用' : '禁用'}`);
            console.log(`   AI漫画生成: ${aiSettings.comic ? '启用' : '禁用'}`);
            
            // AI文本生成
            let goodnightTextPath = null;
            if (aiSettings.text) {
                console.log(`📝 开始AI文本生成...`);
                goodnightTextPath = await generateAiText(highlightPath, finalRoomId);
                console.log(`📝 AI文本生成结果: ${goodnightTextPath || 'null'}`);
            } else {
                console.log('ℹ️  跳过AI文本生成（房间设置禁用）');
            }
            
            // AI漫画生成
            let comicImagePath = null;
            if (aiSettings.comic) {
                console.log(`🎨 开始AI漫画生成...`);
                comicImagePath = await generateAiComic(highlightPath, finalRoomId);
                console.log(`🎨 AI漫画生成结果: ${comicImagePath || 'null'}`);
            } else {
                console.log('ℹ️  跳过AI漫画生成（房间设置禁用）');
            }

            // 触发延迟回复任务（现在由父进程 MikufansWebhookHandler 处理）
            console.log(`🔍 延迟回复将由父进程处理: roomId=${finalRoomId}, goodnightTextPath=${goodnightTextPath}, comicImagePath=${comicImagePath}`);
        } else {
            console.log('⚠️  未找到 do_fusion_summary 生成的 AI_HIGHLIGHT 文件');
            console.log(`   generatedHighlightFile: ${generatedHighlightFile}`);
            console.log(`   exists: ${generatedHighlightFile ? fs.existsSync(generatedHighlightFile) : 'N/A'}`);
        }
    } catch (error) {
        console.error(`⚠️  AI生成阶段出错: ${error.message}`);
        console.error(error.stack);
    }

    console.log('');
    console.log('===========================================');
    console.log('       所有任务完成！                      ');
    console.log('===========================================');
    
    if (filesToProcess.length > 0) {
        console.log(`输出目录: ${outputDir}`);
        
        // 列出生成的文件（只显示本次新生成的文件）
        try {
            const files = fs.readdirSync(outputDir);
            const now = Date.now();
            // 过滤出本次会话新生成的文件（包括本次创建的AI_HIGHLIGHT文件）
            const generatedFiles = files.filter(f => {
                const filePath = path.join(outputDir, f);
                try {
                    const stats = fs.statSync(filePath);
                    // 如果文件在快照中不存在，或者修改时间在快照之后，则是新生成的文件
                    const originalMtime = fileSnapshots.get(f) || 0;
                    // 5分钟内的文件视为本次生成的（容忍时间差）
                    const isNew = stats.mtimeMs > originalMtime || (now - stats.mtimeMs < 300000);
                    // 只显示AI相关的文件
                    const isAiFile = f.includes('_晚安回复.md') ||
                                   f.includes('_COMIC_FACTORY.') ||
                                   f.includes('_AI_HIGHLIGHT.txt');
                    return isAiFile && isNew;
                } catch (e) {
                    return false;
                }
            });
            
            if (generatedFiles.length > 0) {
                console.log('\n📁 本次生成的文件:');
                generatedFiles.forEach(file => {
                    const filePath = path.join(outputDir, file);
                    const stats = fs.statSync(filePath);
                    const size = (stats.size / 1024).toFixed(1);
                    const mtime = new Date(stats.mtimeMs).toLocaleTimeString();
                    console.log(`   ${file} (${size}KB) [${mtime}]`);
                });
            }
        } catch (error) {
            // 忽略文件列表错误
        }
    }

    // 检查是否在自动化模式（支持 NODE_ENV、CI 和 AUTOMATION 环境变量）
    if (process.env.NODE_ENV === 'automation' || process.env.CI || process.env.AUTOMATION === 'true') {
        process.exit(0);
    } else {
        // 交互模式，等待用户
        console.log('\n按Enter键关闭...');
        process.stdin.resume();
        process.stdin.on('data', () => {
            process.exit(0);
        });
    }
}

(async () => {
    await main();
})();