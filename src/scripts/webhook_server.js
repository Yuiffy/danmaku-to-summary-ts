// src/scripts/webhook_server.js
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000; // 你可以在这里修改端口

// 中间件解析 JSON body
app.use(express.json());

// 你的 PowerShell 脚本绝对路径 (根据你的实际部署位置动态获取)
const PS_SCRIPT_PATH = path.join(__dirname, 'auto_summary.ps1');

app.post('/ddtv', (req, res) => {
    const payload = req.body;

    // 打印日志方便调试
    console.log(`[${new Date().toLocaleString()}] 收到 Webhook:`, JSON.stringify(payload, null, 2));

    // DDTV 5 的 Webhook 结构通常包含 EventType
    // 核心事件通常是 "FileDownloadComplete" 或 "RecordingComplete" (具体视版本而定)
    // 或者是 Shell 脚本钩子触发的，这里假设是通用 Webhook
    const eventType = payload.EventType || payload.type;

    // 根据 DDTV 文档，录制完成通常会有视频文件路径
    // 假设 payload.VideoFile 是视频路径 (如果不确定，先运行一次看 console.log)
    const videoPath = payload.VideoFile || payload.data?.path;

    if (!videoPath) {
        console.log('-> 忽略：未在 Payload 中找到视频路径');
        return res.status(200).send('Ignored: No video path');
    }

    // 只有录制完成才处理
    if (eventType !== 'FileDownloadComplete' && eventType !== 'DownloadComplete') {
        console.log(`-> 忽略：事件类型 ${eventType} 不是录制完成`);
        return res.status(200).send('Ignored: Not a completion event');
    }

    console.log(`-> 检测到视频文件: ${videoPath}`);

    // 1. 推导 XML 文件路径 (DDTV 通常是同名 xml)
    const xmlPath = videoPath.replace(/\.(mp4|flv|mkv|ts)$/i, '.xml');

    // 2. 准备传给 PowerShell 的参数
    // auto_summary.ps1 接受 InputPaths 数组
    const args = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', PS_SCRIPT_PATH,
        videoPath // 传入视频
    ];

    // 如果对应的 XML 存在，也传进去，这样 ps1 里的分类逻辑就能把它们关联起来
    if (fs.existsSync(xmlPath)) {
        console.log(`-> 检测到同名 XML: ${xmlPath}`);
        args.push(xmlPath);
    } else {
        console.warn('->以此视频未找到同名 XML，可能只有字幕生成');
    }

    console.log('-> 正在启动 PowerShell 流水线...');

    // 3. 启动 PowerShell 子进程
    const ps = spawn('powershell.exe', args, {
        cwd: path.dirname(PS_SCRIPT_PATH) // 确保工作目录在脚本所在目录，方便它找 python/node 兄弟脚本
    });

    // 实时输出日志
    ps.stdout.on('data', (data) => {
        console.log(`[PS] ${data.toString().trim()}`);
    });

    ps.stderr.on('data', (data) => {
        console.error(`[PS Error] ${data.toString().trim()}`);
    });

    ps.on('close', (code) => {
        console.log(`-> 流水线执行完毕，退出码: ${code}`);
    });

    res.status(200).send('Processing started');
});

app.listen(PORT, () => {
    console.log(`DDTV 自动化监听服务已启动: http://localhost:${PORT}/ddtv`);
    console.log(`脚本路径: ${PS_SCRIPT_PATH}`);
});
