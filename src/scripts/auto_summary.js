#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const configLoader = require('./config-loader');

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
        const child = spawn(command, args, { windowsHide: true, ...options, stdio: 'inherit' });
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

const main = async () => {
    const inputPaths = process.argv.slice(2);

    if (inputPaths.length === 0) {
        console.error('X Error: No files detected! Please drag files onto the icon.');
        process.exit(1);
    }

    console.log('===========================================');
    console.log('      Live Summary 自动化工厂 (Watchdog 启用)       ');
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

    // Process Media (ASR)
    const srtFiles = await Promise.all(mediaFiles.map(processMedia));
    srtFiles.forEach(srtPath => {
        if (srtPath) {
            filesToProcess.push(srtPath);
        }
    });

    console.log('\n--------------------------------------------');

    // Node.js Fusion
    if (filesToProcess.length === 0) {
        console.log('X Warning: No valid SRT or XML files to process.');
    } else {
        console.log('-> [Fusion] Merging Subtitles and Danmaku...');

        const nodeScript = path.join(__dirname, 'do_fusion_summary.js');

        if (!fs.existsSync(nodeScript)) {
            console.error(`X Error: Node.js script not found at: ${nodeScript}`);
        } else {
            await runCommand('node', [nodeScript, ...filesToProcess]);
        }
    }

    console.log('');
    console.log('===========================================');
    console.log('       All Tasks Completed!                 ');
    if (filesToProcess.length > 0) {
        const outDir = path.dirname(filesToProcess[0]);
        console.log(`Output Dir: ${outDir}`);
    }
    console.log('===========================================');

    // Check if in automation mode
    if (process.env.NODE_ENV === 'automation' || process.env.CI) {
        process.exit(0);
    } else {
        // Interactive mode, wait for user
        console.log('Press Enter to close...');
        process.stdin.resume();
        process.stdin.on('data', () => {
            process.exit(0);
        });
    }
}

(async () => {
    await main();
})();