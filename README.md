# 直播摘要自动生成系统

**弹幕转总结 TypeScript 重构版**

> 自动化处理录播视频，生成 AI 总结、图片漫画，并回复到 B 站动态。

---

## 🚀 系统概述

本系统是一套围绕直播录播后处理的全自动化管线，通过 Mikufans 录播姬的 Webhook 接收录播完成事件，自动完成从「视频合并」到「B 站动态回复」的全流程处理。

### 主要功能

- **Webhook 服务**：接收 DDTV / Mikufans 录播姬的事件并自动触发处理
- **视频合并**：多分段自动合并为完整视频
- **音频提取**：将视频转换为音频（ASMR / 仅需音频的房间）
- **Whisper 语音识别**：基于 `faster-whisper` + GPU 加速生成 SRT 字幕
- **字幕与弹幕融合**：按弹幕热力密度提取高光时刻，生成 `_AI_HIGHLIGHT.txt`
- **AI 晚安总结**：调用 Gemini/TuZi API 生成晚安回复 Markdown
- **AI 图片生成**：调用 TuZi 图片 API 生成卡通漫画图
- **B 站动态回复**：将晚安回复 + 图片发布到 B 站评论区

---

## 📁 项目结构

```
danmaku-to-summary-ts/
├── src/scripts/                # 核心脚本（主要处理逻辑）
│   ├── webhook_server.js       # Webhook 服务入口（监听 DDTV / mikufans）
│   ├── enhanced_auto_summary.js# 主处理流程（音频→Whisper→融合→AI生成）
│   ├── do_fusion_summary.js    # 字幕 + 弹幕融合，生成 AI_HIGHLIGHT.txt
│   ├── audio_processor.js      # 音频处理（视频转音频）
│   ├── ai_text_generator.js    # AI 文本生成（晚安回复）
│   ├── ai_comic_generator.js   # AI 图片生成（漫画）
│   ├── whisper_queue_manager.js# Whisper 任务队列管理
│   ├── config-loader.js        # 配置加载器
│   ├── config.json             # 主配置文件（房间设置、超时、录播姬）
│   ├── config.secrets.json     # 🔑 密钥配置文件（API Key、B站Cookie）
│   ├── config.secrets.example.json # 密钥配置示例
│   └── python/
│       └── batch_whisper.py    # Whisper 语音识别脚本（需 GPU）
├── ecosystem.config.js         # PM2 生态系统配置
├── package.json
└── logs/                       # 运行日志
```

---

## 🛠️ 部署准备

### 1. 环境要求

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | 18+ | 运行 JS 脚本 |
| Python | 3.10+ | 运行 Whisper 脚本 |
| FFmpeg | 任意 | 视频/音频处理，需在 PATH 中 |
| CUDA | 推荐 12.x | Whisper GPU 加速（无 GPU 会自动降为 CPU） |
| PM2 | 全局安装 | 进程守护 |
| pnpm / npm | - | 包管理器 |

### 2. 安装 Python 依赖

```bash
# 安装 faster-whisper（需要 CUDA 环境）
pip install faster-whisper
```

> **注意**：首次运行时，Whisper 会自动下载模型 `deepdml/faster-whisper-large-v3-turbo-ct2`，约 1.5GB，请确保网络畅通或提前下载。

### 3. 安装 Node.js 依赖

```bash
# 使用 pnpm（推荐）
pnpm install

# 或使用 npm
npm install
```

### 4. 安装 PM2

```bash
npm install -g pm2
```

---

## ⚙️ 配置文件说明

### 主配置文件：`src/scripts/config.json`

控制房间设置、超时时间、录播姬端点等核心参数。

```json
{
  "audioProcessing": {
    "enabled": true,
    "audioOnlyRooms": [26966466],   // 仅提取音频的房间（ASMR等）
    "keepOriginalVideo": false,      // 提取音频后是否保留原视频
    "ffmpegPath": "ffmpeg"          // ffmpeg 路径（默认使用 PATH 中的）
  },
  "aiServices": {
    "gemini": {
      "enabled": true,
      "model": "gemini-3-flash-preview",
      "proxy": "socks5://127.0.0.1:7890"   // 代理（访问 Gemini 需要）
    },
    "tuZi": {
      "enabled": true,
      "baseUrl": "https://api.tu-zi.com",
      "model": "gemini-3-pro-image-preview-async",
      "proxy": "http://127.0.0.1:7890"
    },
    "defaultReferenceImage": "../public/reference_images/岁己小红帽立绘.png",
    "defaultCharacterDescription": "岁己SUI（白发红瞳女生）",
    "defaultAnchorName": "岁己SUI",
    "defaultFanName": "饼干岁"
  },
  "roomSettings": {
    "26966466": {                    // 房间ID（字符串）
      "audioOnly": true,            // 是否为纯音频房间
      "anchorName": "栞栞Shiori",
      "fanName": "獭獭栞",
      "enableTextGeneration": true, // 是否生成晚安回复
      "enableComicGeneration": true // 是否生成 AI 图片
    }
  },
  "timeouts": {
    "fixVideoWait": 30000,          // 等待 fix 视频生成超时（ms）
    "fileStableCheck": 30000,       // 文件大小稳定检查超时（ms）
    "processTimeout": 1800000       // 整体处理超时（ms，默认30分钟）
  },
  "recorders": {
    "mikufans": {
      "enabled": true,
      "endpoint": "/mikufans",
      "basePath": "D:/files/videos/DDTV录播"  // 录播姬的视频存储根目录
    }
  }
}
```

### 密钥配置文件：`src/scripts/config.secrets.json`

> ⚠️ **此文件不应提交到 Git，已在 `.gitignore` 中排除。**

```bash
# 从示例文件复制
cp src/scripts/config.secrets.example.json src/scripts/config.secrets.json
```

然后编辑 `config.secrets.json`，填入真实密钥：

```json
{
  "gemini": {
    "apiKey": "YOUR_GEMINI_API_KEY_HERE"
  },
  "tuZi": {
    "apiKey": "YOUR_TUZI_API_KEY_HERE"
  },
  "bilibili": {
    "cookie": "YOUR_BILIBILI_COOKIE_HERE",
    "csrf": "YOUR_BILIBILI_CSRF_HERE"
  }
}
```

> **B 站 Cookie 获取方法**：浏览器登录 B 站后，打开开发者工具 → Network → 找任意请求 → 复制 `Cookie` 请求头；`csrf` 对应 Cookie 中的 `bili_jct` 字段。

---

## 🚦 启动服务

### 生产环境（PM2 守护）

```bash
# 构建项目（首次或代码更新后）
pnpm build

# 使用 PM2 启动
npm run pm2:start

# 查看运行状态
npm run pm2:status

# 实时查看日志
npm run pm2:logs

# 重启服务
npm run pm2:restart

# 停止服务
npm run pm2:stop
```

**常用 PM2 命令速查：**

```bash
pm2 list                         # 查看所有进程
pm2 monit                        # 实时监控面板
pm2 show danmaku-webhook         # 查看详细状态
pm2 flush                        # 清空日志
pm2 startup                      # 配置开机自启
pm2 save                         # 保存当前进程列表
```

> PM2 配置文件位于项目根目录 `ecosystem.config.js`，生产端口默认 `15121`。

### 开发模式（直接运行）

```bash
# 启动 Webhook 服务（不编译，直接用 Node 运行 JS 脚本）
node src/scripts/webhook_server.js
```

---

## 🔄 主链路处理流程

```
Mikufans 录播姬 FileClosed 事件
    │
    ▼
[1] Webhook 接收 (webhook_server.js, POST /mikufans)
    │  - 提取 EventData.RelativePath + basePath 拼成完整路径
    │  - 等待文件大小稳定（10s延迟+轮询检查）
    │
    ▼
[2] 视频文件合并（如分段录制）
    │  - Mikufans 会话内多分段 -> enhanced_auto_summary.js 合并处理
    │
    ▼
[3] 音频处理 (audio_processor.js)
    │  - 判断是否为「音频专用房间」（audioOnly: true）
    │  - 若是：ffmpeg 提取音频 (.m4a)，可选删除原视频
    │  - 若否：直接使用原始视频
    │
    ▼
[4] Whisper 语音识别 (python/batch_whisper.py)
    │  - 自动获取 Whisper GPU 锁（防并发冲突）
    │  - 三级策略：极速 Batch → 稳健 Sequential → 核弹（关VAD）
    │  - 输出 .srt 字幕文件（同目录下）
    │  - 自动过滤幻听内容（字幕志愿者、优优独播剧场等）
    │
    ▼
[5] 字幕 + 弹幕融合 (do_fusion_summary.js)
    │  - 读取 .srt 字幕 + .xml 弹幕
    │  - 计算弹幕密度热力图
    │  - 保留高热度时段字幕 + 低热度随机采样
    │  - 输出 _AI_HIGHLIGHT.txt（精简版，适合直接投喂 AI）
    │
    ▼
[6] AI 晚安回复生成 (ai_text_generator.js)
    │  - 读取 _AI_HIGHLIGHT.txt
    │  - 调用 Gemini API 生成晚安总结 Markdown
    │  - 输出 _晚安回复.md
    │
    ▼
[7] AI 图片生成 (ai_comic_generator.js)
    │  - 按房间配置的最短时长 / 概率决定是否生成
    │  - 调用 TuZi API 生成卡通漫画图片
    │  - 输出 _COMIC_FACTORY.png/webp
    │
    ▼
[8] 回复到 B 站动态 (bilibili_comment.py / ai_text_generator.js)
    │  - 获取主播最新动态
    │  - 上传图片
    │  - 发布带图片的评论回复
    │
    ▼
✅ 完成
```

---

## 🔌 Webhook 端点

服务默认监听端口：`15121`

### Mikufans 录播姬（主入口）

```
POST http://localhost:15121/mikufans
```

- `SessionStarted`：直播开始，初始化会话
- `FileClosed`：文件关闭（分段完成），**触发主处理流程**
- `SessionEnded`：会话结束（忽略）

**在 Mikufans 录播姬中配置 Webhook 地址：**
```
http://你的机器IP:15121/mikufans
```

### DDTV 录播姬（辅助入口）

```
POST http://localhost:15121/ddtv
```

- `SaveBulletScreenFile`：弹幕保存事件，等待 fix 视频生成后处理
- `InvalidLoginStatus`：登录失效，弹出 Windows 提醒弹窗

---

## 🧪 其他调用入口

### 通过 Postman / curl 调用单个功能

> 所有 REST API 都在 Webhook 服务器运行时可用。

#### 健康检查

```bash
GET http://localhost:15121/health
GET http://localhost:15121/status
GET http://localhost:15121/history
GET http://localhost:15121/processing-files
```

#### B 站相关 API

```bash
# 健康检查
GET  http://localhost:15121/api/bilibili/health

# 检查 Cookie 是否有效
GET  http://localhost:15121/api/bilibili/check-cookie

# 获取主播动态（按 UID）
GET  http://localhost:15121/api/bilibili/dynamics/:uid

# 获取主播动态（按房间ID）
GET  http://localhost:15121/api/bilibili/room/:roomId/dynamics

# 发布评论
POST http://localhost:15121/api/bilibili/comment
Content-Type: application/json
{
  "oid": "动态ID",
  "text": "评论内容"
}

# 上传图片
POST http://localhost:15121/api/bilibili/upload
Content-Type: multipart/form-data
{ "file": <图片文件> }

# 发布带图片的评论
POST http://localhost:15121/api/bilibili/comment-with-image
Content-Type: application/json
{
  "oid": "动态ID",
  "text": "评论内容",
  "imagePath": "/path/to/image.png"
}

# 触发延迟回复
POST http://localhost:15121/api/bilibili/delayed-reply
Content-Type: application/json
{
  "roomId": "26966466",
  "goodnightTextPath": "/path/to/_晚安回复.md",
  "comicImagePath": "/path/to/_COMIC_FACTORY.png"
}
```

#### 手动触发 Mikufans Webhook（模拟录播姬推送）

```bash
POST http://localhost:15121/mikufans
Content-Type: application/json
{
  "EventType": "FileClosed",
  "EventData": {
    "RoomId": 26966466,
    "Name": "栞栞Shiori",
    "SessionId": "test-session-001",
    "RelativePath": "栞栞Shiori/2024-01-01/录制-26966466-20240101-120000.mp4"
  }
}
```

---

### 本地命令行调用单个功能

所有脚本均可直接通过命令行测试，无需启动 Webhook 服务。

#### 完整处理流程（视频 → AI 总结）

```bash
# 处理单个视频 + 弹幕 XML
node src/scripts/enhanced_auto_summary.js \
  D:/录播/视频.mp4 \
  D:/录播/弹幕.xml

# 仅处理视频（无弹幕）
node src/scripts/enhanced_auto_summary.js D:/录播/视频.mp4

# 已有字幕，直接跳到融合 + AI 生成
node src/scripts/enhanced_auto_summary.js \
  D:/录播/视频.srt \
  D:/录播/弹幕.xml
```

#### 仅运行 Whisper 语音识别

```bash
# 处理单个视频或目录
python src/scripts/python/batch_whisper.py D:/录播/视频.mp4

# 批量处理整个目录
python src/scripts/python/batch_whisper.py D:/录播/2024-01-01/
```

#### 仅运行字幕 + 弹幕融合

```bash
# 需要 .srt 和 .xml 文件
node src/scripts/do_fusion_summary.js \
  D:/录播/视频.srt \
  D:/录播/弹幕.xml
```

#### 仅运行音频提取

```bash
node src/scripts/audio_processor.js D:/录播/视频.mp4
```

#### 通过拖拽运行（Windows）

项目根目录提供了 `.bat` 快捷方式：

```
拖拽文件夹到我身上生成总结.bat    ← 拖入录播目录，运行完整流程
drag_generate_goodnight.bat        ← 生成晚安回复
drag_generate_comic.bat            ← 生成漫画图片
```

---

## 📊 监控与日志

### PM2 日志

```bash
# 实时日志（合并输出）
npm run pm2:logs

# 实时监控面板
npm run pm2:monitor
```

### 日志文件位置

```
logs/
├── pm2-out.log        # 标准输出日志
├── pm2-error.log      # 错误日志
└── pm2-combined.log   # 合并日志
```

### 服务状态检查

```bash
curl http://localhost:15121/health
curl http://localhost:15121/status
curl http://localhost:15121/history
```

---

## 🔧 故障排除

### 常见问题

#### 1. Whisper 处理卡住 / GPU 显存不足

Whisper 有排队锁机制，同时只允许一个进程使用 GPU。若卡住超长时间，可手动删除锁文件：

```bash
del src/scripts/.whisper_lock
```

#### 2. 服务启动后端口被占用

```bash
# 查看占用 15121 端口的进程
netstat -ano | findstr 15121
```

#### 3. AI 生成失败

- 检查 `config.secrets.json` 中的 API Key 是否正确
- 检查代理配置（`config.json` 中的 `proxy` 字段）
- 查看 PM2 日志获取详细错误信息

#### 4. 找不到弹幕 XML 文件

Webhook 会自动查找与视频同名的 `.xml` 文件（同目录）。确认 Mikufans 录播姬已开启弹幕录制，且保存路径与配置中的 `basePath` 一致。

#### 5. B 站回复失败

- 使用 `GET /api/bilibili/check-cookie` 检查 Cookie 是否有效
- B 站 Cookie 有效期有限，需定期更新 `config.secrets.json`

---

## 📚 延伸阅读

- [Webhook 详细说明](src/scripts/WEBHOOK_README.md)
- [B站 API 说明](src/scripts/BILIBILI_API_README.md)
- [Whisper 队列说明](src/scripts/QUEUE_README.md)
- [增强功能说明](src/scripts/ENHANCED_FEATURES_README.md)
- [自定义 AI Prompts 说明](自定义AI_Prompts说明.md)

---

## 📄 许可证

MIT License

---

> **注意**：本项目仍在积极开发中，配置格式可能随版本更新而变化，升级前请备份配置文件。

## 未来路线

本项目开发得比较随意，本来是分别开发的整理输入给AI的文本的ts，和语音识别的py，然后为了全自动，合到一起了。所以代码里又有ts又有py。后续有机会的话重构？
