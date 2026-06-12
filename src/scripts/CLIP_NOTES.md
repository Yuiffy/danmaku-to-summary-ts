# 视频剪辑经验 & 注意事项

## 0. B站上传防重复（关键！）

- **遇到上传失败不要急着重试！** 先确认是否其实已经成功了（B站可能返回错误但实际投稿成功）
- 批量上传前先用 `check_uploaded2.py` 查已有视频，避免重复
- 每次上传后记录 BV号，失败时先检查再重试
- **教训：** 2026-06-10 因为限流206错误盲目重试，导致9个重复视频需要手动删除
- **频控真相：** B站限制是「最多同时审核10个」，不是上传频率限制。不用间隔，一口气传都行
- **重复根因：** B站返回206错误时，视频可能已经成功投稿了。上传脚本本身没问题（没有整稿重试），是批量脚本没先查已有就重试
- **防护措施：** 批量上传前先查B站已有视频列表，跳过已存在的；报错后先查再决定是否重试
- 切片已经由 own_stream_clipper 自动压制好 mp4 + srt，上传时不需要再裁剪/编码
- 投稿时一次性设好 title/tags/desc，不需要后续编辑（用 update_desc_direct.py 可改）

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
- clip_sui_shiori.js 里的 FontSize=52 是给那个脚本特定用的，不适用于直接 ffmpeg 烧录

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
