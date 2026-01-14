const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const stat = promisify(fs.stat);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 配置文件加载函数
function loadConfig() {
    const configPath = path.join(__dirname, 'config.json');
    const defaultConfig = {
        audioRecording: {
            enabled: true,
            audioOnlyRooms: [],
            audioFormats: ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac'],
            defaultFormat: '.m4a'
        },
        timeouts: {
            fixVideoWait: 60000,
            fileStableCheck: 30000,
            processTimeout: 1800000
        },
        recorders: {
            ddtv: {
                enabled: true,
                endpoint: '/ddtv'
            },
            mikufans: {
                enabled: true,
                endpoint: '/mikufans',
                basePath: 'D:/files/videos/DDTV录播'
            }
        }
    };

    try {
        if (fs.existsSync(configPath)) {
            const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return { ...defaultConfig, ...userConfig };
        }
    } catch (error) {
        console.error('Error loading config:', error);
    }
    return defaultConfig;
}

function getRecorderConfig(recorderName) {
    const config = loadConfig();
    return config.recorders[recorderName] || null;
}

function getTimeoutConfig() {
    const config = loadConfig();
    return config.timeouts;
}

function isAudioOnlyRoom(roomId) {
    const config = loadConfig();
    return config.audioRecording.enabled &&
           config.audioRecording.audioOnlyRooms.includes(parseInt(roomId));
}

const app = express();
const PORT = 15121;

// 防止重复处理的缓存 Set
const processedFiles = new Set();

// mikufans 会话文件跟踪 Map: sessionId -> fileList
const sessionFiles = new Map();

// 增加请求体大小限制，防止超大 JSON 报错
app.use(express.json({ limit: '50mb' }));

// JavaScript 脚本路径 - 使用增强版脚本
const JS_SCRIPT_PATH = path.join(__dirname, 'enhanced_auto_summary.js');

/**
 * 等待文件大小稳定
 * 先等待30秒避免干扰写入，然后每6秒检查一次，连续两次大小不变则认为稳定
 */
async function waitFileStable(filePath) {
    if (!fs.existsSync(filePath)) return false;

    console.log(`⏳ 开始检查文件稳定性: ${path.basename(filePath)}`);

    // 先等待30秒，避免干扰DDTV5的写入过程
    console.log(`⏳ 倒计时开始：30秒后开始文件大小检查`);
    for (let i = 30; i > 0; i -= 5) {
        console.log(`⏳ 倒计时：${i}秒`);
        await sleep(5000);
    }

    let lastSize = -1;
    let stableCount = 0;
    const MAX_WAIT_STABLE = 2; // 连续 2 次大小相同
    const CHECK_INTERVAL = 6000; // 6 秒检查一次

    while (stableCount < MAX_WAIT_STABLE) {
        try {
            const stats = await stat(filePath);
            const currentSize = stats.size;
            
            if (currentSize === lastSize && currentSize > 0) {
                stableCount++;
                console.log(`[稳定性检查] ${path.basename(filePath)} 大小未变化 (${stableCount}/${MAX_WAIT_STABLE})`);
            } else {
                stableCount = 0;
                lastSize = currentSize;
                console.log(`[稳定性检查] ${path.basename(filePath)} 大小还在变化: ${currentSize} 字节`);
            }
        } catch (e) {
            console.error(`[稳定性检查] 错误: ${e.message}`);
        }
        
        if (stableCount < MAX_WAIT_STABLE) {
            await sleep(CHECK_INTERVAL);
        }
    }
    console.log(`✅ 文件已稳定: ${path.basename(filePath)}`);
    return true;
}

/**
 * 弹出 Windows 弹窗提醒
 */
function showWindowsNotification(title, message) {
    const psCommand = `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('${message}', '${title}', 'OK', 'Warning')`;
    spawn('powershell.exe', ['-Command', psCommand], { windowsHide: true });
}

/**
 * 处理单个mikufans文件
 */
async function processMikufansFile(filePath) {
    const fileName = path.basename(filePath);

    // 检查去重
    if (processedFiles.has(filePath)) {
        console.log(`⚠️ 跳过：文件已在处理队列中 -> ${fileName}`);
        return;
    }

    // 加入去重缓存
    processedFiles.add(filePath);
    setTimeout(() => processedFiles.delete(filePath), 3600 * 1000);

    console.log(`✅ 文件已稳定，开始处理: ${fileName}`);

    // 查找对应的xml文件（如果有）
    let targetXml = null;
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));

    // 尝试查找同目录下的xml文件
    const xmlPattern = path.join(dir, '*.xml');
    try {
        const files = fs.readdirSync(dir);
        const xmlFiles = files.filter(f => f.endsWith('.xml') && f.includes(baseName.split('-')[0]));
        if (xmlFiles.length > 0) {
            targetXml = path.join(dir, xmlFiles[0]);
            console.log(`📄 找到对应的弹幕文件: ${path.basename(targetXml)}`);
        }
    } catch (error) {
        console.log(`ℹ️ 未找到弹幕文件: ${error.message}`);
    }

    // 启动处理流程
    const jsArgs = [JS_SCRIPT_PATH, filePath];
    if (targetXml) jsArgs.push(targetXml);

    console.log('🚀 启动mikufans处理流程...');

    const ps = spawn('node', jsArgs, {
        cwd: __dirname,
        windowsHide: true,
        env: { ...process.env, NODE_ENV: 'automation' }
    });

    const timeouts = getTimeoutConfig();
    const processTimeout = setTimeout(() => {
        console.log(`⏰ 进程超时，强制终止并清理队列: ${fileName}`);
        ps.kill('SIGTERM');
        processedFiles.delete(filePath);
    }, timeouts.processTimeout || 1800000);

    ps.stdout.on('data', (d) => console.log(`[Mikufans PS] ${d.toString().trim()}`));
    ps.stderr.on('data', (d) => console.error(`[Mikufans PS ERR] ${d.toString().trim()}`));

    ps.on('error', (err) => {
        console.error(`💥 mikufans进程错误: ${err.message}`);
        clearTimeout(processTimeout);
        processedFiles.delete(filePath);
    });

    ps.on('close', (code) => {
        clearTimeout(processTimeout);
        console.log(`🏁 mikufans流程结束 (Exit: ${code})`);
        setTimeout(() => processedFiles.delete(filePath), 5000);
    });
}

app.post('/ddtv', (req, res) => {
    const payload = req.body;
    const cmd = payload.cmd || 'Unknown';
    const eventTime = new Date().toLocaleString();

    // ============================================================
    // 🔍 调试日志区域：打印所有细节 (除了配置变更)
    // ============================================================

    // 对于配置变更事件，只打印简短信息
    if (cmd === 'ModifyConfiguration' || cmd === 'UpdateToConfigurationFile') {
        console.log(`\n📅 ${eventTime} | ⚙️ 配置变更: ${payload.message || '未知配置'}`);
        return res.send('Configuration change logged');
    }

    console.log(`\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`);
    console.log(`📅 时间: ${eventTime}`);
    console.log(`📨 事件 (cmd): ${cmd}`);

    // 尝试提取主播名字，方便你看是谁触发的
    const roomName = payload.data?.Name || payload.room_info?.uname || '未知主播';
    console.log(`👤 主播: ${roomName}`);

    // 🔥 核心：打印完整的 Payload 结构，让你看清楚格式
    // 可能会很长，但这是你现在需要的
    console.log(`📦 完整数据结构:`);

    // 通用函数：压缩数组显示（第一条、统计、最后一条）
    function compressArray(arr, fieldName) {
        if (!Array.isArray(arr) || arr.length === 0) {
            return arr;
        }
        if (arr.length === 1) {
            return arr; // 只有1条，显示完整
        }
        // >=2条：显示第一条、统计信息、最后一条
        return [
            arr[0],
            {
                _summary: `${fieldName}统计`,
                _total: arr.length,
                _omitted: arr.length - 2
            },
            arr[arr.length - 1]
        ];
    }

    // 通用函数：递归查找并压缩弹幕数据
    function compressDanmuData(obj) {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }

        // 如果是数组，直接返回（不处理数组本身）
        if (Array.isArray(obj)) {
            return obj;
        }

        const result = Array.isArray(obj) ? [...obj] : { ...obj };

        // 检查是否是弹幕消息对象（包含Danmu、SuperChat、Gift、GuardBuy字段）
        if (result.Danmu || result.SuperChat || result.Gift || result.GuardBuy) {
            if (Array.isArray(result.Danmu)) {
                result.Danmu = compressArray(result.Danmu, '弹幕');
            }
            if (Array.isArray(result.SuperChat)) {
                result.SuperChat = compressArray(result.SuperChat, 'SC');
            }
            if (Array.isArray(result.Gift)) {
                result.Gift = compressArray(result.Gift, '礼物');
            }
            if (Array.isArray(result.GuardBuy)) {
                result.GuardBuy = compressArray(result.GuardBuy, '舰长');
            }
        }

        // 递归处理所有子对象
        for (const key in result) {
            if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
                result[key] = compressDanmuData(result[key]);
            }
        }

        return result;
    }

    // 对所有payload进行通用压缩处理
    let displayPayload = JSON.parse(JSON.stringify(payload)); // 深拷贝
    displayPayload = compressDanmuData(displayPayload);

    displayPayload = compressDanmuData(displayPayload);

    console.log(JSON.stringify(displayPayload, null, 2));
    console.log(`▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`);

    // 处理登陆失效
    if (cmd === 'InvalidLoginStatus') {
        const msg = payload.message || '触发登陆失效事件';
        console.log(`⚠️ 登陆失效提醒: ${msg}`);
        showWindowsNotification('DDTV 提醒', `登录态已失效！\n\n${msg}\n\n请尽快处理以免影响弹幕录制。`);
        return res.send('Login invalid notification shown');
    }

    // ============================================================
    // 下面是原本的处理逻辑
    // ============================================================
    
    (async () => {
        let videoFiles = [];
        let xmlFiles = [];

    // 1. 尝试从 data.DownInfo.DownloadFileList 提取 (DDTV5 常见结构)
    const downInfo = payload.data?.DownInfo;
    const downloadFileList = downInfo?.DownloadFileList;

    if (downloadFileList) {
        if (Array.isArray(downloadFileList.VideoFile)) {
            videoFiles = downloadFileList.VideoFile.filter(f => f.endsWith('.mp4'));
        }
        if (Array.isArray(downloadFileList.DanmuFile)) {
            xmlFiles = downloadFileList.DanmuFile.filter(f => f.endsWith('.xml'));
        }
    } 
    // 2. 尝试从 files 提取 (部分版本或 webhookGo 转发结构)
    else if (payload.files && Array.isArray(payload.files)) {
        payload.files.forEach(f => {
            const fPath = f.path || f; // 兼容 {path: string} 或 string
            if (typeof fPath === 'string') {
                if (fPath.endsWith('.mp4')) videoFiles.push(fPath);
                if (fPath.endsWith('.xml')) xmlFiles.push(fPath);
            }
        });
    }

    // ------------------------------------------------------------
    // 筛选与处理
    // ------------------------------------------------------------

    // 特殊处理SaveBulletScreenFile事件 - 虽然没有完整的视频文件列表，但有xml和original视频路径
    if (videoFiles.length === 0 && cmd === 'SaveBulletScreenFile') {
        // 提取xml文件
        if (Array.isArray(downloadFileList?.DanmuFile)) {
            xmlFiles = downloadFileList.DanmuFile.filter(f => f.endsWith('.xml'));
        }

        // 从CurrentOperationVideoFile推导fix视频路径
        const currentOpVideo = downloadFileList?.CurrentOperationVideoFile;
        if (currentOpVideo && xmlFiles.length > 0) {
            const originalVideoPath = path.normalize(currentOpVideo);
            const fixVideoPath = originalVideoPath.replace('_original.mp4', '_fix.mp4');

            console.log(`🔄 SaveBulletScreenFile事件：等待fix视频生成... (${path.basename(fixVideoPath)})`);

            // 立即检查去重，避免重复触发
            if (processedFiles.has(fixVideoPath)) {
                console.log(`⚠️ 跳过：文件已在处理队列中 -> ${path.basename(fixVideoPath)}`);
                return;
            }

            // 等待文件创建（使用配置的超时参数）
            const timeouts = getTimeoutConfig();
            const maxWaitTime = timeouts.fixVideoWait || 60000; // 60秒
            const checkInterval = 5000; // 每5秒检查一次
            let waitedTime = 0;
            let fileFound = false;
            
            console.log(`⏳ 等待fix视频文件生成，最多等待${maxWaitTime/1000}秒...`);
            
            while (waitedTime < maxWaitTime && !fileFound) {
                await sleep(checkInterval);
                waitedTime += checkInterval;
                
                if (fs.existsSync(fixVideoPath)) {
                    fileFound = true;
                    console.log(`✅ 发现fix视频文件 (等待了${waitedTime/1000}秒): ${path.basename(fixVideoPath)}`);
                    break;
                }
                
                console.log(`⏳ 等待中... ${waitedTime/1000}秒 (${path.basename(fixVideoPath)})`);
            }
            
            if (fileFound) {
                // 等待文件稳定
                const isStable = await waitFileStable(fixVideoPath);
                if (!isStable) {
                    console.log(`❌ 文件稳定性检查失败，跳过处理: ${path.basename(fixVideoPath)}`);
                    return;
                }

                console.log(`✅ 发现fix视频文件且已稳定，开始处理: ${path.basename(fixVideoPath)}`);

                // 加入去重缓存
                processedFiles.add(fixVideoPath);
                setTimeout(() => processedFiles.delete(fixVideoPath), 3600 * 1000);

                    // 启动处理流程
                    const targetXml = path.normalize(xmlFiles[0]);
                    const jsArgs = [JS_SCRIPT_PATH, fixVideoPath];
                    if (targetXml) jsArgs.push(targetXml);

                    console.log('🚀 启动SaveBulletScreenFile处理流程...');

                    const ps = spawn('node', jsArgs, {
                        cwd: __dirname,
                        windowsHide: true,
                        env: { ...process.env, NODE_ENV: 'automation' } // 标记为自动化环境
                    });

                    let saveTimeout = setTimeout(() => {
                        console.log(`⏰ SaveBulletScreenFile进程超时，强制终止并清理队列: ${path.basename(fixVideoPath)}`);
                        ps.kill('SIGTERM');
                        processedFiles.delete(fixVideoPath);
                    }, 30 * 60 * 1000); // 30分钟超时

                    ps.stdout.on('data', (d) => console.log(`[PS] ${d.toString().trim()}`));
                    ps.stderr.on('data', (d) => console.error(`[PS ERR] ${d.toString().trim()}`));

                    ps.on('error', (err) => {
                        console.error(`💥 SaveBulletScreenFile PowerShell进程错误: ${err.message}`);
                        clearTimeout(saveTimeout);
                        processedFiles.delete(fixVideoPath);
                    });

                    ps.on('close', (code) => {
                        clearTimeout(saveTimeout);
                        console.log(`🏁 SaveBulletScreenFile流程结束 (Exit: ${code})`);
                        // 进程结束后立即删除，避免立即重入
                        setTimeout(() => processedFiles.delete(fixVideoPath), 5000); // 5秒后删除，给日志时间输出
                    });
                } else {
                    console.log(`❌ 超时未发现fix视频文件，跳过处理: ${path.basename(fixVideoPath)}`);
                }
            return;
        }
    }

    if (videoFiles.length === 0) {
        console.log('❌ 忽略：未发现视频文件 (可能是配置变更或单纯的状态心跳)');
        return;
    }

    // 优先处理 fix.mp4，如果没有则处理 original.mp4
    let targetVideo = videoFiles.find(f => f.includes('fix.mp4')) || videoFiles[0];
    targetVideo = path.normalize(targetVideo);

    // 检查文件是否存在，如果不存在跳过
    if (!fs.existsSync(targetVideo)) {
        console.log(`❌ 忽略：目标视频文件不存在 -> ${path.basename(targetVideo)}`);
        return;
    }

    if (processedFiles.has(targetVideo)) {
        console.log(`⚠️ 跳过：文件已在处理队列中 -> ${path.basename(targetVideo)}`);
        return;
    }

    // 加入去重缓存 (1小时)
    processedFiles.add(targetVideo);
    setTimeout(() => processedFiles.delete(targetVideo), 3600 * 1000);

    // 等待文件稳定
    const isVideoStable = await waitFileStable(targetVideo);
    if (!isVideoStable) {
        console.log(`❌ 视频文件稳定性检查失败，跳过处理: ${path.basename(targetVideo)}`);
        // 如果稳定性检查失败，立即从缓存中移除，允许下次重试
        processedFiles.delete(targetVideo);
        return;
    }

    // 选择对应的xml文件
    let targetXml = null;
    if (xmlFiles.length > 0) {
        // 尝试通过文件名匹配，如果没有则用第一个
        const videoBaseName = path.basename(targetVideo, path.extname(targetVideo));
        const matchedXml = xmlFiles.find(xml => path.basename(xml, '.xml').includes(videoBaseName.split('_')[0]));
        targetXml = matchedXml ? path.normalize(matchedXml) : path.normalize(xmlFiles[0]);
    }

    const jsArgs = [JS_SCRIPT_PATH, targetVideo];
    if (targetXml) jsArgs.push(targetXml);

    console.log('🚀 启动处理流程...');

    const ps = spawn('node', jsArgs, {
        cwd: __dirname,
        windowsHide: true,
        env: { ...process.env, NODE_ENV: 'automation' } // 标记为自动化环境
    });

    let processTimeout = setTimeout(() => {
        console.log(`⏰ 进程超时，强制终止并清理队列: ${path.basename(targetVideo)}`);
        ps.kill('SIGTERM');
        processedFiles.delete(targetVideo);
    }, 30 * 60 * 1000); // 30分钟超时

    ps.stdout.on('data', (d) => console.log(`[PS] ${d.toString().trim()}`));
    ps.stderr.on('data', (d) => console.error(`[PS ERR] ${d.toString().trim()}`));

    ps.on('error', (err) => {
        console.error(`💥 PowerShell进程错误: ${err.message}`);
        clearTimeout(processTimeout);
        processedFiles.delete(targetVideo);
    });

        ps.on('close', (code) => {
            clearTimeout(processTimeout);
            console.log(`🏁 流程结束 (Exit: ${code})`);
            // 进程结束后立即删除，避免立即重入
            setTimeout(() => processedFiles.delete(targetVideo), 5000); // 5秒后删除，给日志时间输出
        });

    })();

    res.send('Processing Started (or logic branched)');
});

// ============================================================
// mikufans录播姬 Webhook 处理
// ============================================================
app.post('/mikufans', (req, res) => {
    const payload = req.body;
    const eventType = payload.EventType || 'Unknown';
    const eventTime = new Date().toLocaleString();
    
    console.log(`\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`);
    console.log(`📅 时间: ${eventTime}`);
    console.log(`📨 事件 (mikufans): ${eventType}`);
    
    // 提取主播信息
    const roomName = payload.EventData?.Name || '未知主播';
    const roomId = payload.EventData?.RoomId || '未知房间';
    console.log(`👤 主播: ${roomName} (房间: ${roomId})`);
    
    console.log(`📦 完整数据结构:`);
    console.log(JSON.stringify(payload, null, 2));
    console.log(`▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`);
    
    // 处理所有mikufans事件，但只对文件事件和会话事件进行特殊处理
    const sessionId = payload.EventData?.SessionId;
    const recording = payload.EventData?.Recording;

    if (eventType === 'SessionStarted' && recording === true) {
        // 直播开始：初始化会话文件列表
        sessionFiles.set(sessionId, []);
        console.log(`🎬 直播开始: ${roomName} (Session: ${sessionId})`);
        return res.send('Session started logged');
    }

    if (eventType === 'SessionEnded' && recording === false) {
        // 直播结束：处理所有文件
        const fileList = sessionFiles.get(sessionId) || [];
        sessionFiles.delete(sessionId);
        console.log(`🏁 直播结束: ${roomName} (Session: ${sessionId}), 处理 ${fileList.length} 个文件`);

        if (fileList.length > 0) {
            // 异步处理所有文件
            (async () => {
                for (const filePath of fileList) {
                    await processMikufansFile(filePath);
                }
            })();
        }
        return res.send('Session ended logged');
    }

    // 只处理文件关闭事件
    if (eventType !== 'FileClosed') {
        console.log(`ℹ️ 忽略非文件事件: ${eventType}`);
        return res.send('Event logged (non-file event ignored)');
    }
    
    // 获取mikufans配置
    const mikufansConfig = getRecorderConfig('mikufans');
    if (!mikufansConfig || !mikufansConfig.enabled) {
        console.log('❌ mikufans录播姬支持未启用或配置错误');
        return res.send('Mikufans recorder not enabled');
    }
    
    const relativePath = payload.EventData?.RelativePath;
    if (!relativePath) {
        console.log('❌ 未找到RelativePath字段');
        return res.send('No RelativePath found');
    }
    
    // 构建完整文件路径
    const basePath = mikufansConfig.basePath || 'D:/files/videos/DDTV录播';
    const fullPath = path.join(basePath, relativePath);
    const normalizedPath = path.normalize(fullPath);
    
    console.log(`📁 文件路径: ${normalizedPath}`);
    
    // 检查文件扩展名
    const ext = path.extname(normalizedPath).toLowerCase();
    const supportedExtensions = ['.mp4', '.flv', '.mkv', '.ts', '.mov', '.m4a', '.aac', '.mp3', '.wav'];
    
    if (!supportedExtensions.includes(ext)) {
        console.log(`❌ 不支持的文件类型: ${ext}`);
        return res.send('Unsupported file type');
    }
    
    // 异步处理文件事件
    (async () => {
        // 对于FileClosed事件，检查Recording状态
        if (recording === true) {
            // 直播仍在继续，只添加到会话列表，不等待稳定
            if (sessionFiles.has(sessionId)) {
                sessionFiles.get(sessionId).push(normalizedPath);
                console.log(`📝 文件添加到会话列表 (直播继续): ${path.basename(normalizedPath)} (Session: ${sessionId})`);
            }
        } else {
            // 直播已结束，等待稳定后直接处理该文件
            console.log(`🔄 FileClosed事件：检查文件稳定... (${path.basename(normalizedPath)})`);
            const isStable = await waitFileStable(normalizedPath);
            if (!isStable) {
                console.log(`❌ 文件稳定性检查失败: ${path.basename(normalizedPath)}`);
                return;
            }
            console.log(`🏁 直播结束，立即处理文件: ${path.basename(normalizedPath)}`);
            await processMikufansFile(normalizedPath);
        }
    })();
    
    res.send('Mikufans processing started');
});

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`DDTV 监听服务 (增强版) 已启动`);
    console.log(`DDTV 端点: http://localhost:${PORT}/ddtv`);
    console.log(`mikufans 端点: http://localhost:${PORT}/mikufans`);
    console.log(`==================================================\n`);
});
