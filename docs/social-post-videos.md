# 微博截图转视频

`npm run clips:post` 将已核实的本地原帖截图制作成 1920×1080 / 30 fps 的短视频。
输入可以是完整原帖，或明确分隔的原帖与评论截图拼图；评论保留自己的作者和日期，
不能当成主播原话。截图由操作者在正常登录的浏览器中截取；本命令不登录、抓取网页、
保存账号凭证、模拟主播声音或推断直播出处。

决策/布局验证属于 `workflows/clipping/socialPost`；本地图片/文件/进程适配在
`tools/clipping/socialPostRuntime` 和 `socialPost`。FFmpeg 复用现有资源调度、受控
执行和配置编码器，默认 NVENC，失败后使用 CPU 编码。上传继续使用既有注册表和单实例
worker，`social_post_review.py` 只校验来源与实际成片绑定。

## 本地渲染

在忽略的 `temp/<date>-<task>/` 保存实际计划，路径相对该计划文件解析：

```json
{
  "version": 1,
  "source": {
    "image": "post.png",
    "url": "https://weibo.com/detail/123",
    "captureUrl": "https://weibo.com/detail/123",
    "author": "原帖作者",
    "publishedAt": "2026-01-01T12:00:00+08:00",
    "text": "核实过的原帖文字",
    "captureLabel": "微博原帖截图"
  },
  "copy": {
    "title": "经过核实的标题",
    "description": "简洁内容说明",
    "tags": ["微博", "虚拟主播"]
  },
  "scenes": [
    { "seconds": 6, "heading": "先展示问题", "visibleHeight": 200 },
    { "seconds": 8, "heading": "再揭示完整原帖" }
  ],
  "music": { "path": "music.wav", "credit": "实际作者和来源或原创说明", "gainDb": -12 }
}
```

`visibleHeight` 是原截图像素坐标，只能遮住下方文字作分段揭示。遮挡区以浅色底、虚线和
“还有一段，稍后揭晓”提示明确标出，让观众知道正文未展示完。揭晓后的完整原帖单独设置
足够停留时间，不随评论页机械提速。最终场景必须完整显示
截图；不裁切或变形。过长截图会拒绝制作，需先拆成可读素材。每场 2–60 秒、1–32 场，
总长最多 180 秒。标题至多 24 字；配乐可省略，此时保留静音音轨。自带配乐须给出
实际署名，不能填写未经核实的授权声明。`source.comments` 可记录最多十条真实评论，
每条有独立的 `author`、`text`、`publishedAt`。评论拼图不能伪造相邻关系或回复关系。

多屏评论放在 `source.pages`，最多三十页；每页包含本地 `image`、显示来源说明的 `label`
和本页 `comments`（各自的作者、原文和页面显示时间）。`scenes[].page` 用 1 开始的页码
引用，0 或省略表示原帖；评论页完整显示，不能使用 `visibleHeight`。原帖至少有一场完整
显示，随后可按多页评论收尾。每页可用清楚分隔的多条原始评论截图拼图，保留各自边界、
署名和时间。时间只显示到分钟时如实记录分钟精度，不补写未知秒数。所有页图均复制到
输出并参与审核哈希；评论页数、顺序、停留时间和公开说明更改后重新渲染审核。

```powershell
npm run clips:post -- render --plan temp/<date>-<task>/post.json --output D:/clips/new-post-revision
```

输出目录必须尚不存在。保留来源截图/配乐的独立副本、计划、逐场 PNG/MP4、视频、封面、
`REVIEW.md` 和待审核 `UPLOAD_MANIFEST.json`。技术检查包括尺寸、时长、音轨和完整解码；
这不代表完成了来源和视听审核。命令不修改直播队列、不执行 ASR、不调用模型、不上传。

## 审核与投稿

对话中协作制作的稿件先向用户展示预览，等用户明确确认定稿、可以上传后再注册排队或
替换线上媒体。一般性的“做来发”以及代理自己的技术/画面检查，不代表用户看过并确认
当前成片；只有用户明确要求跳过预览时才省略这一步。用户继续提修改意见时，新版本仍
留在本地待审，不自动上传或替换。代理的 `review` 记录不能代替用户定稿确认。

先打开原帖、成片和封面，检查作者日期、完整文字及转折、评论归属、手机可读性、揭示
节奏、音量、标题和简介。`review` 只记录操作者已实际完成的审核，不自动授权或排队。
用真实审核者身份填写 `--reviewer`，不能把代理审核写成人工审核。

```powershell
npm run clips:post -- review --manifest D:/clips/new-post-revision/UPLOAD_MANIFEST.json --reviewer operator --note "实际完成的来源、画面、声音、文案检查"
python src/scripts/clip_upload_registry.py import-json --manifest D:/clips/new-post-revision/UPLOAD_MANIFEST.json
```

只有用户已经授权投稿时，才用返回的数字 ID 执行既有 `enqueue --ids <ID>`。
注册不是上传。`socialReviewRequired` 随注册记录保留，导入刷新不能去掉它。排队与提交前
重新验证截图、配乐、成片、封面、计划、时间轴和公开文案；更改后应渲染新的版本再审核。
待审稿件不能直接导入为已审稿；`import-json --include-pending` 只预留 ID。
同一个微博来源 URL 的已发表或已排队视频会阻止重复投稿，改标题、时长或输出路径不会
绕过这个检查。计划应使用原帖的规范 URL，不用带追踪参数的分享链接。

`publicationKind=social_post` 的简介直接使用审核后的微博来源说明，不附加虚构的
“直播开始时间”或“切片时间”。没有直播源文件或字幕是正常情况，不创建假的 SRT。
发布此支持代码后，既有 Python worker 需按架构指南在空闲时重启以载入新审核模块；
不得用绕过旧审核门的方式让旧进程接收新类型稿件。

已发表的同一微博如需调整停留时间或揭示提示，渲染到新目录并重新审核；配乐保持原速。
正文揭晓可单独延长，评论页可以保持快节奏，无须把所有场景机械地同比例提速。
用户看过新预览并明确授权更新原稿后，使用已有 ID/BV 替换：

```powershell
python src/scripts/clip_upload_registry.py replace-media --id 123 --expected-bvid BVexample --manifest D:/clips/faster-revision/UPLOAD_MANIFEST.json --note "用户要求加快原稿节奏"
```

此入口只接受原帖、全部评论页、配乐、文案和场景内容/顺序均相同的独立已审版本；
允许各场独立调整停留时间或更新渲染器的揭示提示，实际成片和封面必须重新审核绑定。
保留原视频、原上传回执以及线上标题、简介和可见性；确认替换后更新同 ID 的媒体路径与
时长。未知提交结果保留凭据并阻止盲目重试，不重新注册或再次投稿。

聚焦回归：`socialPost.test.ts`、`test_social_post_review.py`；上传契约同时运行
`test_clip_upload_registry.py`、`test_batch_upload_description.py`。跨语言发布前执行
`npm run verify:all`，仅生成候选构建，不激活生产工作流。
