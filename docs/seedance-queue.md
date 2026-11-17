# Seedance 双通道队列

## QQ 与 Dreamina Canvas

QQ 请求经 `seedance_qq_bridge.py` 的固定 JSON stdin 协议进入同一 `QueueStore`，
`qq` 保存应用、用户、群和消息的服务端绑定摘要；模型工具不接受路径或任务 ID。
`lookup/status/draft` 只读本人本群记录；`enqueue` 使用原子锁去重并创建一次任务。
默认状态 `draft`，供素材名称、完整 prompt 与设置预览；`approve` 才将最新草稿置为 `pending`。
明确“直接生成”的完整请求可直接创建 `pending`。修改只替换未调度草稿，将旧条目标为 `cancelled`。
调度、规范化与提交预留均保留并跳过 `draft/cancelled/paused`，禁止确认前自动运行。

新 QQ 任务标记 `backend: dreamina-canvas`，由 `seedance_canvas.py` 提交、观察和下载；
没有该标记的旧任务继续调用原 CLI。QQ 只开放 Fast VIP 和 Mini、720P、4—15秒，
默认9:16/15秒；provider 分别映射到实时验证过的 `seedance_2.0_fast_vip`、`seedance_2.0_mini`。
有图片时用 `m2v`；无图片／音频时用 `t2v`。最多9图／3音频，声线必须伴随图片。

project/node/update/submit 与上传 resource 的公开 ID 在任何 provider IO 前写入任务。
Node ID 遵循 CLI 的 `node_` 加 10 位小写 Crockford Base32 契约；project/update/submit/resource
保持规范 UUID。CLI 的结构化错误可能写入 stderr，适配器校验退出状态与 JSON envelope，
保留机器错误分类；参数无效与服务不可用分别暂停，不将 CLI 参数错误误报成网络故障。
错误分类兼容旧 envelope 与 CLI 1.3.0 的 schema v2 数字码；账号授权不足停止准备，
不将本地“已登录”当作远端画布访问已获准。
原子 sidecar `qq-canvas/<taskId>.json` 保存准备、待积分确认、运行意图和观察阶段；
`run_intent` 必须先于 `node run`。运行响应丢失、进程重启或状态不确定时，
只通过同一 submit ID 查询 `operation status`，不自动再次提交。
准备中断／未知操作需要人工核对；旧队列的自动失败重试不应用于 Canvas QQ 视频。

管理员已统一授权 QQ 视频积分自动处理。Canvas 要求积分确认时以最新 `totalMaxCredits`
自动调用 `node confirm`，不再逐条询问群用户；报价缺失、无效或确认失败时暂停交管理员检查。
旧 `approvedCredits` 不再作为新报价的手动门槛；`confirm` 命令仍兼容旧消息。
旧 `confirmation_required` 暂停项仅在 sidecar 为 `awaiting_confirmation` 且没有在途／预留时恢复原任务，
不会重放 `run_intent/observing`。调度 dry-run 不做该迁移。
`credit_usage` 原子记录 `submit_id/quoted_credits/run_state/updated_at`；运行状态区分
`quoted/intent/accepted/rejected`，以同一 submit ID 覆盖更新，拒绝和仅报价不计入已提交积分。
QQ 昵称保存在 `qq_sender_name`，归属仍使用原 `qq` 摘要。管理页跨群按应用＋用户汇总，
不受任务列表分页／搜索影响；缺价历史与提交不确定单列。报价上限不代表最终扣费或退款。
信用凭证仅内存使用，不能持久化；结构化积分不足回复无积分，登录失败单独处理，
未识别的服务错误不推测余额。运行中只有确切成功且唯一的视频资源才能下载，下载失败保留原尝试，
不会重新生成。成片登记到 `qq-results/<taskId>/video.mp4` 的 `qq_output`，再更新完成数量。
QQ 领取和 Web 播放均限定登记目录与 MP4 大小；只读取原子队列不请求 provider 的管理页见
[Web AI 视频](web-admin.md#ai-视频生成队列)。

`scripts/seedance_queue_runner.py` 将任务按模型分为两条互不阻塞的线上通道：

- **普通通道**：`seedance2.0`。默认最多 1 个远端任务，保持原有任务在 JSON 内的稳定顺序。
- **VIP 通道**：`seedance2.0mini`、`seedance2.0_vip`、`seedance2.0fast_vip`、`seedance2.5`。默认最多 24 个远端任务；无视普通任务在 JSON 中的位置，但在 VIP 任务之间保持稳定、轮转的顺序。

本地 JSON 不会为了优先级而重排。任务的 `model_version` 决定线上通道，避免“标了 VIP 但实际提交普通模型”的不一致。

## 添加任务

先检查已有参考图别名：

```powershell
python scripts/seedance_add_task.py list-refs
```

低成本验证提示词和参考图时，可先加入 mini 任务：

```powershell
python scripts/seedance_add_task.py add `
  --name "mini 验证：厨房互动" `
  --prompt "..." `
  --refs xiaohuamao,binggan `
  --repeat 1 `
  --model-version seedance2.0mini `
  --resolution 720p
```

确认效果后，添加 VIP 批次：

```powershell
python scripts/seedance_add_task.py add `
  --name "VIP 批次：厨房互动" `
  --prompt "..." `
  --refs xiaohuamao,binggan `
  --repeat 42 `
  --model-version seedance2.0_vip `
  --resolution 720p
```

15 秒视频的积分以 Dreamina 页面当前价格为准。当前批次采用：`seedance2.5` 为 390 积分、`seedance2.0_vip` 为 210 积分、`seedance2.0fast_vip` 为 90 积分；添加任务前按实际页面价格和余额重新计算。工具不会自动按余额扣停。

任务可以额外保存 `duration`（普通模型 4-15 秒，`seedance2.5` 为 4-30 秒）和 `audio_references`。`scripts/seedance_queue_runner.py` 会把它们分别透传为 `--duration` 和 `--audio`；音频参考应在 prompt 中明确写成 `@Audio 1` 等模型可识别的引用。

`seedance2.0` 与 `seedance2.0mini` 只能使用 720p；`seedance2.0_vip` 与 `seedance2.0fast_vip` 可使用 720p、1080p 或 4k；`seedance2.5` 可使用 480p、720p 或 1080p，并进入 VIP 通道。

## 预览和提交

先做纯本地预览。它不会查询 Dreamina、写队列、创建锁文件或下载文件：

```powershell
node scripts/seedance_queue_runner.js --fill --dry-run --max-vip-inflight 24 --max-normal-inflight 1
```

紧急使用 VIP 容量时执行一次填充：

```powershell
npm run seedance:queue:vip-fill
```

该命令最多维持 24 个 VIP 远端任务和 1 个普通远端任务；它不会取消已在线上的普通任务。循环服务也按同样的两通道容量持续补位：

```powershell
npm run pm2:seedance:restart
npm run pm2:logs:seedance
python scripts/seedance_add_task.py list-tasks
```

每个远端提交都会记录到任务的 `inflight`，成功下载后才会增加 `completed`。查询超时、未知状态、下载失败都会保留远端提交，避免重提可能已经扣费的任务。
提交使用 `--poll 0`：先取得并保存受理ID，再由队列独立查询结果，避免CLI在提交后的
内联查询失败时丢失stdout中的受理ID。已存在的 `submission_reservations` 若标记
`needs_review`，先用 `dreamina list_task` 核对刚提交的同一提示词、提交身份与远端状态，
恢复该次受理记录；不要为了让队列继续而清空未知提交或重新运行生成命令。

## 并发限制、异常和恢复

QQ 视频入口由 `seedance_qq_limits.py` 计算入队频率，`seedance_qq_bridge.py` 在原有短事务锁内
同时检查并预留次数和个人活动任务位；不能只在 Node 侧先查后写。默认与 QQ 图片标准一致：
每人滚动5小时10次、每天30次、全局每天300次、全局60秒间隔。受信 Node 入口按配置用户标识
为运营者传入50次/5小时、150次/天、个人10秒间隔、4个活动视频；普通用户1个，跨群合计。
`qq_admitted_at` 仅在正式入队时记录；草稿和查询不计次，重复请求仍返回原任务。
`qq_delivered_at` 只在 QQ 成功发送视频后记录，多任务领取选择最早未领取成片。
这些入队限制不改变 provider 通道并发、既有任务调度或不确定提交的恢复规则。

QQ Canvas 视频任务可同时保存 `video_references`（本地原MP4路径）、`video_durations_ms`
（逐段时长）和 `canvas.videoResourceIds`（逐段稳定资源身份）。省略时按旧任务的空视频列表处理。
最多3段、每段50MiB、单段2—15.4秒且总时长最多15.4秒；Node QQ 输入适配器先做实际媒体校验，
bridge 和 runner 复核数量、时长及文件存在，草稿修改保留这些原视频。
Canvas 上传时使用 video 类型，以 `@Video N` 绑定对应资源；只要有图片或视频就用 m2v。
图片、视频、音频合计最多12份；引用视频失败不能退化成无视频生成。网页队列分别展示三类素材数量。

- Dreamina 返回 `ExceedConcurrencyLimit` 时，该通道会冷却两分钟，不消耗 repeat、不增加失败次数；另一个通道仍可继续运行。
- 审核、缺失参考图、无效模型或分辨率会立即暂停任务。
- 本地 CLI 超时或缺少提交 ID 时，任务会保留 `submission_reservations` 并标记为需要人工检查，不自动重提。
- 需要从头执行某个任务时，用管理员工具显式清空已提交、生成中、保留和暂停状态：

```powershell
python scripts/seedance_queue_admin.py reset-tasks "D:\files\Pictures\AI图保存\seedance\近期岁己居家下载\seedance_queue.json" task_099 --note "重新执行"
```

队列读写使用同目录锁文件和原子替换；不要在 PM2 运行时用旧的一次性脚本直接重写 `seedance_queue.json`。
锁文件刚创建时可能尚未写完 JSON；读取失败时按文件修改时间判断过期，不能立即抢占新锁。Windows 暂时无法删除过期锁时，继续遵守原锁等待上限。
释放自己的锁遇到 Windows 临时读取或删除冲突时，在同一等待上限内重试并重新核对 owner，不能直接遗留锁文件。

### 查询异常与已确认的生成失败

`submitted` 是本地状态，不能证明远端仍在生成。CLI 查询失败（包括 `get_history_by_ids`
的错误）也不能直接判定视频生成失败；成功任务也可能受查询接口故障影响。此时保留原
`inflight` 和提交身份，先核对网页上同一任务的提示词、日期与明确终态。

先运行 `dreamina user_credit` 验证CLI账号。若输出账号ID为0、用户名和会员为空，而网页
能正常查看账户与积分，不把CLI的0积分当作真实余额；检查登录或访问权限。`dreamina login`
复用本地OAuth状态并不能证明服务端仍接受该状态。必要时使用 `dreamina relogin --headless`
发起常规登录续期，在官方授权页完成后，按CLI帮助用 `dreamina login checklogin` 保存
授权，再核对账号与积分，并用原 `submit_id` 重查结果。保留提交历史，不清空任务或改换ID。

正常查询恢复后，runner能够识别 `gen_status=fail`，释放失败的那次本地活跃容量；普通
生成失败会按现有三次失败上限重试，达到上限或收到审核/参数拒绝才暂停。`completed`
不会因为失败而增加。登录续期后观察已有runner的日志与新提交，不需要为此重启PM2。
