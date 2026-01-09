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

    // 对于包含弹幕详细内容的StopLiveEvent和ModifyRoomRecordingConfiguration，过滤掉详细的弹幕内容，只显示数量统计
    let displayPayload = payload;
    if (cmd === 'StopLiveEvent' || cmd === 'ModifyRoomRecordingConfiguration') {
        let danmuMsgPath = null;

        // StopLiveEvent的路径：data.DownInfo.DanmuMessage.LiveChatListener.DanmuMessage
        if (payload.data?.DownInfo?.DanmuMessage?.LiveChatListener?.DanmuMessage) {
            danmuMsgPath = payload.data.DownInfo.DanmuMessage.LiveChatListener.DanmuMessage;
        }
        // ModifyRoomRecordingConfiguration的路径：data.DownInfo.LiveChatListener.DanmuMessage
        else if (payload.data?.DownInfo?.LiveChatListener?.DanmuMessage) {
            danmuMsgPath = payload.data.DownInfo.LiveChatListener.DanmuMessage;
        }

        if (danmuMsgPath) {
            const filteredPayload = JSON.parse(JSON.stringify(payload)); // 深拷贝
            let filteredDanmuMsg = null;

            if (filteredPayload.data?.DownInfo?.DanmuMessage?.LiveChatListener?.DanmuMessage) {
                filteredDanmuMsg = filteredPayload.data.DownInfo.DanmuMessage.LiveChatListener.DanmuMessage;
            } else if (filteredPayload.data?.DownInfo?.LiveChatListener?.DanmuMessage) {
                filteredDanmuMsg = filteredPayload.data.DownInfo.LiveChatListener.DanmuMessage;
            }

            if (filteredDanmuMsg) {
                // 只保留数量统计，不显示具体内容
                if (Array.isArray(danmuMsgPath.Danmu)) {
                    filteredDanmuMsg.Danmu = `[${danmuMsgPath.Danmu.length}条弹幕]`;
                }
                if (Array.isArray(danmuMsgPath.SuperChat)) {
                    filteredDanmuMsg.SuperChat = `[${danmuMsgPath.SuperChat.length}条SC]`;
                }
                if (Array.isArray(danmuMsgPath.Gift)) {
                    filteredDanmuMsg.Gift = `[${danmuMsgPath.Gift.length}条礼物]`;
                }
                if (Array.isArray(danmuMsgPath.GuardBuy)) {
                    filteredDanmuMsg.GuardBuy = `[${danmuMsgPath.GuardBuy.length}条舰长]`;
                }
            }

            displayPayload = filteredPayload;
        }
    }

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
                        windowsHide: true
                    });

                    ps.stdout.on('data', (d) => console.log(`[PS] ${d.toString().trim()}`));
                    ps.stderr.on('data', (d) => console.error(`[PS ERR] ${d.toString().trim()}`));
                    ps.on('close', (code) => console.log(`🏁 SaveBulletScreenFile流程结束 (Exit: ${code})`));
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
        windowsHide: true
    });

    ps.stdout.on('data', (d) => console.log(`[PS] ${d.toString().trim()}`));
    ps.stderr.on('data', (d) => console.error(`[PS ERR] ${d.toString().trim()}`));
    ps.on('close', (code) => console.log(`🏁 流程结束 (Exit: ${code})`));

    res.send('Processing Started');
});

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`DDTV 监听服务 (调试版) 已启动: http://localhost:${PORT}/ddtv`);
    console.log(`现在所有 Webhook 内容都会完整打印在日志里`);
    console.log(`==================================================\n`);
});
