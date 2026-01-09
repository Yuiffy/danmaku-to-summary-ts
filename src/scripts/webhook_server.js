const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 15121;

// 防止重复处理的缓存 Set (保存最近处理过的文件路径)
const processedFiles = new Set();

app.use(express.json());

// PowerShell 脚本路径
const PS_SCRIPT_PATH = path.join(__dirname, 'auto_summary.ps1');

app.post('/ddtv', (req, res) => {
    const payload = req.body;

    // 1. 打印简略日志，避免刷屏
    const cmd = payload.cmd || 'Unknown';
    console.log(`\n[${new Date().toLocaleString()}] 收到 Webhook: ${cmd}`);
    
    // ============================================================
    // 核心修改：适配你的日志结构 (data -> DownInfo -> DownloadFileList)
    // ============================================================
    
    let videoFiles = [];
    let xmlFiles = [];

    // 尝试从不同的位置提取文件列表
    const downInfo = payload.data?.DownInfo;
    const downloadFileList = downInfo?.DownloadFileList;

    if (downloadFileList) {
        // 提取视频 (优先找 .mp4)
        if (Array.isArray(downloadFileList.VideoFile)) {
            videoFiles = downloadFileList.VideoFile.filter(f => f.endsWith('.mp4'));
        }
        // 提取弹幕
        if (Array.isArray(downloadFileList.DanmuFile)) {
            xmlFiles = downloadFileList.DanmuFile.filter(f => f.endsWith('.xml'));
        }
    } else if (payload.files) {
        // 兼容旧版/通用结构
        payload.files.forEach(f => {
            if (f.path.endsWith('.mp4')) videoFiles.push(f.path);
            if (f.path.endsWith('.xml')) xmlFiles.push(f.path);
        });
    }

    // ============================================================
    // 2. 筛选最佳视频文件
    // ============================================================
    
    if (videoFiles.length === 0) {
        console.log('-> 忽略：当前事件中未找到视频文件 (可能是下播/仅弹幕保存)');
        return res.send('Ignored: No video files');
    }

    // 你的日志里同时出现了 original.mp4 和 fix.mp4
    // 逻辑：如果有 fix.mp4 (修复版)，优先用它；否则用 original.mp4
    let targetVideo = videoFiles.find(f => f.includes('fix.mp4')) || videoFiles[0];

    // 标准化路径 (Windows 斜杠转换)
    targetVideo = path.normalize(targetVideo);

    // ============================================================
    // 3. 关键：去重检查
    // ============================================================
    
    if (processedFiles.has(targetVideo)) {
        console.log(`-> 跳过：该文件已在处理队列中或已处理 -> ${path.basename(targetVideo)}`);
        return res.send('Ignored: Already processed');
    }

    // ============================================================
    // 4. 寻找匹配的 XML
    // ============================================================
    
    // 优先从 Payload 里找
    let targetXml = xmlFiles.length > 0 ? path.normalize(xmlFiles[0]) : null;

    // 如果 Payload 里没弹幕，但在本地硬盘能推导出来，也可以用
    if (!targetXml) {
        const potentialXml = targetVideo.replace(/\.(mp4|flv|mkv|ts)$/i, '.xml'); // 也可以尝试 _1.xml
        // 这里只是简单推导，你的 ps1 脚本其实也会自己找，所以这里传 null 也没关系
        if (fs.existsSync(potentialXml)) {
            targetXml = potentialXml;
        } else {
            // 尝试 _1.xml (你的日志里弹幕经常带 _1)
            const potentialXml1 = targetVideo.replace(/\.(mp4|flv|mkv|ts)$/i, '_1.xml');
            if(fs.existsSync(potentialXml1)) targetXml = potentialXml1;
        }
    }

    console.log(`-> 🎯 命中目标: ${path.basename(targetVideo)}`);
    if(targetXml) console.log(`   关联弹幕: ${path.basename(targetXml)}`);

    // ============================================================
    // 5. 启动处理
    // ============================================================

    // 加入缓存，防止重复触发
    processedFiles.add(targetVideo);
    
    // 1小时后清除缓存，防止内存无限增长 (虽然 Set 存字符串占不了多少内存)
    setTimeout(() => processedFiles.delete(targetVideo), 3600 * 1000);

    const psArgs = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', PS_SCRIPT_PATH,
        targetVideo
    ];

    if (targetXml) {
        psArgs.push(targetXml);
    }

    console.log('-> 🚀 启动 PowerShell 流水线...');

    const ps = spawn('powershell.exe', psArgs, {
        cwd: path.dirname(PS_SCRIPT_PATH),
        windowsHide: true
    });

    ps.stdout.on('data', (data) => console.log(`[PS] ${data.toString().trim()}`));
    ps.stderr.on('data', (data) => console.error(`[PS ERR] ${data.toString().trim()}`));
    ps.on('close', (code) => console.log(`-> ✅ 任务完成，退出码: ${code}`));

    res.send('Processing Started');
});

app.listen(PORT, () => {
    console.log(`DDTV 监听服务 (Deep Fix版) 已启动: http://localhost:${PORT}/ddtv`);
});
