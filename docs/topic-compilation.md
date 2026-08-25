# 跨录播话题合集

`topic:compile` 将多个录播的 SRT、XML 和媒体文件分成四个阶段：发现来源、搜索证据、
生成计划、编译成片。搜索和计划阶段只产生证据与 REVIEW 所需的中间 JSON，不自动投稿。

## 最小流程

```powershell
npm run topic:compile -- discover `
  --root "D:\recordings" `
  --output "tmp\topic\sources.json"

npm run topic:compile -- search `
  --manifest "tmp\topic\sources.json" `
  --topic "目标话题" `
  --output "tmp\topic\search.json"

npm run topic:compile -- plan `
  --search "tmp\topic\search.json" `
  --profile balanced `
  --output "tmp\topic\plan.json"

npm run topic:compile -- build `
  --plan "tmp\topic\plan.json" `
  --output "tmp\topic\compilation.mp4"
```

也可以用 `compile` 一次完成搜索、计划和编译：

```powershell
npm run topic:compile -- compile `
  --root "D:\recordings" `
  --topic "目标话题" `
  --output "tmp\topic\compilation.mp4"
```

## 来源清单

`discover` 会根据录播目录中的同名文件寻找媒体和 SRT/XML。需要使用重新识别后的字幕时，
可以手工写 manifest 并提供 `finalSrtPath`：

```json
{
  "sources": [
    {
      "id": "stream-2026-08-24",
      "mediaPath": "D:/recordings/stream.flv",
      "srtPath": "D:/recordings/stream.srt",
      "finalSrtPath": "D:/recordings/stream.final.srt",
      "xmlPath": "D:/recordings/stream.xml",
      "recordedAt": "2026-08-24 20:00:00",
      "streamTitle": "直播标题"
    }
  ]
}
```

SRT 是主播音轨证据，XML 是观众反应证据。自动 ASR 别名必须有弹幕附近的重复证据才会
提升为搜索词；最终窗口仍需按字幕边界校准。计划中标记 `needsReAsr` 的来源必须有
`finalSrtPath`，或者明确使用 `--allow-unverified-srt`。

## 结果与验收

编译会生成 MP4、最终 SRT、manifest 和 `_REVIEW.md`。REVIEW 中会保留来源、时间、命中词、
证据和去重信息。它是人工复核输入，不是上传授权；确认后仍应使用手工队列和 B 站审计流程。

默认媒体适配器复用项目的字幕烧录、GPU 资源调度和 NVENC/CUDA 回退。库调用方可以向
`buildCompilation` 注入 `mediaAdapter`，替换 SRT 解析、媒体切割、FFmpeg 执行和配置生成，
因此该流水线不再把 Sui 专用工作流写死为唯一实现。
