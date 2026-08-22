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
- **多 ASR 后端语音识别**：默认 Paraformer，支持 Whisper、SenseVoice、Fun-ASR-Nano，并可在 ASR 后自适应判断是否执行完整说话人处理
- **字幕与弹幕融合**：按弹幕热力密度提取高光时刻，生成 `_AI_HIGHLIGHT.txt`
- **AI 晚安总结**：调用 Gemini/TuZi API 生成晚安回复 Markdown
- **AI 图片生成**：调用 TuZi 图片 API 生成卡通漫画图
- **B 站动态回复**：将晚安回复 + 图片发布到 B 站评论区

---

## ASR 后端

当前默认使用 Paraformer；Whisper、SenseVoice 和 Fun-ASR-Nano 可通过配置或命令行显式选择：

```powershell
node src/scripts/enhanced_auto_summary.js "D:/path/to/video.flv" --asr-backend paraformer
node src/scripts/enhanced_auto_summary.js "D:/path/to/video.flv" --asr-backend whisper
node src/scripts/enhanced_auto_summary.js "D:/path/to/video.flv" --asr-backend sensevoice
node src/scripts/enhanced_auto_summary.js "D:/path/to/video.flv" --asr-compare whisper,sensevoice
```

ASR 路由、adaptive speaker、sidecar、验证流程和当前限制见 [docs/asr-backends.md](docs/asr-backends.md)。

### Paraformer fine-tuned model

Paraformer 支持 stock 和本地 fine-tuned model。`config/default.json` 保持 `model_profile: "default"`，生产通过 deterministic gray rollout 为部分任务选择 fine-tuned model，并可为指定房间强制启用。

相关配置：

- `asr.paraformer.model_profile`: `default` 或 `finetuned`
- `asr.paraformer.base_model`: stock model alias，通常为 `paraformer-zh`
- `asr.paraformer.finetuned_model`: 本地训练目录
- `asr.gray_rollout`: rollout 比例和强制房间

模型路径属于部署配置，不要从文档复制固定绝对路径。训练流程见 [docs/funasr-finetune.md](docs/funasr-finetune.md)。

## 📁 项目结构

```
danmaku-to-summary-ts/
├── src/app/main.ts                         # TypeScript 应用入口；构建后为 dist/app/main.js
├── src/services/webhook/                   # Webhook 服务和 DDTV / Mikufans / B站 API handlers
├── src/scripts/enhanced_auto_summary.js    # 完整媒体处理流程
├── src/scripts/asr/                        # backend 路由、统一结果、队列和 speaker-once
├── src/scripts/python/                     # Whisper、Paraformer、SenseVoice、Nano 与 speaker 引擎
├── config/
│   ├── default.json                        # 开发/仓库默认配置
│   ├── production.json                     # 生产配置
│   ├── secret.example.json                 # 密钥配置示例
│   └── secret.json                         # 本地密钥，不应提交
├── docs/                                   # 当前架构、运行说明与历史实验
├── ecosystem.config.js                     # PM2 进程配置
└── package.json                            # 命令入口
```

---

## 🛠️ 部署准备

### 1. 环境要求

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | 18+ | 运行 JS 脚本 |
| Python | 3.10+ | 运行 Whisper / FunASR 系列脚本 |
| FFmpeg | 任意 | 视频/音频处理，需在 PATH 中 |
| CUDA | 推荐 12.x | Paraformer / Whisper GPU 加速；具体设备配置见 ASR 文档 |
| PM2 | 全局安装 | 进程守护 |
| pnpm / npm | - | 包管理器 |

### 2. 安装 Python 依赖

默认 Paraformer / SenseVoice / Fun-ASR-Nano 依赖：

```powershell
pip install -r src/scripts/python/requirements-sensevoice.txt
```

Whisper 仍是可选 backend；需要时单独安装 `faster-whisper`。RTX 5080、CUDA wheel 和首次模型缓存说明见 [docs/asr-backends.md](docs/asr-backends.md)。

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

配置加载优先级为：存在且有效的显式 `CONFIG_PATH`；否则 production 环境读取 `config/production.json`，其他环境读取 `config/default.json`。不存在或拼错的 `CONFIG_PATH` 当前会被忽略并回退。敏感信息由本地 `config/secret.json` 合并；示例见 `config/secret.example.json`。

- `config/default.json`：仓库和开发默认值。
- `config/production.json`：生产运行值，不会自动叠加到 default 之上。
- `config/secret.json`：本地 API key、Cookie、企微等敏感值，不应提交。
- `CONFIG_PATH`：需要完全指定其他配置文件时使用。

配置的实际字段以 `src/core/config/ConfigInterface.ts`、`src/core/config/ConfigLoader.ts` 和脚本侧运行时读取逻辑为准。

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

> 当前 PM2 进程入口为 `dist/app/main.js`，生产端口由 `config/production.json` 的 `webhook.port` 决定（当前 `12523`）。更多说明见 [docs/runtime-notes.md](docs/runtime-notes.md)。

### GPU TDR 证据监控

为尽快保留 NVIDIA 驱动超时、黑屏或 OBS 设备重置时的现场证据，单独启动 GPU TDR 捕获进程：

```bash
npm run gpu:tdr:start
npm run gpu:tdr:status
npm run gpu:tdr:logs
```

它只读取 Windows 事件日志、`C:\Windows\LiveKernelReports\WATCHDOG`、WER 报告目录和 OBS 日志目录。发现 `nvlddmkm` 153、显示驱动 TDR、LiveKernel/WATCHDOG 相关事件或新转储时，会按约 90 秒合并同一次事故，并保存到 `D:\diagnostics\gpu-tdr`。转储复制会等待文件稳定并重试；平时不会运行 WinDbg，也不会修改显卡、TDR、游戏或 OBS 设置。

停止或重启它不会影响其他 PM2 服务：

```bash
npm run gpu:tdr:stop
npm run gpu:tdr:restart
```

如果 D 盘不可用，可通过 PM2 环境变量 `GPU_TDR_CAPTURE_DIR` 改到其他诊断盘。

### 开发模式（直接运行）

```powershell
npm run build
npm run dev
```

`npm run dev` 当前显式使用 `--port 12522 --host 0.0.0.0`。也可以直接运行 `node dist/app/main.js --port <port> --host <host>`；CLI 只识别显式 `--port` / `--host`。

---

## 🔄 主链路处理流程

```
Mikufans 直播事件
    │  - StreamStarted / SessionStarted 建立会话状态
    │  - FileOpening / FileClosed 收集录制分段
    │  - StreamEnded 通常负责最终收口并触发队列任务
    │  - 缺少 StreamEnded 时，Streaming:false 的最终 FileClosed 可在分段等待超时后兜底收口
    │  - SessionEnded 维护延迟状态，本身通常不直接开始最终处理
    ▼
[1] TypeScript Webhook 服务 (dist/app/main.js, POST /mikufans)
    │  - MikufansWebhookHandler 归一化事件并持久化任务
    │  - 中央队列串行占用 ASR/GPU 槽位
    │
    ▼
[2] 完整媒体流水线 (src/scripts/enhanced_auto_summary.js)
    │  - 合并分段并准备音频
    │  - 解析 room/streamer/filename 路由上下文
    │
    ▼
[3] ASR backend 路由
    │  - 优先级：CLI override > 首条匹配 routing > default_backend
    │  - 当前默认 Paraformer；也支持 Whisper、SenseVoice、Fun-ASR-Nano
    │  - Paraformer 先完成 VAD + ASR + 标点，再按需执行自适应 CAM++ speaker 后处理
    │  - 输出普通 .srt、.asr_meta.json 和 .asr_speakers.json；有 speaker labels 时另写 review .speaker.srt
    │
    ▼
[4] 字幕 + 弹幕融合 (do_fusion_summary.js)
    │  - 计算弹幕热力并生成 _AI_HIGHLIGHT.txt
    │  - speaker sidecar 可补充计划/实际参与者上下文
    │
    ▼
[5] AI 文本、漫画与 clips
    │  - 生成晚安回复和漫画
    │  - 可用 speaker sidecar 保守选择额外主播参考图
    │
    ▼
[6] 延迟回复服务
    │  - 将文字和图片发布到 B 站动态评论区
    │
    ▼
✅ 完成
```

ASR/speaker 的详细状态机、sidecar 和验证方法见 [docs/asr-backends.md](docs/asr-backends.md)。

---

## 🔌 Webhook 端点

服务生产默认监听端口：`12523`。开发脚本 `npm run dev` 使用 `12522`；显式 `--port` 可覆盖。

### Mikufans 录播姬（主入口）

```
POST http://localhost:12523/mikufans
```

- `StreamStarted` / `SessionStarted`：建立或恢复直播会话状态
- `FileOpening` / `FileClosed`：收集分段；`Streaming:false` 的最终 FileClosed 可在缺少 StreamEnded 时兜底收口
- `StreamEnded`：通常负责最终收口并触发中央队列
- `SessionEnded`：维护延迟会话状态，本身通常不直接触发最终处理

**在 Mikufans 录播姬中配置 Webhook 地址：**
```
http://你的机器IP:12523/mikufans
```

### DDTV 录播姬（辅助入口）

```
POST http://localhost:12523/ddtv
```

- `SaveBulletScreenFile`：弹幕保存事件，等待 fix 视频生成后处理
- `InvalidLoginStatus`：登录失效，弹出 Windows 提醒弹窗

---

## 🧪 其他调用入口

### 通过 Postman / curl 调用单个功能

> 所有 REST API 都在 Webhook 服务器运行时可用。

#### 健康检查

```text
GET http://localhost:12523/health
GET http://localhost:12523/status
GET http://localhost:12523/history
GET http://localhost:12523/processing-files
```

#### B 站相关 API

```text
# 健康检查
GET  http://localhost:12523/api/bilibili/health

# 检查 Cookie 是否有效
GET  http://localhost:12523/api/bilibili/check-cookie

# 获取主播动态（按 UID）
GET  http://localhost:12523/api/bilibili/dynamics/:uid

# 获取主播动态（按房间ID）
GET  http://localhost:12523/api/bilibili/room/:roomId/dynamics

# 发布评论
POST http://localhost:12523/api/bilibili/comment
Content-Type: application/json
{
  "dynamicId": "动态ID",
  "content": "评论内容"
}

# 上传图片
POST http://localhost:12523/api/bilibili/upload
Content-Type: multipart/form-data
# form field: image=<图片文件>

# 发布带图片的评论
POST http://localhost:12523/api/bilibili/comment-with-image
Content-Type: multipart/form-data
# form fields: dynamicId, content, image（可选）

# 触发延迟回复（独立 handler）
POST http://localhost:12523/api/delayed-reply
Content-Type: application/json
{
  "roomId": "26966466",
  "goodnightTextPath": "/path/to/_晚安回复.md",
  "comicImagePath": "/path/to/_COMIC_FACTORY.png"
}
```

#### 手动触发 Mikufans Webhook（模拟录播姬推送）

```text
POST http://localhost:12523/mikufans
Content-Type: application/json
{
  "EventType": "FileClosed",
  "EventData": {
    "RoomId": 26966466,
    "Name": "栞栞Shiori",
    "SessionId": "test-session-001",
    "Streaming": false,
    "RelativePath": "栞栞Shiori/2024-01-01/录制-26966466-20240101-120000.mp4"
  }
}
```

示例中的 `Streaming:false` 表示这是缺少 `StreamEnded` 时可用于超时兜底收口的最终分段；普通中间 `FileClosed` 不应设置该字段。

---

### 本地命令行调用单个功能

以下核心离线处理脚本可直接通过命令行运行，无需启动 Webhook 服务；HTTP handlers 仍需启动 `dist/app/main.js`。

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

#### 检查 audio-only 房间的延迟保留策略

```powershell
node src/scripts/audio_processor.js --retention --dry-run
node src/scripts/audio_processor.js --retention --limit 10
```

当前普通单文件命令只识别 room/audioOnly 设置并返回延迟保留状态；启用 retention 时不会立即提取音频。延迟转换/清理通过 `--retention` 运行，先用 `--dry-run` 检查，再用 `--limit` 限制实际批次。

#### 通过拖拽运行（Windows）

项目提供这些 `.bat` 快捷方式：

```text
src/scripts/拖拽文件夹到我身上生成总结.bat  ← 拖入录播目录，运行完整流程
drag_generate_goodnight.bat                  ← 生成晚安回复
drag_generate_comic.bat                      ← 生成漫画图片
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
curl http://localhost:12523/health
curl http://localhost:12523/status
curl http://localhost:12523/history
```

---

## 🔧 故障排除

### 常见问题

#### 1. ASR 处理卡住 / GPU 显存不足

生产任务由 Mikufans 中央队列串行占用 ASR/GPU 槽位，Paraformer worker 会在队列清空或 GPU 忙时释放。先查看 PM2 日志和 `[[ASR_TIMING]]`。完整媒体流程为所有 ASR backend 共用 `.whisper_lock` 兼容锁；确认没有活跃 ASR 进程后，才考虑清理 stale lock。

#### 2. 服务启动后端口被占用

```bash
# 查看占用 12523 端口的进程
netstat -ano | findstr 12523
```

#### 3. AI 生成失败

- 检查 `config/secret.json` 中的 API Key 是否正确
- 检查 `config/default.json` / `config/production.json` 中的代理配置
- 查看 PM2 日志获取详细错误信息

#### 4. 找不到弹幕 XML 文件

Webhook 会自动查找与视频同名的 `.xml` 文件（同目录）。确认 Mikufans 录播姬已开启弹幕录制，且保存路径与配置中的 `basePath` 一致。

#### 5. B 站回复失败

- 使用 `GET /api/bilibili/check-cookie` 检查 Cookie 是否有效
- B 站 Cookie 有效期有限，需定期更新 `config/secret.json`

---

## 📚 延伸阅读

- [当前运行说明](docs/runtime-notes.md)
- [ASR backend / adaptive speaker 架构与验证](docs/asr-backends.md)
- [Paraformer 微调](docs/funasr-finetune.md)
- [vLLM 独立队列](docs/asr-vllm-queue.md)
- [录播补下载与回填流程](docs/bilibili-recovery-flow.md)
- [B站上传工具](docs/bilibili-upload-tools.md)
- [自定义 AI Prompts 说明](自定义AI_Prompts说明.md)

`src/scripts/WEBHOOK_README.md`、`BILIBILI_API_README.md` 等文件记录旧 standalone 脚本时代行为，文件顶部会标明历史状态；不要用它们覆盖上述当前文档。

---

## 📄 许可证

MIT License

---

> **注意**：本项目仍在积极开发中，配置格式可能随版本更新而变化，升级前请备份配置文件。

## 未来路线

本项目开发得比较随意，本来是分别开发的整理输入给AI的文本的ts，和语音识别的py，然后为了全自动，合到一起了。所以代码里又有ts又有py。后续有机会的话重构？
