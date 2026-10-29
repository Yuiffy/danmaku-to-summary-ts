# 开发与 AI 协作

本页是日常修改代码的入口；模块职责和运行边界以 [architecture.md](architecture.md)
为准，文件放置遵循 [AGENTS.md](../AGENTS.md)。单次任务记录留在被忽略的 `temp/`。

## 环境与首次验证

推荐 Node.js 24、Python 3.12 和 pnpm 11。仓库只维护 `pnpm-lock.yaml`，安装依赖使用
`pnpm install --frozen-lockfile`；运行命令可用 `npm run`，不另建 npm lockfile。

```powershell
pnpm install --frozen-lockfile
npm run verify:quick
npm test -- --runInBand
```

`verify:quick` 依次检查应用类型、服务构建类型、lint 和架构。Python 必须在 PATH 中，
因为架构检查使用 AST 解析 Python 文件，但不会导入模型或运行脚本。`npm test` 自动构建
候选 workflow release，Jest 使用候选版本；不需要先激活生产工作流。

只修改控制面时不需要安装 GPU 模型、运行 PM2 或填写 API key。
品牌 OP 的 JSON/SRT 由 `.gitattributes` 固定为 LF；这些资源绑定 SHA-256，
不能让 Windows checkout 自动转换换行后再以新哈希覆盖既有证据。
本机 Web 工作台的双服务启动、操作范围和验收见 [web-admin.md](web-admin.md)。
完整 Python 回归还需要 `requests[socks]`、`bilibili-api-python`、`Pillow`、`numpy`、
`google-genai`、`PyYAML` 和 PyTorch（CPU 版即可完成张量相关单测）。
B 站 SDK 的维护状态、调用归属和替换边界见 [接口上游索引](bilibili-api-upstreams.md)。
实际 ASR 模型环境的安装方式见 [asr-backends.md](asr-backends.md)。

## 按改动选择检查

| 改动范围 | 聚焦检查 |
| --- | --- |
| 一个 TS/JS 模块 | `npm test -- --runInBand --runTestsByPath src/path/module.test.ts` |
| Webhook、队列、回复持久化 | `npm run test:integration`，再 `npm run test:compiled` |
| Node 操作工具、workflow bridge | `npm run test:node` |
| QQ 群艾特回复 | 相邻 `services/qqbot/*.test.ts` 和 `tools/qqbot/run.test.ts`；运行契约见 [qqbot.md](qqbot.md) |
| Python 上传简介 | `python -m unittest discover -b -s tests -p test_batch_upload_description.py` |
| 评论回执恢复 | `npm test -- --runInBand --runTestsByPath src/services/bilibili/DelayedReplyService.timing.test.ts src/services/bilibili/CommentPublicationRecovery.test.ts`，再 `python -m unittest discover -b -s tests -p test_bilibili_comment*.py` |
| ASR 历史增量索引 | `npm test -- --runInBand --runTestsByPath src/services/admin/AdminAsrHistoryObserver.test.ts src/services/admin/AdminAsrHistoryIndex.test.ts` |
| Python 上传注册表 | `python -m unittest discover -b -s tests -p test_clip_upload_registry.py` |
| 全部便携 Python 回归 | `npm run test:python` |
| ASR 设备、模型与资源专项 | `npm run test:python:asr`，需要对应 ML 依赖 |
| 跨模块或最终提交前 | `npm run verify:all` |

`test`、`test:unit`、`test:integration`、`test:node`、`test:compiled` 都自动准备候选
workflows。若直接调用 Jest 或 `node --test`，先执行 `npm run build:workflows`；
直接运行 Node 测试时加 `--require ./tests/workflowCandidate.cjs`。
测试不会因缺少候选而悄悄使用已激活的生产版本；缺失时会给出准备命令。
显式 `DANMAKU_WORKFLOW_RELEASE` 可指定正在验收的独立 release。Python 单测调用真实
Node workflow bridge 时，也必须从候选描述符注入该变量；单独运行这类测试前先执行
`npm run build:workflows`。Jest 发起的子进程要显式传入 `env: { ...process.env }`，
确保候选选择从 Jest 环境传递到子进程。

`verify:all` 包含 `verify:core`（quick + Jest）、Node、Python 和编译产物集成测试。
它生成 `build/` 候选文件，不写生产 `dist`，不修改活动 workflow 指针。
重复构建和构建失败会清理本次 staging；已经发布的不可变 release 保留用于回退。

GitHub Actions 在 Windows、Node 24、Python 3.12 上执行 `verify:core`、`test:node`
和 `test:compiled`。完整 Python/ML 回归仍需本地运行，CI 通过不代表该部分已验证。
lint 的历史 warning 与失败的 error 分开报告；临时目录不参与 lint。架构检查的 `--json` 输出同时列出已解析桥接依赖数和未解析的动态导入；
排查模块关系时先看该清单，不把静态检查通过当作所有动态路径都已覆盖。

## 定位与改造步骤

1. 先读相关指南，再沿入口和调用者找职责所有者。先查具体目录，避免反复扫描媒体、
   日志、生成目录。可用 `git ls-files src tests scripts` 查看共享源码清单。
2. 确认输入输出契约：时间单位、ID、CLI 参数、JSON sidecar、stdout sentinel、
   重试和幂等语义。跨语言变更同时检查生产者与消费者。
3. 用一个失败行为或明确需求限定修改范围。在所属模块旁维护回归测试；跨服务场景放
   `tests/integration/`，Python 放 `tests/test_*.py`，夹具只保留最小必要数据。
4. 从大编排器中提取纯规则或明确的 IO 适配器，保留原路径的兼容导出。
   不让子模块反向导入父入口，不为整理目录迁移运行中的队列和历史状态。
5. 跑聚焦检查和适当的总检查，查看 `git diff --check` 与暂存范围，再提交。
   测试夹具应模拟当前协议，包括审核阶段；不要通过删除断言或关闭审核让旧夹具通过。

常见叶子模块：`asr/subtitle_text.js` 处理旧 ASR 的字幕文本；
`clipping/creative_subtitles.js` 处理精剪时间轴的 SRT 输出；两者分别保留原有截断/四舍五入
规则。`clipping/processing_stats.js` 处理切片统计；`clip_upload_description.py` 与
`clip_upload_errors.py` 处理上传简介和错误分类，均不负责上传或队列持久化。

## 验证与运行的区别

`npm run dev` 会启动服务，`npm run build` 会写生产 `dist`，`workflow:activate` 会改变
活动工作流。这些命令不能当作普通验证命令。部署步骤见
[architecture.md 的 PM2 deployment](architecture.md#pm2-deployment)。
不要直接执行历史诊断脚本验证一个重构：其中部分会请求付费 API 或发送评论。
真实媒体验收需要在具体任务中约定素材和行为，使用本地任务目录保存证据。
