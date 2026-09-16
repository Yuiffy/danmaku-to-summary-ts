# Seedance 双通道队列

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

## 并发限制、异常和恢复

- Dreamina 返回 `ExceedConcurrencyLimit` 时，该通道会冷却两分钟，不消耗 repeat、不增加失败次数；另一个通道仍可继续运行。
- 审核、缺失参考图、无效模型或分辨率会立即暂停任务。
- 本地 CLI 超时或缺少提交 ID 时，任务会保留 `submission_reservations` 并标记为需要人工检查，不自动重提。
- 需要从头执行某个任务时，用管理员工具显式清空已提交、生成中、保留和暂停状态：

```powershell
python scripts/seedance_queue_admin.py reset-tasks "D:\files\Pictures\AI图保存\seedance\近期岁己居家下载\seedance_queue.json" task_099 --note "重新执行"
```

队列读写使用同目录锁文件和原子替换；不要在 PM2 运行时用旧的一次性脚本直接重写 `seedance_queue.json`。
