#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 导入新模块
const audioProcessor = require('./audio_processor');
const aiTextGenerator = require('./ai_text_generator');
const aiComicGenerator = require('./ai_comic_generator');

// 获取音频格式配置
function getAudioFormats() {
    const configPath = path.join(__dirname, 'config.json');
    const defaultAudioFormats = ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac'];
    
    try {
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return config.audioRecording?.audioFormats || defaultAudioFormats;
        }
    } catch (error) {
        console.error('Error loading audio formats:', error);
    }
    return defaultAudioFormats;
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

async function processMedia(mediaPath) {
    const dir = path.dirname(mediaPath);
    const nameNoExt = path.basename(mediaPath, path.extname(mediaPath));
    const srtPath = path.join(dir, `${nameNoExt}.srt`);

    const pythonScript = path.join(__dirname, 'python', 'batch_whisper.py');

    if (!fs.existsSync(pythonScript)) {
        throw new Error(`Python script not found at: ${pythonScript}`);
    }

    if (!fs.existsSync(srtPath)) {
        const fileType = isAudioFile(mediaPath) ? 'Audio' : 'Video';
        console.log(`\n-> [ASR] Generating Subtitles (Whisper)...`);
        console.log(`   Target: ${path.basename(mediaPath)} (${fileType})`);

        await runCommand('python', [pythonScript, mediaPath], {
            env: { ...process.env, PYTHONUTF8: '1' }
        });
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
async function generateAiText(highlightPath) {
    console.log('\n🤖 开始AI文本生成...');
    
    try {
        const result = await aiTextGenerator.generateGoodnightReply(highlightPath);
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
async function generateAiComic(highlightPath) {
    console.log('\n🎨 开始AI漫画生成...');
    
    try {
        const result = await aiComicGenerator.generateComicFromHighlight(highlightPath);
        if (result) {
            console.log(`✅ AI漫画生成完成: ${path.basename(result)}`);
            return result;
        }
    } catch (error) {
        console.error(`⚠️  AI漫画生成失败: ${error.message}`);
    }
    
    return null;
}

// 检查房间是否启用AI功能
function shouldGenerateAiForRoom(roomId) {
    const configPath = path.join(__dirname, 'config.json');
    
    try {
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const roomStr = String(roomId);
            
            if (config.roomSettings && config.roomSettings[roomStr]) {
                const roomConfig = config.roomSettings[roomStr];
                return {
                    text: roomConfig.enableTextGeneration !== false,
                    comic: roomConfig.enableComicGeneration !== false
                };
            }
        }
    } catch (error) {
        console.error('Error checking room AI settings:', error);
    }
    
    // 默认启用所有AI功能
    return { text: true, comic: true };
}

// 从文件名提取房间ID
function extractRoomIdFromFilename(filename) {
    const match = filename.match(/^(\d+)_/);
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
            
            await runCommand('node', [nodeScript, ...filesToProcess]);
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
            const roomId = extractRoomIdFromFilename(highlightFile);
            
            console.log(`📌 处理 do_fusion_summary 生成的文件: ${highlightFile}`);
            console.log(`\n--- 处理: ${highlightFile} ---`);
            
            // 检查房间AI设置
            const aiSettings = roomId ? shouldGenerateAiForRoom(roomId) : { text: true, comic: true };
            
            if (roomId) {
                console.log(`🏠 房间ID: ${roomId}`);
                console.log(`   AI文本生成: ${aiSettings.text ? '启用' : '禁用'}`);
                console.log(`   AI漫画生成: ${aiSettings.comic ? '启用' : '禁用'}`);
            }
            
            // AI文本生成
            if (aiSettings.text) {
                await generateAiText(highlightPath);
            } else {
                console.log('ℹ️  跳过AI文本生成（房间设置禁用）');
            }
            
            // AI漫画生成
            if (aiSettings.comic) {
                await generateAiComic(highlightPath);
            } else {
                console.log('ℹ️  跳过AI漫画生成（房间设置禁用）');
            }
        } else {
            console.log('⚠️  未找到 do_fusion_summary 生成的 AI_HIGHLIGHT 文件');
        }
    } catch (error) {
        console.error(`⚠️  AI生成阶段出错: ${error.message}`);
    }

    console.log('');
    console.log('===========================================');
    console.log('       所有任务完成！                      ');
    console.log('===========================================');
    
    if (filesToProcess.length > 0) {
        console.log(`输出目录: ${outputDir}`);
        
        // 列出生成的文件
        try {
            const files = fs.readdirSync(outputDir);
            const generatedFiles = files.filter(f => 
                f.includes('_晚安回复.md') || 
                f.includes('_COMIC_FACTORY.') ||
                f.includes('_AI_HIGHLIGHT.txt')
            );
            
            if (generatedFiles.length > 0) {
                console.log('\n📁 生成的文件:');
                generatedFiles.forEach(file => {
                    const filePath = path.join(outputDir, file);
                    const stats = fs.statSync(filePath);
                    const size = (stats.size / 1024).toFixed(1);
                    console.log(`   ${file} (${size}KB)`);
                });
            }
        } catch (error) {
            // 忽略文件列表错误
        }
    }

    // 检查是否在自动化模式
    if (process.env.NODE_ENV === 'automation' || process.env.CI) {
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