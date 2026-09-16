# B 站切片发布验收

## 背景

这次错配暴露了三个独立问题：

- 上传查重按标题判断“已上传”，没有确认线上稿件与当前本地媒体是同一条视频；
- AI 选材、标题和简介缺少最终时间窗口的逐条事实核对，邻近候选可能串题；
- 自动封面只保证画面清晰或有反应，不保证题材主体出现在画面中。

因此，标题、视频内容、字幕证据和封面必须分别验收，不能用其中一项代替其他项。

## 发布前验收

对每个准备上传的切片运行只读审计：

```powershell
npm run bilibili:clip-audit -- `
  --video "D:\path\clip.mp4" `
  --srt "D:\path\clip.srt" `
  --metadata "D:\path\clip.json" `
  --cover "D:\path\clip_cover.jpg" `
  --evidence "5070Ti|5070 Ti" `
  --expected-title "【小岁】5070Ti小岁宣布生殖隔离：5060和我已经不是一个世界"
```

需要核对线上稿件时追加：

```powershell
npm run bilibili:clip-audit -- `
  --video "D:\path\clip.mp4" `
  --metadata "D:\path\clip.json" `
  --bvid BV1xxxxxxxxx `
  --expected-title "【小岁】标题"
```

审计失败时返回非零退出码。线上稿件仍在审核、暂时没有可用时长时，审计会报告警告；正式批处理可加 `--strict-warnings` 把警告也视为失败。

审计能自动确认：

- 视频有视频流，时长大于零，并且有音频流提示；
- SRT 有内容，字幕时间不越过成片，顺序和区间合法；
- 元数据中的 `output.mediaPath` 就是当前上传文件；
- 元数据确认字幕已烧录，且 `srtSegmentCount` 与 SRT 数量一致；
- 封面存在并接近 16:9；
- 指定的型号、人名或事件词确实出现在当前 SRT；
- 线上标题和时长与本地期望值一致。

封面是否真的出现题材主体仍需要人工看一眼图片。自动选帧只能提供候选，不能证明“封面有梅琳娜”这类语义事实。

## 同标题处理

`batch_upload.py` 和上传队列现在把同标题识别为 `title_conflict`，不会写入 `done`，也不会把当前本地文件伪装成已上传。冲突会保存到对应状态文件的 `title_conflicts`，队列会停止并要求人工核对。

核对步骤：

1. 用线上 BV 运行上面的审计，比较线上标题、时长和本地视频；必要时人工抽看画面。
2. 如果目标是修正已有稿件，使用 `replace_video.py` 和 `update_cover.py` 编辑原稿件；不要把它当成新投稿查重成功。
3. 如果确实要另投一条修正版，先完成本地审计，再显式使用上传队列的 `--force`。`--force` 只表示授权跳过同标题查重，不代表内容已经验收。

旧状态文件中的 `search_dup` 和 `already_exists` 记录不会再被当成本地上传成功；下次运行会重新进入同标题冲突流程。

## AI 选材规则

`src/scripts/own_stream_clipper.js` 的提示词要求：

- 标题、封面文案、简介和理由只能来自当前 `startTime-endTime` 窗口；
- 直播标题只用于确认来源，不能作为片段内容证据；
- 不得借用其他候选窗口的型号、人物、事件或梗；
- 输出前逐条核对事实，无法在当前窗口字幕或弹幕中确认的候选直接删除。

`topic_clipper.js` 也遵循最终窗口事实核对规则。新增或调整选材逻辑时，必须同时保留“窗口证据词”和人工 REVIEW；不要只根据标题或关键词命中自动投稿。

## 文件归属

- 通用审计脚本：`src/scripts/audit_bilibili_clip.py`；
- 单元测试：`tests/test_audit_bilibili_clip.py`；
- 一次性截图、替换清单和临时媒体：放在 `tmp/`、`temp/` 或录播目录的 `temp` 下；
- 不要把具体 BV 号、日期、机器路径写进通用脚本，也不要把一次性补救文件加入 Git。
