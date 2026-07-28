# 录播补下载与回填流程

用于录播缺失、录播坏档、或需要从 B 站及第三方录播站补跑晚安总结、漫画和自动切片的场景。优先把同一场直播的可用分段合并成一条媒体再处理，避免分段分别生成导致上下文断裂。

## 适用判断

- 原始 DDTV 录播不存在、损坏，或缺少可用 SRT/XML。
- B 站、第三方录播站或本机残留分段里还有可用视频。
- 目标是补走项目主流程：ASR/SRT -> AI_HIGHLIGHT -> 晚安文本 -> 漫画脚本 -> 漫画图 -> 自动切片 -> 评论/补图。

不建议把 P1/P2 分开各跑一次，除非它们本来就是两场独立直播。联动、长杂谈、游戏流程类内容要合并后处理。

## 先建立覆盖时间线

不要看到若干 FLV 的总时长后就直接认定找齐了。先为每个来源建立墙钟时间区间：

| 字段 | 含义 |
| --- | --- |
| source | 来源站点、本机录播姬或 B 站稿件 |
| path | 本地文件路径 |
| wallStart | 文件对应的真实开播时间 |
| duration | `ffprobe` 得到的媒体时长 |
| wallEnd | `wallStart + duration` |
| usable | 是否有完整音视频轨、能否扫描到结尾 |

直播的真实开始和结束时间应综合目录名、XML 的 `start_time`、主播动态、直播状态记录和文件时间判断。文件名只能作为线索，不能作为唯一事实。

逐段检查：

```powershell
ffprobe -v error `
  -show_entries format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate `
  -of json `
  "D:\path\segment.flv"
```

按 `wallStart` 排序后计算相邻区间：

- 重叠：选择质量更高、覆盖更完整的来源，不要把重复内容拼两次。
- 连续：允许正常合并。
- 缺口：继续搜索其它目录、隐藏文件、B 站回放和本机残留录播。
- 搜索穷尽后仍有缺口：输出文件必须使用 `_best_effort` 后缀，并记录缺失的墙钟时间段。

成品时长应该等于所有保留区间的并集，不等于直播墙钟跨度。用这个等式可以快速识别“只合并了后半场”或“重叠段被重复计算”。

## 工作目录

把临时产物放到 `uploads/` 或 `tmp/` 下，避免混进正式录播目录和 git diff。

```powershell
$work = "uploads\recovery-<roomId>-<YYYYMMDD>-<slug>"
New-Item -ItemType Directory -Force -Path $work | Out-Null
```

如果后面要保留成正式产物，再把最终 `*_AI_HIGHLIGHT.txt`、`*_晚安回复.md`、`*_COMIC_*` 移到目标录播目录。

## 从 darkpy 录播站下载

站点入口是 `http://rec.darkpy.cn:5144/#?list=list`，但 `5144` 只是外层页面。实际文件列表和下载服务在 `5143`：

- 目录 API：`http://rec.darkpy.cn:5143/fileapi.php?url=<目录>`
- 文件服务：`http://rec.darkpy.cn:5143/<整条相对路径的 URL 编码>`
- 备用文件域名：`http://ds.darkpy.cn:5143/`

### 不依赖网页导航状态

外层页面使用 hash 路由，`#?list=list` 只表示“文件列表”，不保存当前主播目录。目录内容实际加载在 iframe 中，所以浏览器后退、刷新或重新选中标签页时，可能回到上一层或首页。不要把当前地址栏当作目录的稳定链接。

人工浏览可用于确认主播和标题，批量发现文件时应直接调用目录 API。API 返回 JSON 数组，常用字段是：

| 字段 | 含义 |
| --- | --- |
| `name` | 文件或目录名 |
| `dir` | `1` 表示目录，`0` 表示文件 |
| `size` | 文件字节数 |
| `time` | Unix 修改时间，通常接近文件写完时间 |

查询岁己普通目录：

```powershell
$api = "http://rec.darkpy.cn:5143/fileapi.php?url="
$directory = "./file/25788785-岁己SUI"
$entries = Invoke-RestMethod `
  -Uri ($api + [uri]::EscapeDataString($directory)) `
  -TimeoutSec 30

$entries |
  Where-Object { $_.name -match "20260728|20260729-00" } |
  Select-Object name, size, time, dir
```

跨零点直播必须把次日 `00` 点文件纳入筛选。标题相同只能用来聚类，最终顺序仍以文件名开头的录制时间和媒体时长为准。

### 普通目录和补档目录都要查

darkpy 至少有两类根目录：

```text
./file
./file/0缺少录播或者HLS流看这里0
```

普通目录通常形如：

```text
./file/25788785-岁己SUI
```

补档目录的命名可能不同，房间号和主播名之间带空格：

```text
./file/0缺少录播或者HLS流看这里0/25788785 - 岁己SUI
```

本次普通目录只列出 `22:26` 之后的 4 段 FLV/XML；`19:54` 开始的 MP4/XML 在补档目录中。如果只看用户打开的普通主播目录，就会误判整场只有约 2 小时。

常规查找顺序：

1. 查主播普通目录。
2. 查“缺少录播或者 HLS 流”根目录下的同主播目录。
3. 仍缺段时，枚举两个根目录的一级子目录，按日期、房间号和标题扫描。
4. 日期筛选覆盖跨零点文件。
5. 同时收集视频和同名 XML，不要只下载视频。

不要只看网页可见条目。站点设置可以隐藏小于 1 MB 的视频、小于 5 KB 的 XML，目录 API 才适合做完整清单。极小文件通常是启动失败或空壳分段，需要用 `ffprobe` 判断，不能仅凭扩展名纳入合并。

目录中还可能同时出现 `.m3u8`、`.m4s`、`.m4s.meta` 和 `.mp4`。优先检查已完成的 MP4；只有 MP4 缺失或损坏时，才尝试从 HLS/M4S 恢复。

### 生成下载直链

文件直链不是 `/file/主播/文件名` 这种普通路径。必须把从 `file/` 开始的整条相对路径一次性 URL 编码，让目录分隔符 `/` 也变成 `%2F`：

```powershell
$relativePath = "file/25788785-岁己SUI/20260728-222623-876-和你这个猪过周二！.flv"
$encodedPath = [uri]::EscapeDataString($relativePath)
$downloadUrl = "http://rec.darkpy.cn:5143/$encodedPath"
```

不要对每一段分别编码后再用 `/` 拼接；该服务会把两种形式当作不同路由，错误形式通常返回 404。`rec.darkpy.cn` 和 `ds.darkpy.cn` 可分别做 HEAD 探测，选择能返回预期文件大小的线路。

### 大文件下载与续传

下载前先做 HEAD：

```powershell
$head = Invoke-WebRequest -Uri $downloadUrl -Method Head -TimeoutSec 30
$head.Headers."Content-Length"
$head.Headers."Accept-Ranges"
```

本次两个文件域名都返回 `Accept-Ranges: bytes`。数 GB 文件不建议依赖浏览器连续下载：浏览器可能拦截批量下载，失败后也不方便判断文件是否完整。

单连接可用 `curl.exe` 断点续传：

```powershell
$curl = Get-Command curl.exe
$curlArgs = @(
  "--fail"
  "--location"
  "--retry", "6"
  "--retry-all-errors"
  "--continue-at", "-"
  "--output", "D:\path\recording.mp4"
  $downloadUrl
)
& $curl.Source @curlArgs
if ($LASTEXITCODE -ne 0) {
  throw "darkpy download failed: $LASTEXITCODE"
}
```

单连接过慢或不稳定时，可以在 `tmp/` 或 `local-scripts/one-off-scripts/` 写一次性 Range 下载器。本次有效策略是：

- 以 16 MiB 分块。
- 8 个并发 worker。
- 每块最多重试 6 次。
- 每块必须返回 `206`。
- 严格校验 `Content-Range` 和分块字节数。
- 已完成且大小正确的分块可跳过，实现任务级续传。
- 顺序组装到临时文件，最终大小等于 API/HEAD 的 `Content-Length` 后再改名。

不能只判断 HTTP 请求成功。服务器若忽略 Range 返回 `200`，每个 worker 都会下载整文件；必须拒绝这种响应。

### 下载后核验

每个文件至少核对三层：

1. 本地字节数等于 API 的 `size` 和 HEAD 的 `Content-Length`。
2. `ffprobe` 能读取媒体轨和时长，XML 能正常解析。
3. `ffmpeg -v error -i <file> -f null -` 能扫描到结尾。

先把 API 清单保存成恢复记录，再开始合并。这样即使站点文件后来被移动或删除，也能解释成品使用了哪些源文件、当时声明的大小以及缺失了哪些时段。

## 下载 P1/P2

项目已有下载工具：`src/scripts/bilibili_download.py`。它会从 `config/secret.json` 导出 B 站 Cookie 给 `yt-dlp` 使用。

完整下载每个分 P：

```powershell
python src\scripts\bilibili_download.py `
  --url "https://www.bilibili.com/video/BVxxxx/?p=1" `
  --output "$work\p1.mp4"

python src\scripts\bilibili_download.py `
  --url "https://www.bilibili.com/video/BVxxxx/?p=2" `
  --output "$work\p2.mp4"
```

只补片段时可以加 `--start` / `--end`，但 P1/P2 合并补整场时尽量下完整分 P。

## 合并 P1/P2

优先无损 concat。确认两个分 P 编码一致时用：

```powershell
$list = "$work\concat.txt"
@"
file 'p1.mp4'
file 'p2.mp4'
"@ | Set-Content -LiteralPath $list -Encoding ASCII

ffmpeg -hide_banner -y -f concat -safe 0 -i $list -c copy "$work\merged.mp4"
```

如果 concat 报编码/时间基不一致，改用重编码：

```powershell
ffmpeg -hide_banner -y -f concat -safe 0 -i "$work\concat.txt" `
  -c:v libx264 -preset fast -crf 20 -c:a aac -b:a 192k `
  "$work\merged.mp4"
```

合并后先看时长：

```powershell
ffprobe -hide_banner -show_entries format=duration -of default=nw=1:nk=1 "$work\merged.mp4"
```

混合 MP4/FLV、不同时间基或时间戳异常时，先把各段无损转为 MPEG-TS，再合并。不要仅因为 `ffmpeg -c copy` 生成了文件就认为成功；必须扫描到文件结尾：

```powershell
ffmpeg -v error -i "$work\merged.mp4" -f null -
```

最终至少确认：

- `ffprobe` 能读到预期时长。
- 有一条视频轨和一条音频轨。
- 分辨率、帧率、采样率符合预期。
- 全文件扫描无解码错误。
- 在每个拼接点前后抽查画面和声音。

## 多段 XML 弹幕

XML 不能直接文本拼接。每条 `<d>` 的 `p` 属性第一个字段是相对本段的秒数，必须通过分段的墙钟起点映射到合并视频时间线：

1. 计算弹幕墙钟时间：`segment.wallStart + p[0]`。
2. 判断该时间落在哪个保留视频区间。
3. 映射为输出时间：该保留区间在成品里的起点加区间内偏移。
4. 更新 `p[0]`，保留其它字段，并按新时间排序。
5. 去重后生成一个结构完整的 XML。

如果成品压掉了中间缺口，缺口内的弹幕不能平移到后续画面，必须剔除。否则弹幕热度、AI 上下文和自动切片都会在错误画面上触发。

生成后记录：

- 输入 XML 数量和弹幕总数。
- 输出保留条数。
- 因缺口、越界或重复被剔除的条数。
- 第一条和最后一条弹幕时间。

项目的 `FileMerger` 已包含 XML 解析和重写逻辑。一次性恢复脚本可以复用同样的时间映射原则，但不要把带固定日期、房间号和路径的脚本提交到 `src/scripts`。

## 字幕策略

优先推荐直接对 `merged.mp4` 跑项目 ASR，让时间轴天然连续：

```powershell
node src\scripts\enhanced_auto_summary.js "$work\merged.mp4"
```

如果 B 站 AI 字幕质量明显更好，可以合并 SRT 后再跑。注意 P2 字幕必须整体加上 P1 时长，否则后续高亮时间轴会错。手工合并 SRT 容易出错，所以除非必要，不作为首选。

## 跑主流程

无弹幕 XML 时：

```powershell
node src\scripts\enhanced_auto_summary.js "$work\merged.mp4"
```

有可用 XML 时：

```powershell
node src\scripts\enhanced_auto_summary.js "$work\merged.mp4" "$work\merged.xml"
```

已有可信 SRT 时：

```powershell
node src\scripts\enhanced_auto_summary.js "$work\merged.srt" "$work\merged.xml"
```

跑完检查这些文件：

- `merged.srt`
- `merged.asr_speakers.json`
- `merged_AI_HIGHLIGHT.txt`
- `merged_晚安回复.md`
- `merged_COMIC_SCRIPT.txt`
- `merged_COMIC_FACTORY.png`
- `merged_COMIC_FACTORY_META.json`

重点看 `*_COMIC_FACTORY_META.json`，确认生图状态是 success；失败时先看 provider route attempts，不要直接重复发评论。

## 自动切片

主流程生成可信 SRT 后再跑本主播自动切片：

```powershell
node src\scripts\own_stream_clipper.js `
  --media "$work\merged.mp4" `
  --srt "$work\merged.srt" `
  --xml "$work\merged.xml"
```

要求 `ownStreamClips.enabled` 已启用。输出目录默认是 `own_stream_fun_clips`，完成后检查：

- `PLAN.json` 和 `REVIEW.md` 存在。
- 每条切片都有 MP4、SRT、JSON 和封面。
- 每个 MP4 非零，且同时包含音频和视频轨。
- 切片总数与 `REVIEW.md` 一致。
- `REVIEW.md` 中有上传短 ID。

ASR 可能把电影、游戏或连麦里的对白误识别为其它主播。发布前要同时检查 `asr_speakers.json`、`appearedStreamerIds`、`extraAppearedStreamerIds` 和切片文案，不能只看一处字段。

## 正式目录与上传注册表

最佳顺序是先确定正式目录，再运行自动切片和上传注册。这样生成的 `REVIEW.md`、媒体路径和短 ID 从一开始就是最终路径。

如果必须在恢复目录里生成后再迁移，移动完成后要结构化更新并检查：

- batch 的 `reviewPath`、`statePath`。
- 每个 clip 的 `reviewPath`、`statePath`、`mediaPath`、`coverPath`。
- 所有路径都位于正式目录且文件真实存在。

注册表位于：

```text
data/runtime/clip_upload_registry.json
```

不要用字符串搜索判断 Windows JSON 路径是否正确，JSON 里的反斜杠会被转义。应解析 JSON 后按短 ID 逐项检查；迁移时保留原短 ID，不要重新导入形成重复批次。

## 手动补晚安回复

生产服务默认是 PM2 的 `danmaku-webhook`，端口 `12523`；`12522` 是开发端口。先检查：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:12523/health"
```

任务持久化在 `data/delayed_reply_tasks.json` 的 `tasks` 数组里。POST 前按 `roomId` 和 `goodnightTextPath` 查找同场任务，避免重复评论。

```powershell
$body = @{
  roomId = "25788785"
  goodnightTextPath = "D:\path\merged_晚安回复.md"
  comicImagePath = "D:\path\merged_COMIC_FACTORY.png"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://127.0.0.1:12523/api/delayed-reply" `
  -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

手动任务没有 `liveEndTime` 时，服务可能在创建后立即找到最新晚安动态并发布，不一定等待配置的延迟时间。因此 POST 是实际外部发布动作，不能当作只入队。提交后应按返回的 `taskId` 核对：

- `status` 是 `completed`，或明确处于预期等待状态。
- `goodnightTextPath`、`comicImagePath` 是正式路径。
- `replyId`、`repliedDynamicId` 已记录。
- `error` 为空。

## 补发/补图前检查

发出去之前至少确认：

```powershell
Get-Content "$work\merged_晚安回复.md" -Raw -Encoding UTF8
Get-Content "$work\merged_COMIC_SCRIPT.txt" -Raw -Encoding UTF8
Get-Content "$work\merged.asr_speakers.json" -Raw -Encoding UTF8
```

多人联动尤其要检查：

- `asr_speakers.json` 的 `extraAppearedStreamerIds` 是否合理。
- 漫画脚本里是否把不该出现的人写进去了。
- 漫画输入参考图日志是否包含应出现角色。
- 如果 P1/P2 合并后缺人，先查 ASR speaker reference 配置，不要先改漫画 prompt。

## 发布经验

- 如果原评论还没人点赞，优先重新生成漫画和脚本后替换/重发同一条晚安文本，减少错误图扩散。
- 如果只是补图，沿用原晚安文本，重新生成漫画图后作为补图回复。
- 发送企微时附 B 站 opus/reply 链接，不要只发本地路径。
- 上传状态、下载中间文件、concat 列表等临时产物不要提交；需要保留时移到 `C:\tmp` 或 `uploads/recovery-*`。

## 2026-07-28 岁己恢复案例

直播标题：`和你这个猪过周二！`，房间号 `25788785`。

### 覆盖结论

完整直播墙钟跨度约为 `19:54-00:46`，但可用视频只有：

| 来源 | 覆盖时间 | 时长 |
| --- | --- | --- |
| darkpy 补档目录 MP4 | `19:54-21:21` | `1:26:56` |
| darkpy 普通目录 4 个 FLV | `22:26-00:46` | `2:20:02` |

缺失区间为 `21:21:34-22:26:23`，约 `1:04:49`。扫描录播站其它目录、本机 BililiveRecorder 残留和 B 站回放后仍未找到该段，因此最终产物命名为 `_best_effort`，时长 `3:46:58.510`。先前约 2 小时的结果只包含后半场，不能视为恢复完成。

### 弹幕与处理结果

- XML 按墙钟时间映射到压缩后的成品时间线。
- 成品保留 6,778 条有效弹幕；缺口内 2,449 条弹幕被剔除。
- 主视频为 1080p60 H.264 + AAC 48 kHz，全文件扫描通过。
- 已生成 ASR/SRT、晚安回复、漫画和 14 条自动切片。
- 切片短 ID 为 `557-570`，迁移后 56 个注册路径字段均验证存在。
- 手动晚安任务成功完成，文字和漫画都发布到了当晚动态。

### 本次最重要的经验

1. 直播墙钟跨度和可恢复媒体时长是两个不同指标，必须先做区间并集。
2. darkpy 普通目录和“缺少录播或者 HLS 流”补档目录必须同时扫描，网页显示的总时长不能替代目录 API 和逐文件探测。
3. 有弹幕不代表对应视频存在；缺口弹幕必须删除，不能硬贴到后半场。
4. `best_effort` 是数据完整性声明，不应为了看起来像整场而填黑屏或伪造连续时间。
5. 自动切片注册发生在生成阶段，临时目录生成后再移动会留下旧绝对路径。
6. 手动晚安接口可能立即对外评论，查重、文件检查和漫画人工检查必须在 POST 之前完成。
7. 临时恢复目录要等正式文件、注册表和回复任务全部验证后再清理。

## 常见坑

- 只处理 P1 或 P2：总结会缺上下文，漫画也更容易少角色。
- P1/P2 分开跑：会生成两套晚安和两张图，后续人工合并成本更高。
- 直接相加文件时长：会忽略重叠或缺口，得出错误的整场时长。
- 直接拼 XML：分段相对时间会重叠，弹幕和切片时间轴全部错位。
- 先注册切片再移动目录：短 ID 仍会指向已删除的恢复目录。
- 未查任务就 POST 晚安接口：服务可能立即发布重复评论。
- 复用旧 SRT：主流程可能跳过 ASR，导致旧 speaker sidecar 继续污染多参考图。
- 只改配置不重启常驻服务：PM2 里的 `danmaku-webhook` 不会自动读到新逻辑。
- Python 漫画侧配置要能读到需要的顶层配置；改了配置结构后要用实际文件跑一次 `resolve_extra_appeared_streamers` 验证。

重启服务：

```powershell
pm2 restart danmaku-webhook
```
