const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 15121;

// 防止重复处理的缓存 Set
const processedFiles = new Set();

// 增加请求体大小限制，防止超大 JSON 报错
app.use(express.json({ limit: '50mb' }));

// PowerShell 脚本路径
const PS_SCRIPT_PATH = path.join(__dirname, 'auto_summary.ps1');

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

    console.log(JSON.stringify(displayPayload, null, 2));
    console.log(`▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`);

    // ============================================================
    // 下面是原本的处理逻辑
    // ============================================================
    
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

            // 异步检查fix视频文件
            setTimeout(() => {
                if (fs.existsSync(fixVideoPath)) {
                    console.log(`✅ 发现fix视频文件，开始处理: ${path.basename(fixVideoPath)}`);

                    if (processedFiles.has(fixVideoPath)) {
                        console.log(`⚠️ 跳过：文件已在处理队列中 -> ${path.basename(fixVideoPath)}`);
                        return;
                    }

                    // 加入去重缓存
                    processedFiles.add(fixVideoPath);
                    setTimeout(() => processedFiles.delete(fixVideoPath), 3600 * 1000);

                    // 启动处理流程
                    const targetXml = path.normalize(xmlFiles[0]);
                    const psArgs = [
                        '-NoProfile',
                        '-ExecutionPolicy', 'Bypass',
                        '-File', PS_SCRIPT_PATH,
                        fixVideoPath
                    ];
                    if (targetXml) psArgs.push(targetXml);

                    console.log('🚀 启动SaveBulletScreenFile处理流程...');

                    const ps = spawn('powershell.exe', psArgs, {
                        cwd: path.dirname(PS_SCRIPT_PATH),
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
            }, 3000); // 等待3秒

            return res.send('Processing SaveBulletScreenFile (waiting for fix file)');
        }
    }

    if (videoFiles.length === 0) {
        console.log('❌ 忽略：未发现视频文件 (可能是配置变更或单纯的状态心跳)');
        return res.send('Ignored: No video files');
    }

    // 优先处理 fix.mp4，如果没有则处理 original.mp4
    let targetVideo = videoFiles.find(f => f.includes('fix.mp4')) || videoFiles[0];
    targetVideo = path.normalize(targetVideo);

    if (processedFiles.has(targetVideo)) {
        console.log(`⚠️ 跳过：文件已在处理队列中 -> ${path.basename(targetVideo)}`);
        return res.send('Ignored: Already processed');
    }

    // 寻找弹幕
    let targetXml = xmlFiles.length > 0 ? path.normalize(xmlFiles[0]) : null;
    if (!targetXml) {
        // 推导逻辑
        const potentialXml = targetVideo.replace(/\.(mp4|flv|mkv|ts)$/i, '.xml');
        if (fs.existsSync(potentialXml)) targetXml = potentialXml;
        else {
            const potentialXml1 = targetVideo.replace(/\.(mp4|flv|mkv|ts)$/i, '_1.xml');
            if(fs.existsSync(potentialXml1)) targetXml = potentialXml1;
        }
    }

    console.log(`✅ 捕获录制完成: ${path.basename(targetVideo)}`);

    // 加入去重缓存 (1小时)
    processedFiles.add(targetVideo);
    setTimeout(() => processedFiles.delete(targetVideo), 3600 * 1000);

    const psArgs = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', PS_SCRIPT_PATH,
        targetVideo
    ];
    if (targetXml) psArgs.push(targetXml);

    console.log('🚀 启动处理流程...');

    const ps = spawn('powershell.exe', psArgs, {
        cwd: path.dirname(PS_SCRIPT_PATH),
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

    res.send('Processing Started');
});

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`DDTV 监听服务 (调试版) 已启动: http://localhost:${PORT}/ddtv`);
    console.log(`现在所有 Webhook 内容都会完整打印在日志里`);
    console.log(`==================================================\n`);
});
