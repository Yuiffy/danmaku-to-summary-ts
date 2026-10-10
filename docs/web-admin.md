# 本机 Web 管理工作台

工作台首页统一管理配置、视频审核、直播提醒、录播检索、任务与延迟回复。
它通过本机管理 API 调用已有工作流，不创建第二个上传 worker 或延迟回复调度器。

## 启动与依赖

开发时在两个终端分别执行：

```powershell
npm run admin:dev
npm run dev:next
```

浏览器打开 `http://127.0.0.1:3000`。管理 API 默认只绑定 `127.0.0.1:15127`；
可用 `/?clip=<数字 ID>` 直接打开指定视频的审核内容。
延迟回复仍访问 `WEBHOOK_BASE_URL`，默认 `http://127.0.0.1:12523`。
网页和管理 API 可独立启动；服务未连接会显示明确错误。
旧 `/delayed-tasks` 页面保留兼容路径，其 HTTP adapter 同样检查本机 Host 与 Origin。
主机需有 Node 与 Python。纯配置、列表、提醒管理和字幕读取无需 GPU；
点击实际制作、精剪或上传相关操作需要原有工作流环境和对应凭据。

生产构建使用 `npm run build:next` 和已经验证、单独部署的服务产物，
以 `npm run admin:start` 启动管理 API，`npm start -- --hostname 127.0.0.1` 启动网页。
验证不启动 PM2、不部署 `dist`、不激活工作流；常驻化与升级沿用单独部署授权。

管理 API 首次启动生成 `data/runtime/admin/access-token`，只由 Next 服务端读取；
网页不接收此令牌。两端固定本机地址，并检查网页 Host、Origin 和跨站请求。
不要把 Next 管理页绑定公网；远程访问需要另行设计认证与访问边界。

可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `ADMIN_PORT` | 管理 API 端口，默认 15127 |
| `ADMIN_BASE_URL` | Next 访问的本机管理 API 地址 |
| `ADMIN_TOKEN_FILE` | Next 读取的服务令牌文件，默认仓库 runtime 下的文件 |
| `ADMIN_VOTE_CONFIG` | 管理 API 使用的直播机器人配置，默认 `data/runtime/live-vote.json` |
| `ADMIN_PYTHON` | 固定 Python 可执行程序，默认 PATH 中的 `python` |
| `WEBHOOK_BASE_URL` | 权威延迟回复服务地址 |

## 配置修改

只开放固定文件：`config/production.json`、`config/default.json`、
`data/runtime/live-vote.json`（或启动时指定的文件）、`config/secret.json`、
`config/generation-modes.json`。不存在的文件不在切换列表中。
按分组编辑 JSON，切换分组保留草稿；保存校验文件版本、已维护的配置规则，
先备份原字节，再原子替换。并发修改返回 409，必须重新加载。

凭据默认隐藏。保持完整占位字符串保留原值，填写新值可替换；
每个占位绑定具体秘密，所以数组重排不会串用另一个 provider 的密钥。
管理服务重启后旧占位失效，重新加载即可。
备份位于被忽略的 `data/runtime/admin/config-backups`，包含原文件的真实凭据，
与原配置一样只保存在本机。凭据覆盖与环境变量优先于主配置；网页编辑的
主配置不是有效配置的完整展开。常驻服务需要单独部署或重启后读取新配置，
网页保存不会自动重启；源码 CLI 在下次调用时读取配置。

## 视频与手工任务

列表只读现有短 ID 注册表，不运行具有状态同步写入的 `list/show` CLI。
视频、粗剪、封面和字幕只按登记 ID 读取，并校验真实路径位于已配置的
录播或归档根目录；链接不能传入任意文件路径。播放器支持字节范围，
SRT 的网页显示副本转换为 VTT，原审核字幕保持不变。

普通切片可以准备字幕、生成粗剪、按原文字和可选 cue 改词、修订文案与归属、
准备重制、制作、AI 精剪、人工批准、入队投稿或排除。所有操作调用原有
`clip_upload_registry.py`，不手改 queue、approval 或 SRT 哈希。
改词后的待制作修订与旧视频分别显示；粗剪 cue 不作为候选 cue 自动提交。
审核版本包括注册记录、元数据、字幕和媒体大小/修改时间；提交时与实际执行前
都检查版本。最终来源、哈希与发布证据仍由原有 CLI 校验。

歌切、同步视听和游戏包支持逐 P 播放，批准使用各自的 `approve --metadata`
命令；投稿按完整包入队，保留四小时超时，不拆 P。歌切/观看包也可调用
`restyle` 更新包装。“重制与精剪”页可指定已核对的名称证据、作品名原帧，
重审未确认边界、修订复核路线或提交可信时间修复 RESULT.json。
修复的源录播/SRT/XML 由登记元数据决定，客户端不能替换。
时间修复重制本场两类包，仍遵循[活动指南](stream-activity-clips.md)中的同源、
预算和修复证据契约；审核版本包含所有 P 的字幕摘要。

任务页的“完整内容制作”支持歌曲/同步视听、游戏的 plan/run。
活动制作只复用共享梗概，不自动进行整场扫描或重复总结；缺少匹配梗概时失败。
制作与修复命令使用独立临时配置，关闭自动发布和通知，再调用原工作流。
临时配置在进程结束后删除，原生产配置不变；完整包仍登记在原注册表，等待人工审核。

手工切片页可填写录播、SRT、绝对秒数、文案和 `small_sui` / `old_sui` 样式，
调用已有 `manual_clip_queue.js add`。制作下一条调用已有单次 `worker`，
生成后预览实际视频与封面，再按当前任务/媒体版本授权投稿。
普通批准或制作不自动投稿；投稿按钮、改词后投稿复选框、手工审核投稿
才携带明确发布授权。已发布 ID 的再次投稿限制继续由原有注册表执行。

管理操作串行执行，浏览器请求立即返回任务 ID。结果、退出码与限长输出
保存在 `data/runtime/admin/jobs`；网页每三秒读状态。
管理进程中断的任务保留为 `interrupted`，不自动重试；子进程可能仍在完成操作，
应先核对原队列、产物和日志再显式重提。上传 worker 的重试、限流与幂等规则不变。

## 提醒管理

网页可管理事项名称、启用状态、多版本文案、总开关及本场暂停/恢复，
并查看每日发送与企微记录。时间窗口等策略在直播机器人配置的 `reminders`
分组编辑。首次可使用“添加提醒配置”，补全绝对路径后保存、按原流程启用机器人。

网页只向 `<statePath>.commands/` 追加独立管理指令；直播机器人是唯一状态写入者，
每次 tick 接收、校验并应用，保存状态与已应用 ID 后确认指令。每日发送 receipt
保留不变，不因编辑、重启或不确定发送结果自动重发。
正在发送的提醒保留 receipt 对象；待发送的旧版本由 generation 失效取消。
错误与生效回执在页面可见；积压表示机器人尚未接收，不能报告已经生效。
dry-run 继续使用 `.dry-run` 状态与独立 inbox。

## 录播检索与延迟回复

录播检索直接复用已配置房间的 `QuestionCorpus`、问题校验和 `LabGate`。
“查证据”不调用回答模型；语义检索是否请求 embedding 取决于既有配置。
“问鹿饼”显式调用固定回答 provider，展示完整答案与引用。
网页查询频控与弹幕机器人独立，取消或离开页面传播中止，底层退出前不释放名额。
不发送弹幕、不发布动态评论，不接受用户或模型指定任意路径或命令。

延迟回复经 Next HTTP adapter 转发给 Webhook 的权威 API：列出、创建、取消。
创建按钮显式授权后续评论；取消不能越过原服务对正在发布任务的保护。
网页先显示页面内的目标与操作确认，再转发创建或取消。
没有另一个本地 scheduler 或对生产 delayed-task 文件的直接写入。

## 验证

```powershell
npm test -- --runInBand --runTestsByPath src/services/admin/AdminServer.test.ts "src/app/api/admin/[[...path]]/route.test.ts" src/services/live-vote/reminders/LiveReminderSession.test.ts
npm run verify:quick
npm run verify:all
npm run build:next
```

行为测试注入命令 runner 和问答/通知 adapter，使用隔离文件，验证并发冲突、
凭据遮蔽与数组重排、媒体越界、范围播放、旧审核拒绝、明确投稿授权、
提醒 receipt 保留、专用整包审核与私有检索边界。浏览器验收同时检查列表、
播放器、字幕定位、配置保存、提醒处理回执和任务输出；真实发布须另行授权。
