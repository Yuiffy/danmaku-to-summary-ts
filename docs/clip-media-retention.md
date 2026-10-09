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
