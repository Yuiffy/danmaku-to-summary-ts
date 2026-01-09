const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 15121;

app.use(express.json());

// PowerShell 脚本路径
const PS_SCRIPT_PATH = path.join(__dirname, 'auto_summary.ps1');

app.post('/ddtv', (req, res) => {
    const payload = req.body;

    // 1. 打印完整日志，方便观察真实结构
    console.log(`\n[${new Date().toLocaleString()}] 收到 Webhook 请求:`);
    console.log(JSON.stringify(payload, null, 2));

    // ============================================================
    // 参考 Janet-Baker/webhookGo 的解析逻辑
    // ============================================================
    
    // 检查 hook_type 是否为 DDTV (通常是 "DDTV")
    if (payload.hook_type && payload.hook_type !== 'DDTV') {
        console.log('-> 忽略：非 DDTV 类型 Webhook');
        return res.send('Ignored: Not DDTV hook_type');
    }

    // 检查是否有 files 数组 (这是核心判断依据)
    const files = payload.files;
    if (!files || !Array.isArray(files) || files.length === 0) {
        console.log('-> 忽略：Payload 中没有文件列表 (可能是开播/下播事件)');
        return res.send('Ignored: No files in payload');
    }

    // 2. 从 files 数组中分离视频和弹幕
    let videoPath = null;
    let xmlPath = null;

    // 常见的视频后缀
    const videoExtensions = ['.mp4', '.flv', '.mkv', '.ts'];

    files.forEach(file => {
        const filePath = file.path; // Go结构体中是 Path 字段
        const ext = path.extname(filePath).toLowerCase();

        if (videoExtensions.includes(ext)) {
            videoPath = filePath;
        } else if (ext === '.xml') {
            xmlPath = filePath;
        }
    });

    // 3. 校验逻辑
    if (!videoPath) {
        console.log('-> 忽略：文件列表中未找到视频文件');
        return res.send('Ignored: No video file found');
    }

    console.log(`-> 🎯 捕获目标:`);
    console.log(`   视频: ${videoPath}`);
    console.log(`   弹幕: ${xmlPath || '未在 Payload 中找到 (将尝试自动推导)'}`);

    // 如果 Payload 里没带 XML，尝试在本地通过文件名推导一下
    if (!xmlPath) {
        const potentialXml = videoPath.replace(/\.(mp4|flv|mkv|ts)$/i, '.xml');
        if (fs.existsSync(potentialXml)) {
            xmlPath = potentialXml;
            console.log(`   推导: 本地发现同名 XML -> ${xmlPath}`);
        }
    }

    // ============================================================
    // 4. 调用 PowerShell 自动化流程
    // ============================================================
    const psArgs = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', PS_SCRIPT_PATH,
        videoPath // 始终传入视频路径作为主要参数
    ];

    // 如果有 xml，作为第二个参数传入，或者让 ps1 脚本自己去同级目录找
    // 这里我们将 XML 也传进去，确保你的 PS 脚本能收到
    if (xmlPath) {
        psArgs.push(xmlPath);
    }

    console.log('-> 🚀 正在启动处理脚本...');

    const ps = spawn('powershell.exe', psArgs, {
        cwd: path.dirname(PS_SCRIPT_PATH), // 确保工作目录正确
        windowsHide: true // 隐藏黑框
    });

    ps.stdout.on('data', (data) => {
        // 转换 Buffer 为字符串并处理乱码 (Nodejs console 默认 utf8, PS 可能是 GBK，视情况而定)
        console.log(`[PS] ${data.toString().trim()}`);
    });

    ps.stderr.on('data', (data) => {
        console.error(`[PS ERR] ${data.toString().trim()}`);
    });

    ps.on('close', (code) => {
        console.log(`-> ✅ 任务结束，退出码: ${code}`);
    });

    res.status(200).send('Processing Started');
});

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`DDTV 监听服务已启动: http://localhost:${PORT}/ddtv`);
    console.log(`等待 DDTV5 录制完成回调...`);
    console.log(`==================================================\n`);
});
