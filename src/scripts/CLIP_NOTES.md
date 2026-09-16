# 视频剪辑经验 & 注意事项

## ⚠️ 手动切片必查清单（每次都要过一遍！）

| # | 检查项 | 说明 |
|---|--------|------|
| 1 | **封面必须压制大字** | 用 `cover_generator.py` 或 `make_clip.py --cover-text`，不能只截裸帧！|
| 2 | **简介必须有时间信息** | 包含「切片时间：北京时间起-止（直播开始后第X分钟）」|
| 3 | **字幕样式** | SRT + `force_style='FontSize=28,FontName=Microsoft YaHei,Bold=1,Outline=2'` |
| 4 | **标题前缀** | 【小岁】，"岁己"→"小岁" |
| 5 | **Tag** | 小岁, 虚拟主播, 直播切片, 岁AI切片 |

**一键流程：用 `make_clip.py`（自动完成以上全部）**
```bash
python make_clip.py \
  --flv "源视频.flv" --srt "源字幕.srt" \
  --start 635 --end 686 \
  --title "【小岁】标题" \
  --cover-text "封面大字" \
  --cover-time 14 \
  --source-desc "岁己SUI 直播《xxx》2026-06-17" \
  --live-start "15:03:05" \
  --reason "切片内容一句话" \
  --upload
```

## 封面更新（单独换封面/简介）

- **统一用 `update_cover.py`**，不要手动调 `bilibili_api.VideoEditor` 的 `_change_cover()`（有 bug：`upload_cover()` 返回 str 但它当 dict 读）
- 用法：
  ```bash
  python update_cover.py --bvid BV1ytLR6vEtQ --cover "封面图片.jpg"
  ```
- 也可以直接传已上传的 URL：`--cover-url "https://archive.biliimg.com/..."`
- **URL 规范化坑**：`upload_cover()` 返回的 `hive.biliimg.com` 必须替换成 `archive.biliimg.com`，否则 edit 接口判为外链报 `21001 参数错误`
- edit 提交时必须补齐 `videos` 列表（从 `archive/view` 拿），缺了也会 `21001`
- 简介/标题/tag 更新走通用脚本 `scripts/edit_video_meta.py`，不要再把具体 BV/文案写进 `src/scripts`。

---

## 0. B站上传防重复（关键！血的教训！）

### ⛔ 铁律：上传报错 ≠ 上传失败！

B站上传接口可能返回 406/206 等错误码，但**视频实际已经成功投稿**。盲目重试 = 制造重复稿件！

### 上传前必做
1. **查已有稿件**：用 `fetch_archive(cookie, bvid)` 或 member API 确认是否已存在
2. **记录每次上传的 BV 号**，失败的也要记录
3. **批量上传前先查一遍已有列表**，跳过已存在的

### 上传失败后的处理流程
1. ❌ **不要立即重试上传！**
2. ✅ 先等 1-2 分钟，然后查稿件列表确认是否其实已成功
3. ✅ 如果确实没上传成功，再重试
4. ✅ 重试时传入已有的 BV 号列表作为跳过清单

### 封面文件名防冲突
- 不同直播场次共用 `own_stream_fun_clips` 目录时，封面文件名会冲突
- **必须用不同后缀**：如 `cover_02_sui.jpg`（温柔煮死你）vs `cover_02.jpg`（空洞骑士）
- CoverGenerator 遇到已存在文件会 [SKIP]，导致用错封面

### cron 重试任务的防重复
- cron 重试上传时**必须先查已有稿件**，不能盲目重传
- 在 payload 里带上「已成功的 BV 号列表」作为跳过清单
- 重试脚本要 check-before-upload，不是 blind-retry

### 历史教训
- **2026-06-10**：206 错误盲目重试 → 9个重复视频
- **2026-06-18**：406 错误盲目重试 + cron 自动重试 → 又传了 6 个重复（共 13 个需删除）
  - 根因：B站返回 406 但实际投稿成功，脚本误判失败后重试，cron 任务又自动重传一遍
  - 教训：**406 是假报错！上传可能已成功！必须先查再决定是否重试！**
- **2026-06-19 03:00**：又重复了！`bilibili_api.VideoUploader.start()` 内部行为导致同一视频产生两个稿件
  - 现象：串行上传前6个都成功了，但返回的 BV 号（state=-50）跟实际公开的 BV 号不同
  - 根因：`bilibili_api` 库可能内部做了两次提交，返回的 BV 号是第一次尝试的（被审核退回），实际成功的是第二次
  - 教训：不能信任返回的 BV 号是否代表最终稿件状态，必须用搜索 API 独立确认
  - 修复：落地了 `batch_upload.py`，上传前搜索查重 + 406后搜索确认 + 状态持久化

### 频控真相（2026-06-19 更新）
- B站限制是「最多同时审核10个」，不是上传频率限制
- 406/206 错误时视频可能已经在审核队列里了
- **连续上传超过 ~6 个后就容易触发 406 频控**
- **406 时 `bilibili_api` 库内部可能已经提交了，导致重复稿件**
- **解决方案：批量上传分批，每批不超过 6 个，批次间隔 5-10 分钟**
- **或者直接用 `--delay 90`（90秒间隔），18个视频全部成功零406**
- 推荐：`--delay 60` 以上为安全线，`--delay 15` 必触发频控

### 工具脚本
- **批量上传统一用 `batch_upload.py`（防重复版）**
  ```bash
  python src/scripts/batch_upload.py \
    --manifest <UPLOAD_MANIFEST.json路径> \
    --source "岁己SUI 直播《xxx》2026-06-18" \
    --prefix "【小岁】" \
    --tags "小岁,虚拟主播,直播切片,岁AI切片" \
    --delay 30
  ```
  - 自动从结构化 JSON manifest 读取切片列表（旧 REVIEW.md 仍兼容）
  - 上传前搜索 API 查重
  - 406 后自动搜索确认是否已成功
  - 状态持久化到 `upload_state.json`
  - 支持 `--skip 1,2,3` / `--only 5,6,7` / `--dry-run`
- 单个上传仍可用 `bilibili_upload.py`
- 切片已经由 own_stream_clipper 自动压制好 mp4 + srt，上传时不需要再裁剪/编码
- 投稿时一次性设好 title/tags/desc，不需要后续编辑；确实要改时用 `scripts/edit_video_meta.py`。

## 1. 字幕时间轴偏移问题（关键！）

### 问题描述
使用 `ffmpeg -ss` 裁剪视频片段后，如果直接用**原始SRT/ASS的字幕文件**烧录字幕，字幕不会显示。

### 原因
原始字幕文件的时间戳是基于完整视频的（如 `01:04:34`），但裁剪后的视频时间轴从 `00:00:00` 开始。`subtitles` 滤镜用的是视频自身的时间轴，所以 `01:04:34` 的字幕永远不会在一段56秒的视频里出现。

### 解决方案
**先裁剪字幕文件，重置时间轴，再烧录。**

用 `trim_srt.py` 脚本（直接输出带项目标准样式的 ASS）：
```bash
python trim_srt.py <原始SRT路径> <起始秒数> <结束秒数> <输出ASS路径>
```

然后：
```bash
ffmpeg -ss "01:04:34.500" -i source.flv -t "00:00:56.000" \
  -vf "subtitles='clip_styled.ass'" \
  -c:v libx264 -preset fast -crf 20 -c:a aac -b:a 128k output.mp4
```

## 2. 字幕样式（必须用项目标准！）

### 问题
直接用 ffmpeg 转换 SRT→ASS 生成的字幕**字号极小**（默认约24px），看不清。必须使用项目统一的大字幕样式。

### 正确做法：SRT + force_style（跟 topic_clipper.js 一致）

**必须用 SRT 文件 + force_style 参数烧录**，不要用 ASS 文件！

```bash
# 1. 先用 trim_srt.py 裁剪 SRT 并重置时间轴
python trim_srt.py <原始SRT> <起始秒> <结束秒> <输出SRT>

# 2. 用 SRT + force_style 烧录
ffmpeg -ss "01:04:34" -i source.flv -t "00:00:56" \
  -vf "subtitles='clip.srt':force_style='FontSize=28,FontName=Microsoft YaHei,Bold=1,Outline=2'" \
  -c:v libx264 -preset fast -crf 20 -c:a aac -b:a 128k output.mp4
```

force_style 参数：
- `FontSize=28`（按实际像素渲染，足够大）
- `FontName=Microsoft YaHei`（微软雅黑）
- `Bold=1`（粗体）
- `Outline=2`（描边）

### ❌ 踩坑记录
- **不要用 ASS 文件烧录**！ASS 里的 FontSize=52 在 PlayResX=1920 下实际渲染很小
- **不要用 `ffmpeg -i xxx.srt -f ass xxx.ass` 转换**，生成的样式字号极小
- **不要用 BorderStyle=3**，会有黑色底框。BorderStyle=1 是纯描边无底框
- 历史 ASS 专用脚本里的 FontSize=52 是按 PlayResX/PlayResY 设计的，不适用于直接 ffmpeg 烧录

## 3. PowerShell 路径转义问题

### 问题描述
PowerShell 会吞掉 `subtitles` 滤镜路径中的反斜杠 `\`，导致 ffmpeg 报错 `Unable to parse option value`。

### 解决方案
- 方法1：转义反斜杠 `subtitles='C\:\\tmp\\sub.ass'`
- 方法2：用短路径（`Scripting.FileSystemObject.ShortPath`）
- 方法3：所有中间文件放 `C:\tmp\` 用ASCII文件名

## 4. B站投稿相关

### Tag 编辑
- `bilibili_api` 的 `delete_tag` / `add_tag` 接口经常返回 `-403`，即使 cookie 有效
- 建议手动在网页端改 tag，或用更新后的 cookie 重试

### 上传脚本
```bash
python bilibili_upload.py <视频路径> \
  --title "标题" \
  --desc "简介" \
  --tags "虚拟主播,直播切片,岁AI切片" \
  --source-desc "来源描述"
```

### 岁己切片 Tag 规则
岁己直播间（25788785）的切片投稿 tag：`小岁, 虚拟主播, 直播切片, 岁AI切片`
- 不使用"岁己"、"岁己SUI"等直接可搜索的 tag
- 其他直播间正常使用 `[streamerName, '虚拟主播', '直播切片']`
- 配置在 `own_stream_clipper.js` 的 tags 字段

## 5. 切片选段经验

- 从有趣内容的**开头铺垫**开始切，不要从 punchline 开始
- 结尾包含完整反应和收尾，停在新话题前
- 留 1-2 秒静音缓冲
- 用 SRT 字幕精确定位起止时间，比 AI highlight 更准确
- 注意敏感内容（如EVA等版权相关）需要剪掉

## 8. 切片简介模板

```
直播切片
<一句话概括切片内容>

来源：<主播名> 直播《<直播标题>》<日期>
切片时间：<北京时间起> - <北京时间止>（直播开始后第X分钟）
切片弹幕密度：<X.X>条/分 | 全场平均：<X.X>条/分
```

- 时间用北京时间（从文件名解析：如 `20260608-195040` = 20:50:40 开播）
- 弹幕密度从录播XML弹幕文件统计
- 示例：`切片时间：20:55:14 - 20:56:10（直播开始后第64分钟）`

## 6.5 切片重新裁剪+替换流程（2026-06-19 新增经验）

### 场景
用户看了已上传的切片，觉得切了太多多余内容，需要重新裁剪并替换B站视频。

### 标准流程
1. **确认裁剪范围**：用户给出「从 X:XX 切到 Y:YY」
2. **从已有切片mp4裁剪**（不从源flv切，因为已有切片已经过编码）：
   ```bash
   ffmpeg -y -ss 00:01:50 -to 00:03:05 -i clip_19.mp4 -c copy clip_19_v2.mp4
   ```
3. **裁剪SRT并重置时间轴**（用 CUT_START/CUT_END 裁剪+偏移）：
   - 过滤掉范围外的字幕条目
   - 新时间戳 = 原时间戳 - CUT_START
4. **烧录字幕**（必须在切片目录下运行，避免路径问题）：
   ```bash
   cd <clips_dir>
   ffmpeg -y -i clip_19_v2.mp4 \
     -vf "subtitles=clip_19_v2.srt:force_style='FontSize=28,FontName=Microsoft YaHei,Bold=1,Outline=2'" \
     -c:a copy clip_19_final.mp4
   ```
5. **替换B站视频**：`python replace_video.py --bvid BVxxx --video clip_19_final.mp4`
6. **更新封面**：`python update_cover.py --bvid BVxxx --cover cover_19_sui.jpg`

### 教训
- 用户说「从1:50切到3:05」是指**已有切片内的时间**，不是直播源的时间
- 裁剪后SRT必须同步偏移，否则字幕对不上
- ffmpeg subtitles 滤镜的路径不要含中文/空格，在切片目录下cd后用相对路径最安全

## 6. 视频替换（不改BV号）

### 用法
```bash
python replace_video.py --bvid BV1xxxx --video <新视频路径>
```

### 流程
1. `VideoEditor._fetch_configs` 获取原稿件信息（不需要视频公开可见）
2. `VideoUploader._upload_page` 上传新视频文件拿到 filename
3. `VideoEditor._submit` 提交替换，保留标题/描述/tag/封面不变

### 注意
- 只替换单P视频的第一个分P
- 原视频会被覆盖，审核通过后生效
- 不需要视频已公开，只要在投稿管理里能找到就行

## 7. 时间转换速查

| 时间 | 秒数 |
|------|------|
| 01:00:00 | 3600 |
| 01:04:34 | 3874 |
| 01:05:30 | 3930 |

公式：`h*3600 + m*60 + s`（含小数毫秒除以1000）
