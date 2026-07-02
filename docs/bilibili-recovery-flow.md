# B站视频补下载回填流程

用于录播缺失、录播坏档、或需要从已投稿/公开视频补跑晚安总结和漫画的场景。优先把 P1/P2 合并成一条完整媒体再处理，避免分段分别生成导致上下文断裂。

## 适用判断

- 原始 DDTV 录播不存在、损坏，或缺少可用 SRT/XML。
- B 站已有完整视频或分 P 视频可下载。
- 目标是补走项目主流程：ASR/SRT -> AI_HIGHLIGHT -> 晚安文本 -> 漫画脚本 -> 漫画图 -> 评论/补图。

不建议把 P1/P2 分开各跑一次，除非它们本来就是两场独立直播。联动、长杂谈、游戏流程类内容要合并后处理。

## 工作目录

把临时产物放到 `uploads/` 或 `tmp/` 下，避免混进正式录播目录和 git diff。

```powershell
$work = "uploads\recovery-<roomId>-<YYYYMMDD>-<slug>"
New-Item -ItemType Directory -Force -Path $work | Out-Null
```

如果后面要保留成正式产物，再把最终 `*_AI_HIGHLIGHT.txt`、`*_晚安回复.md`、`*_COMIC_*` 移到目标录播目录。

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

## 常见坑

- 只处理 P1 或 P2：总结会缺上下文，漫画也更容易少角色。
- P1/P2 分开跑：会生成两套晚安和两张图，后续人工合并成本更高。
- 复用旧 SRT：主流程可能跳过 ASR，导致旧 speaker sidecar 继续污染多参考图。
- 只改配置不重启常驻服务：PM2 里的 `danmaku-webhook` 不会自动读到新逻辑。
- Python 漫画侧配置要能读到需要的顶层配置；改了配置结构后要用实际文件跑一次 `resolve_extra_appeared_streamers` 验证。

重启服务：

```powershell
pm2 restart danmaku-webhook
```

