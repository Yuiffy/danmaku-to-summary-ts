# 手工候选切片队列

手工找到题材后，不需要再写一次构建脚本。把录播源、时间点和文案放入队列，worker 会使用统一的大字幕两段式压制方法生成成片、SRT、封面、JSON、投稿文案并追加 REVIEW。

队列文件是 `data/runtime/manual_clip_queue.json`，已被 `.gitignore` 忽略。

话题预审候选与普通成片共用数字编号。候选在 REVIEW、企微和上传列表中标为
`pending_cut`，进入待定前已有粗剪 MP4、同名预览 SRT 及独立的版本化候选 SRT；`npm run upload:clips -- enqueue --ids 123`
只保存授权并立即入队，由后台 worker 先烧录候选，再用原编号投稿。普通成片直接上传，
不会重复烧录。用户确认改词并投稿时用
`npm run upload:clips -- correct --id 123 --from "zzz" --to "睡睡睡" --enqueue`；
旧候选的 SRT 可通过 `npm run upload:clips -- subtitles --id 123` 补生成和查看。
自动发现会提前生成未烧字的粗剪供审核；旧候选可用
`npm run upload:clips -- preview --ids 123` 补生成，直接打开粗剪会自动加载同名 SRT。
粗剪保留少量前后上下文，REVIEW 中显示候选在粗剪中的起止秒数。
后续烧录复用有效粗剪；窗口或源媒体变化时重新粗剪。生成预览不会授权投稿。
已经确认证据、想烧字后检查成片时，可使用
`npm run upload:clips -- cut --ids 123 --review-note "已核对片段证据"`。
证据或文案问题未解决时仍会停止投稿；详见 `docs/topic-event-editorial.md`。

## GPU 性能档位

手工队列和岁己自动切片共用 `ownStreamClips` 的媒体配置。默认优先使用 `h264_nvenc + p4`，并使用 `cuda` 解码；NVENC 或 CUDA 不可用时，烧录器会自动回退到 `libx264`，不会生成无字幕成片作为首选结果。

worker 会自动采集前台窗口、运行进程、GPU 活跃度和主机 CPU：

- 空闲时使用配置的高速档，当前为 `2 路 / 2 线程`；
- 游戏或明显资源占用时自动降为 `1 路 / 1 线程`；
- 不需要设置 `DANMAKU_CLIP_CONCURRENCY` 或 `DANMAKU_CLIP_FFMPEG_THREADS`；
- 每个成片 JSON 会记录 `resourceMode`、`ffmpegThreads`、实际编码器和硬件解码设置，便于复核。

性能阈值依赖目标机器和当前负载；需要调整时，应在目标机器重新测量后再改生产默认值。

## 状态

- `pending_cut`: 待切；
- `pending_review`: 已切，等待人工确认；
- `pending_upload`: 已确认，等待进入上传队列；
- `upload_queued`: 已登记短 ID并进入 B 站上传队列；
- `uploaded`: 由上传 worker 回写的最终状态。

默认任务只切片、不投稿。只有显式加 `--auto-upload` 的任务才会在切完后自动登记并入队。

手工任务登记时会根据任务的主播、直播标题和开播时间自动生成具体来源，例如：

```text
岁己SUI 直播《陪你这个猪过周日！》2026-08-16 20:05:09
```

`REVIEW.md` 里的“手工队列”只表示内部选材方式，不会作为 B 站简介的来源。

任务有两个文案 profile：

- `small_sui`（默认）：上传标题使用 `【小岁】`，标签使用普通岁己切片标签；
- `old_sui`：上传标题使用 `【老岁片】` 前缀，标题末尾附直播日期，标签单独标为老岁片，适合跨年份旧录播题材。
- `shiori`：上传标题使用 `【小栞】`，沿用栞栞现有话题切片标签。

profile 只影响上传前缀、标签和队列标签，不改变粗剪、ASR/SRT、通用大字幕烧录、封面或 REVIEW 流程。

## 添加任务

```powershell
npm run manual:clips -- add `
  --media "D:\files\videos\DDTV录播\...\录播.flv" `
  --srt "D:\files\videos\DDTV录播\...\录播.srt" `
  --start 1234.5 --end 1356.0 `
  --title "标题" `
  --description "只写片中发生的事情" `
  --cover-text "第一行\n第二行"
```

老岁片任务：

```powershell
npm run manual:clips -- add `
  --profile old_sui `
  --media "D:\files\videos\DDTV录播\...\旧录播.flv" `
  --srt "D:\files\videos\DDTV录播\...\旧录播.srt" `
  --start 1234.5 --end 1356.0 `
  --recorded-at "2025-10-08T21:59:48+08:00" `
  --stream-title "旧录播标题" `
  --title "岁己听错显卡型号，弹幕现场纠正" `
  --description "岁己把 CPU 和显卡型号混在一起，弹幕随后纠正。" `
  --cover-text "CPU是谁？\n3050是显卡"
```

老岁片任务会从 `--recorded-at`（缺失时尝试从录播路径）识别日期，自动追加 `YYYY年MM月DD日` 标题后缀，并把 `--stream-title` 和日期补到简介头部。

不传 `--srt` 时会尝试使用与录播同名的 `.srt`；不传 `--output-dir` 时输出到录播目录下的 `manual_requested_clips`。

### 封面文案与换行

标题和两行封面应成组检查：默认用清楚的事实标题交代事情，封面补本人语气；原话已经自然时
也可保留口语标题。三处只围绕一个看点，可以有价值地重复，不强制统一人称或把两行写成铺垫加反转。
例如“同样一份DQ小料，分量有时能差三分之一”可配“花这么多钱加料／就给我这么一点点？”，
前提是片内原话支持。只修正有问题的字段，不把正确的事实标题强改成第一人称。

`coverText` 独立于投稿标题：建议第一段 4-9 个字符、第二段 5-11 个字符，
合计最多 20 个字符，标点、数字、英文字母与左右引号都计数。用实际换行或
字面量 `\n` 分隔白色小字和黄色重点；引用必须成对，缩写原话时改用不带引号的忠实口语复述或事实概括。
单行的“旅行搭子”等主题标签不视作完整封面文案。手工队列及字幕重压与普通切片一致，
会回退到投稿标题提取铺垫和重点；“铺垫？小岁：回应”中的独立称呼不能占掉铺垫行。
建议在文案审核时直接提供两段短句，避免旧标题过长导致额外换行。

统一的 `cover_generator.py` 保留文案和引号，不按字数删除词语或追加省略号。
较长的段落按字体实际宽度自动换行，必要时在可读字号内缩小；两段各最多显示两行，
描边、阴影和行距一起限制在居中 4:3 安全区内。建议安装 `jieba`（`python -m pip install jieba`）
以保护中文词边界，避免把“力气”等词拆开；未安装时仍能保留全部文字，按标点与字体宽度换行。
没有专用封面文案的旧任务仍可从
投稿标题提取分句，但不会在引号内部按逗号或冒号拆句。超出可读排版容量时明确报错，
应精简文案后重试，不会悄悄截断。既有封面不会自动覆盖，修改过的封面仍需按原流程审核。

## 执行与确认

```powershell
npm run manual:clips -- list
npm run manual:clips -- worker --once
npm run manual:clips -- approve mcq-00001
```

`worker` 每次处理一个 `pending_cut` 任务；不带 `--once` 时会继续处理队列中剩余任务。切完后会先得到短 ID，但默认停在 `pending_review`。确认无误后运行 `approve`，才会入上传队列。

批准前应检查成片画面、标题、封面主体和字幕，并运行
`npm run bilibili:clip-audit -- --video ... --metadata ... --evidence ...`。
完整验收清单见 `docs/bilibili-clip-verification.md`。同标题稿件会进入人工核对，不能直接当作当前任务已上传。

需要让它持续等待新任务时运行 `npm run manual:clips -- worker --loop`；该进程每 30 秒检查一次队列。

## 立即投稿

对明确授权、无需人工复核的任务添加 `--auto-upload`：

```powershell
npm run manual:clips -- add --media "录播.flv" --start 100 --end 180 `
  --title "标题" --description "简介" --cover-text "封面字" --auto-upload
npm run manual:clips -- worker --once
```

切完后脚本会导入成片 metadata JSON、取得上传短 ID并调用现有上传队列；`REVIEW.md` 只用于人工审核展示。仍由单实例上传 worker 负责 B 站重复检查、限流和状态回写。企微通知默认开启，可用 `--no-notify` 关闭。
