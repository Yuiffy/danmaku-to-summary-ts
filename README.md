# 直播摘要与自动切片系统

将直播录播、字幕和弹幕转成 AI 直播梗概、下播回复、漫画与可审核的切片，并通过队列管理 B 站回复和切片投稿。

主要面向 Windows 本地录播工作站，接入 Mikufans / DDTV 的 Webhook。TypeScript 负责服务、生命周期和调度，JavaScript 编排媒体流程，Python 负责 ASR、说话人识别和媒体工具。

## 能做什么

- **录播后处理**：管理分段、断流重连和直播结束事件，合并视频，按房间策略保留视频或音频。
- **语音识别**：默认 Paraformer，可选 Whisper、SenseVoice、Fun-ASR-Nano；支持本地微调模型、自适应说话人识别和字幕预校对。
- **直播梗概与下播回复**：融合字幕、弹幕和房间设定，生成文字；按配置使用完整直播上下文并复用缓存。
- **漫画与视频生成**：结合直播截图、人物参考图和故事脚本生成漫画，支持独立的视频生成队列。
- **自动切片**：整场分块召回、全局排序和详细编辑，结合字幕、弹幕及情绪线索选材；也支持关键词话题切片、手工时间段和跨录播话题合集。
- **切片制作与审核**：生成大字幕成片、封面、标题、简介及审核清单；用全局数字 ID 查看证据、改词、重压和登记审核。
- **B 站发布**：延迟回复、补图和独立梗概回复；切片通过持久化单实例队列上传，支持重试、频控、去重和合集归档。
- **资源与运行监控**：ASR/GPU 队列、游戏期间资源降档、企微通知、录播看门狗和用量统计。

自动发现或制作切片不会自动获得投稿授权。候选的来源、人物归属、字幕和媒体检查通过后，按编号确认并入队投稿。

## 主流程

```text
Mikufans / DDTV 录播事件
  → Webhook 服务：会话、分段、断流重连与持久化任务
  → 中央处理队列：资源准入、视频合并、音频准备
  → ASR：字幕、说话人及情绪 sidecar
  → 字幕 / 弹幕融合
      ├─ 直播梗概、下播回复、漫画 → 延迟回复服务 → B 站动态评论
      └─ 整场 / 关键词选材 → 候选与成片 → 审核清单
                                             → 按编号确认 → 投稿队列
```

Mikufans 通常由 `StreamEnded` 收口；缺少该事件时，`Streaming:false` 的最终 `FileClosed` 可在分段等待超时后兜底。普通中间分段不会立即触发整场处理。

## 安装与配置

### 环境

| 依赖 | 用途 |
| --- | --- |
| Node.js 20+、npm | TypeScript 服务和媒体编排 |
| Python 3.10+ | ASR、说话人识别和 Python 工具 |
| FFmpeg / ffprobe，加入 PATH | 音视频处理、字幕烧录和封面截帧 |
| NVIDIA GPU / 匹配的 PyTorch、CUDA | 推荐用于 ASR 与 NVENC 加速；安装组合见 ASR 文档 |
| PM2 | 可选，用于后台服务和队列守护 |

在仓库根目录执行：

```powershell
npm install
python -m pip install -r src/scripts/python/requirements-sensevoice.txt
python -m pip install -r src/scripts/python/requirements.txt
```

首次 ASR 会下载模型。GPU wheel、模型缓存与各后端的额外依赖见 [ASR 安装与配置](docs/asr-backends.md)；漫画和上传工具的依赖见各自文档。

首次配置时复制密钥示例，再填写实际凭据：

```powershell
Copy-Item config/secret.example.json config/secret.json
```

已有 `secret.json` 时直接编辑本地文件，保留现有凭据。

### 配置如何生效

1. 显式 `CONFIG_PATH` 选择主配置；路径不存在会报错，相对路径按仓库根目录解析。
2. 未指定时，`NODE_ENV=production` 或 `automation` 读取 `config/production.json`；其他环境读取 `config/default.json`。
3. 合并本地 `config/secret.json`，再应用支持的环境变量覆盖。

生产配置是独立主配置，不会自动继承 `default.json`。仓库中的房间、录播目录、模型路径和代理是现有部署设置，使用前应改为自己的环境。密钥、Cookie 和企微 Webhook 放在被 Git 忽略的 `secret.json` 中。

| 配置位置 | 主要内容 |
| --- | --- |
| `webhook` | 监听地址、端口和录播路径 |
| `asr` | 默认后端、房间路由、微调模型、说话人和字幕预校对 |
| `ai.roomSettings`、`config/generation-modes.json` | 房间生成策略、直播上下文和漫画设置 |
| `ownStreamClips` | 整场自动选材、排序、编辑、烧录与审核 |
| `clipTopics` | 关键词话题、窗口、预审和通知 |
| `bilibili` | 动态回复、监测与发布相关设置 |

字段以配置文件和 [统一配置契约](docs/architecture.md#configuration-and-history) 为准。

## 启动与升级

### 首次启动

源码 CLI 依赖编译后的工作流模块；先验证，再激活工作流和构建服务：

```powershell
npm run verify:all
npm run workflow:activate
npm run build
npm run dev
```

`npm run dev` 运行 `dist/app/main.js`，监听 `0.0.0.0:12522`，不是自动重编译模式。开发改动后需要重新构建；Next.js 任务页面另用 `npm run dev:next` 启动。

需要生产守护时：

```powershell
npm install -g pm2
pm2 start ecosystem.config.js --only danmaku-webhook --env production
npm run pm2:status
npm run pm2:logs
```

生产默认端口为 `12523`，由 `webhook.port` 决定，也可通过 `WEBHOOK_PORT` / `WEBHOOK_HOST` 或显式 CLI 参数覆盖。

按需启动独立任务：

```powershell
npm run pm2:clip-upload:start
npm run pm2:seedance:start
npm run pm2:recorder:start
```

`npm run pm2:start` / `pm2:restart` 操作整个 `ecosystem.config.js`；仅管理 Webhook 时使用指定进程的 PM2 命令。

### 已有服务升级

`npm run verify:all` 使用候选工作流和隔离构建，不覆盖正在运行的 `dist`，也不激活工作流。线上升级的暂存、队列检查、状态备份和回滚步骤见 [部署流程](docs/architecture.md#pm2-deployment)。源码 JS/Python 会在下一次子进程调用时生效，更新运行目录时也应遵循该流程。

## 自动切片与审核

### 整场自动选材

在 `ownStreamClips` 中配置启用范围、AI 策略和媒体参数。当前分阶段选材先按块召回，再结合本地线索全局排序，最后逐候选编辑边界和文案。AI 片长按话题完整性决定；字幕、弹幕引用及人物归属分别校验。

处理后查看 `PLAN.json`、按时间排列的 `REVIEW.md` 和上传清单。待复核、制作失败及被剔除项也保留数字 ID 和原因，便于继续处理。

已有录播可直接运行选材，使用其字幕与弹幕：

```powershell
node src/scripts/own_stream_clipper.js --media "D:/recordings/live.flv" --srt "D:/recordings/live.srt" --xml "D:/recordings/live.xml" --no-notify
```

选材与编辑会调用配置的 AI。分阶段策略、诊断和可选残余审计见 [自动选材说明](docs/post-stream-residual-audit.md)。

### 关键词、指定时间段与跨录播合集

- **关键词话题**：在 `clipTopics` 配置关键词和房间，生成带原文证据、粗剪预览与字幕的候选包，进入同一编号审核流程。
- **指定时间段**：通过手工队列提交媒体、SRT、起止秒数和文案，统一制作 MP4、大字幕、封面及 REVIEW。
- **跨录播合集**：`topic:compile` 按发现来源、搜索证据、生成计划、编译成片四阶段执行。

手工队列示例（起止时间为原录播秒数）：

```powershell
npm run manual:clips -- add --media "D:/recordings/live.flv" --srt "D:/recordings/live.srt" --start 120 --end 240 --title "片中发生的故事" --description "依据原片填写简介" --cover-text "封面文案"
npm run manual:clips -- list
npm run manual:clips -- worker
```

默认只制作、等待审核。profile、旧录播路径和完整参数见 [手工切片队列](docs/manual-clip-queue.md)；多场拼接见 [跨录播话题合集](docs/topic-compilation.md)。

### 按编号查看、改词与投稿

下面的 `123` 仅为示例，使用审核清单中的真实全局 ID：

```powershell
npm run upload:clips:list
npm run upload:clips -- show 123
npm run upload:clips -- subtitles --id 123

# 仅修正已核实的词，不投稿
npm run upload:clips -- correct --id 123 --from "原词" --to "核实后的词"

# 已完成审核、明确需要投稿时入队
npm run upload:clips -- enqueue --ids 123
npm run upload:clips:queue
npm run pm2:status:clip-upload
```

确认改词并要求投稿时，可在 `correct` 命令上加 `--enqueue`，由后台 worker 按同一 ID 重建、烧录、检查并上传。字幕修订保留版本和原媒体；有证据或文案问题的候选须先完成对应复核，不能仅凭入队解除阻塞。

具体的 `approve-review`、`rebuild`、`cut` 和已投稿限制见 [候选审核与改词](docs/topic-event-editorial.md)、[B 站上传工具](docs/bilibili-upload-tools.md)。

## ASR 与独立处理入口

以下命令需要先激活工作流；无需启动 Webhook 服务：

```powershell
# 完整处理：视频 + 可选弹幕
node src/scripts/enhanced_auto_summary.js "D:/recordings/live.flv" "D:/recordings/live.xml"

# 已有字幕，直接进入融合与后续生成
node src/scripts/enhanced_auto_summary.js "D:/recordings/live.srt" "D:/recordings/live.xml"

# 显式选择 ASR 后端
node src/scripts/enhanced_auto_summary.js "D:/recordings/live.flv" --asr-backend sensevoice

# 仅字幕与弹幕融合
node src/scripts/do_fusion_summary.js "D:/recordings/live.srt" "D:/recordings/live.xml"
```

ASR 路由优先级是 CLI 覆盖、首条匹配的 routing、`default_backend`。Paraformer 支持 `default` / `finetuned` 模型配置和灰度路由；模型目录属于本机配置。输出包括普通 `.srt`、`.asr_meta.json`，按需生成说话人 sidecar 和 `.speaker.srt` 审阅字幕。

完整处理会依房间设置触发 AI、切片及通知。后端、模型安装、自动字幕预校对和设备排障见 [ASR 文档](docs/asr-backends.md)，训练见 [Paraformer 微调](docs/funasr-finetune.md)。

## Webhook 与 API

录播姬配置的生产地址：

```text
Mikufans: http://localhost:12523/mikufans
DDTV:     http://localhost:12523/ddtv
```

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health`、`GET /status` | 健康和处理状态 |
| `GET /history`、`GET /processing-files` | 处理记录和正在处理的文件 |
| `POST /mikufans`、`POST /ddtv` | 录播事件 |
| `GET /api/bilibili/check-cookie` | Cookie 检查 |
| `GET /api/delayed-reply/tasks` | 延迟回复任务列表 |
| `POST /api/delayed-reply` | 提交延迟回复任务 |
| `DELETE /api/delayed-reply/tasks/:taskId` | 取消延迟回复任务 |

端口、请求约定、PM2 和常见运行问题见 [运行说明](docs/runtime-notes.md)。当前 handler 源码是请求格式的依据；旧 standalone 脚本文档仅用于历史参考。

## 开发与验证

```powershell
npm run verify:all        # 完整便携验证
npm run verify:core       # 工作流构建、类型检查、架构门禁、Jest
npm run test:node         # Node 测试
npm run test:python       # Python 便携测试
npm run test:compiled     # 隔离服务构建及编译产物集成测试
npm run test:python:asr   # 额外 ASR 设备/资源测试，需要 ML 依赖
```

便携测试使用模拟依赖，不代表真实模型效果、GPU 性能或 B 站投稿已验收。不要批量执行历史 `src/scripts/test_*`，其中有调用付费服务或发布评论的诊断脚本。

| 目录 | 职责 |
| --- | --- |
| `src/app`、`src/services` | TypeScript 入口、HTTP、录播生命周期和调度 |
| `src/workflows` | 编译并按版本加载的工作流模块 |
| `src/scripts` | 媒体 CLI、ASR、切片、漫画和 Python 工具 |
| `scripts`、`tools` | 可复用运维、部署与队列命令 |
| `config` | 配置、生成预设和本地密钥示例 |
| `tests`、源码旁测试 | 便携、集成及回归测试 |
| `docs`、`.agents/skills` | 长期维护的文档与代理工作流 |
| `data/runtime`、`logs`、`build`、`dist` | 本地运行状态、日志及生成产物 |
| `temp/<日期>-<任务>`、`local-scripts` | 被忽略的单次任务资料与脚本 |

模块边界、编译工作流、配置契约和升级约束见 [架构说明](docs/architecture.md)；文件放置遵循 [AGENTS.md](AGENTS.md)。

## 更多文档

- [录播补下载与回填](docs/bilibili-recovery-flow.md)
- [旧录播选材](docs/old-sui-clip-search-playbook.md)
- [B 站切片验收](docs/bilibili-clip-verification.md)
- [vLLM 独立 ASR 队列](docs/asr-vllm-queue.md)
- [自定义 AI Prompts](自定义AI_Prompts说明.md)
- [脚本目录与迁移约定](src/scripts/README.md)

## 许可证

MIT License
