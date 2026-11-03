# 已上传岁己派生视频保留与重切

`audio.storage.publishedClipRetention` 控制独立维护命令。production 启用，default
关闭；`afterUploadDays` 默认 3，最小 3。按确认投稿成功的 UTC 时间满 72 小时后清理，
不是按视频创建时间，也不是按自然日。Windows 任务每小时扫描一次，登录时补跑；机器
关机或用户退出期间暂停，恢复后补跑。与原有转 Opus、33 天归档规则独立。

支持岁己原始日期录播派生的普通 own-stream、manual/candidate、完整活动和游戏多 P。
只有注册表 `status=uploaded`、上传回执 `source=ok`、有效 BVID、回执媒体路径与当前
注册表一致才可处理。标题搜索得到的历史重复项不能作为删除依据。游戏外置字幕需已
完成发布。未完成队列、其他未完成或未满保留期的共用媒体引用、手工队列引用会阻止清理。

原录播、最终 SRT、封面、文案、JSON、计划、上传回执全部保留。删除前原子写入与元数据
同目录的 `*.media-retention.json`：包含原元数据快照、BVID、精确源时间段、源文件身份、
编码/字幕配置、最终字幕文本和 SHA-256、全部 P 和删除进度。新普通片还在
`output.renderSettings` 保存生成时的设置；历史片使用清理时配置并记录输出里的已有
设置。重切保持素材、时间段和字幕；历史编码/字体环境变化不保证视频字节完全相同。

33 天归档会保留配方引用的精确源录播，即使同目录后来新增 merged 录播也不会删掉
该源文件。配方损坏或版本未知时，保守保留当天根目录录播，避免归档破坏重切能力。

实际精剪/特效、源录播不存在、未知格式、资料不全的片跳过。仅有未选中的
`precisionExperiment` 或选材 `topicEditPlan` 不表示视频已做精剪。跳过原因进入报告，
不能为扩大清理范围而退化成连续截取精剪视频。当前规则仅清理 D 盘派生视频，E 盘不扫描。

删除时使用上传队列已有的短时互斥锁，重读状态，校验媒体、元数据、源文件和字幕未变化。
多 P 中途退出保留配方，后续扫描继续删除剩余 P；不会修改上传注册表或再次投稿。

```powershell
# 只预览；--report 可另存完整 JSON
python src/scripts/clip_media_retention.py sweep
python src/scripts/clip_media_retention.py sweep --apply --report data/runtime/clip_media_retention_last_run.json

# 按原 ID 重切到全新目录，无 AI/ASR/上传，也不修改原成功记录
python src/scripts/clip_media_retention.py restore --id 2018 --output-dir tmp/replay-2018

# 安装/更新当前用户的每小时 Windows 维护任务
& ./scripts/install-clip-media-retention-task.ps1
& ./scripts/install-clip-media-retention-task.ps1 -Disable
```

重切调用现有普通片、活动、游戏渲染器，从配方中的时间段和最终字幕恢复。D 盘原录播
或配方已按原规则迁到 `archiveTargetBasePath` 时，自动按相对路径在 E 盘查找。源文件
大小或修改时间不匹配时停止，要求先恢复相同原录播。输出目录必须全新，避免覆盖已上传
产物。结果保存在 `REPLAY_RESULT.json`，配方副本保存在 `REPLAY_RECIPE.json`。

既有跨盘归档通过 JavaScript Date 保留修改时间，可能截去毫秒以下精度；只有从 D
映射到 E 的源文件允许小于 1 毫秒的时间误差，文件大小仍须完全一致。

任务名 `Danmaku-Sui-Published-Clip-Retention`，当前用户交互登录、普通权限、禁止重叠，
使用同一 Python 环境的 `pythonw.exe` 静默执行。最近完整报告在
`data/runtime/clip_media_retention_last_run.json`；也应检查 Windows 任务的退出码。

聚焦验证：`python -m unittest discover -b -s tests -p test_clip_media_retention.py`。

## 媒体制作工作目录

项目 `temp/`、`tmp/` 只放脚本、研究记录、报告等小型任务文件。下载/重封装视频、
分段渲染、音频和预览使用录播根目录的 `_workspaces/<任务名>/`；它在房间/日期目录
之外，不进入原录播的 33 天归档遍历，原录播音频转换/过期扫描也跳过 `_workspaces`。
单源成片仍放对应录播的 `manual_requested_clips/`，
多场系列按首场或已有投稿包目录归档，保留来源列表和下一集起点。

```powershell
python src/scripts/media_workspace_retention.py new --name happy-sui-ep05
# 使用返回的 scratch 路径存放可丢弃渲染分片、抽取音频、重封装缓存。
# 任务结束、成片与字幕/时间轴已归档后关闭；从此刻起至少保留 7 x 24 小时。
python src/scripts/media_workspace_retention.py close --name happy-sui-ep05
python src/scripts/media_workspace_retention.py sweep
python src/scripts/media_workspace_retention.py sweep --apply --report data/runtime/media_workspace_retention_last_run.json
& ./scripts/install-media-workspace-retention-task.ps1
```

默认根目录从生产配置的 `webhook.endpoints.mikufans.basePath` 派生，不扫描整个盘。
`--root <绝对目录>` 用于独立指定另一个媒体工作目录；离线验收注入引用/删除适配器，
不读取真实队列。`new` 创建 `WORKSPACE.json` 和 `scratch/`，
默认 active，永不自动过期；继续制作时新建修订工作目录。`close` 对 scratch 中明确列举的
媒体记录大小/修改时间，字幕、JSON、脚本、图片和成片不会因扩展名或目录年龄被自动删除。
只清理 completed 满 7 天且文件也至少 7 天未修改的声明条目；`--keep-days` 只能延长保留。
目录不递归删除，不清空任意 `temp`，未登记文件始终保留。

旧工作区迁入此处时可在旧项目路径留下目录 junction，兼容已有绝对路径的时间轴和脚本；
依赖项目相对 `__dirname` 的旧 Node 任务脚本需从旧入口加
`--preserve-symlinks --preserve-symlinks-main` 运行，或先显式设置项目根路径；
目录链接只保证既有绝对数据路径可读。新任务必须直接用媒体路径并显式传入项目根。
旧工作区默认保留所有文件，只有人工核对为可重建的重封装
媒体才登记 `cacheEntries`：`kind: remux`、相对 `path`、`identity`、绝对 `source`、
`sourceIdentity` 和 `rebuild: {method: stream-copy-from-origin, origin: 原录播秒数}`。
原录播必须仍存在且身份未变；原录播迁移后须重新核对身份，不能猜路径后删除缓存。
该配方复用原有选定起点的 stream copy，不用于删除唯一素材。保留来源 JSON 和制作计划。

清理复用投稿短锁，保护注册表/队列引用（包括成功成片）和未完成手工任务的素材；
源文件缺失、缓存变化、目录链接、未知清单、删除失败均保留并写报告。
删除前写 `RETENTION.json` 的 pending 条目，删除后记入历史，支持中断后重跑。
主清单不修改，报告与删除日志不作为投稿/审核状态。定时任务
`Danmaku-Media-Workspace-Retention` 每小时和登录时执行，普通权限、静默运行、禁止重叠；
当前用户未登录时等待下次登录补跑。它与上面的已投稿成片 72 小时清理任务独立。

项目 `temp/` 另有独立的 `Danmaku-Project-Temp-Retention` 任务，每小时和登录时运行，
默认清理根目录下最后修改超过 7 天的一级任务目录和根文件。它只操作物理目录和文件，
跳过 Junction/符号链接、含 `.keep` 的目录、最近修改的任务以及显式保护路径；不扫描或
删除 `tmp/`、`build/`、`dist/`、录播根目录、队列和上传状态。删除前生成报告，失败项保留，
报告写入 `data/runtime/project_temp_retention_last_run.json`。需要长期保留的任务证据应移到
受维护目录，或在任务目录内放置 `.keep`。

```powershell
python src/scripts/project_temp_retention.py --report data/runtime/project_temp_retention_last_run.json
python src/scripts/project_temp_retention.py --apply --report data/runtime/project_temp_retention_last_run.json
& ./scripts/install-project-temp-retention-task.ps1
```

聚焦验证：`python -m unittest discover -b -s tests -p test_media_workspace_retention.py`。
