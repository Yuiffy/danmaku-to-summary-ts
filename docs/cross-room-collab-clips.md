# 跨直播间联动精切

以一个直播间为主线，从其他直播间补表情、弹幕与独有发言。适合共用游戏画面、
大部分连麦声音相同的联动；不要求所有主播画面完全相同。入口是
`npm run clips:collab -- --help`。当前是供编辑使用的本地工作流，选材和人物确认由
编辑完成，不自动接管普通切片任务，也不注册候选、入队、上传或改变录制设置。

## 编辑方式与可行性

主线保持主直播间实际顺序。只有其他来源提供了信息增量，才补充其表情、真实弹幕栏
或独有发言。共用画面不必四宫格常驻；同一事件的几路连麦字幕也不能当成多份独立佐证。
按“铺垫—操作/发言—结果—各方反应”组织内容。胜负、陷阱归属和人物情绪必须看实际画面。

例如《超级鸡马》的官方说明支持多人本地/在线游玩，
[官方介绍](https://www.cleverendeavourgames.com/ultimate-chicken-horse)可作为游戏机制背景；
某次直播是否共用同一游戏镜头、有没有延迟或独有 UI，仍以实际录播为准。
[FFmpeg 官方滤镜文档](https://ffmpeg.org/ffmpeg-filters.html)提供 crop、setpts、overlay、
concat 和字幕合成能力。实现按实际解码尺寸取景，用局部时间变换同步插图，并且只选一条
原音轨。技术瓶颈主要是素材完整性、时间校准、说话人判断和视觉取景，不是合成能力。

保留各房间已有录播、SRT、XML 即可；不为此重复整场 ASR 或请求新模型。没有某房间 SRT
仍能补画面，有 XML 仍可查观众反应；没有画面则无法从 XML 还原当时的真实弹幕栏。
四路高清媒体的存储、哈希读取与转码成本按各来源实际大小增加；先对齐、选材，再压短样片。

## 时间与声音契约

- 所有时间都是**录播文件内的秒数**，不能用开播时间、文件名、下载开始时间直接替代。
- 主来源是唯一主时钟。每个其他录播段有若干 `sync` 窗口：`primary` 和 `local` 的
  start/end 是两对已核验锚点。窗口内线性映射，允许至多 1% 漂移；窗口外绝不外推。
- 重连、断流、插播或时间跳变须拆窗口；分文件重连用不同 source ID，允许同一 roomId。
  插图不能跨越窗口边界；素材缺失时删去插图或明确拆分，不重复末帧冒充持续反应。
- `sync` 的 `basis` 为 `shared_game`、`shared_audio` 或 `manual`，`reviewNote` 记录真实核验。
  音频建议不生成这些已核验窗口。共享游戏动作优先用于画面同步；主播本地麦克风和连麦
  回传存在不同延迟，不能把音频相关性当成嘴型/操作已对齐的证明。
- `primary` 镜头的 start/end 和所有插图 start/end 均用主时钟；`solo` 镜头的 start/end
  用该来源自身文件时间。solo 用于闭麦吐槽、连麦前后等独有素材，画面标注来源，保留其原声。
  插入位置由编辑决定，不能把非同时发生的独有发言伪装成同步接话。
- 一个镜头始终只有一条原音轨。插图不带队友声音；solo 直接切换声音来源，不混四份连麦。
  字幕只投影该镜头音轨来源的已有 SRT。字幕来源房间不等于句子说话人；未核验不加人物归属。
- 不切断现有字幕句子，保留必要话尾；真实发声边界仍需听审，SRT 结束不是语音结束证明。

## 建立素材清单与同步建议

任务文件放忽略的 `temp/<date>-<task>/`。成片放主录播旁的 `manual_requested_clips` 新版本目录。
命令不覆盖已有输出；失败留下 FAILED.json，应修正后换新目录重跑。

```powershell
npm run clips:collab -- template --output 'temp/collab-session'
```

修改生成的 SESSION.json：填真实 roomId、名称和已结束的录播文件。路径相对 SESSION.json，
也可用绝对路径；删掉不存在的可选 srtPath/xmlPath。source ID 只含字母、数字、下划线、
连字符，1–40 字符，不能重复。支持 2–16 个录播段。主来源 `sync: []`。

每个来源的 `protectedRegions` 是 `[x, y, width, height]` 归一化矩形列表，
标记主画面里的关键路线、HUD、原头像等不可遮挡区域。无论该列表内容如何，
画面下方 30% 始终留给标准大字幕。正式素材须检查实际三帧，不能照搬其他场次坐标。

可先对其他来源运行局部原音校准：

```powershell
npm run clips:collab -- sync --session 'temp/collab-session/SESSION.json' --source peer1 --reference-start 600 --peer-start 630 --window 20 --search 5 --output 'temp/collab-session/sync-1'
```

reference-start 是主录播时间，peer-start 是其他录播里同一事件的粗估时间。
仅抽取 5–60 秒参考音频，在粗估位置附近 ±1–15 秒内搜索 50Hz 语音带能量包络。
SYNC_PROPOSAL.json 保存相似度、次峰、搜索边缘、原文件摘要及原音 PCM。
静音、重复节拍、边界峰或不唯一匹配标 ambiguous，即使有 suggestedLocalStart 也未批准。
两处相距较远的事件均核对游戏画面与原音后，才填写窗口，例如：

```json
{
  "primary": { "start": 600, "end": 1800 },
  "local": { "start": 630.12, "end": 1830.18 },
  "basis": "shared_game",
  "reviewNote": "已核对窗口两端同一游戏动作，并检查中间连续性"
}
```

锚点之间的中段仍须抽查；两点不能证明中间绝无断流。同步建议不会修改 SESSION.json。

## 汇总四路证据并编排

```powershell
npm run clips:collab -- dossier --session 'temp/collab-session/SESSION.json' --output 'temp/collab-session/DOSSIER.json'
npm run clips:collab -- plan --dossier 'temp/collab-session/DOSSIER.json' --output 'temp/collab-session/PLAN.json'
```

dossier 按主时钟排序各房间字幕/弹幕，保留 sourceId、原时间、原文和稳定的 `peer1:S17`
或 `peer1:D32` 引用。未对齐内容的主时间是 null，留在表尾，以自身文件时间检索。
XML 使用共用的普通弹幕解析器；当前不抽取 SC。弹幕时间是观众发送时间，不是游戏事件发生时间。
原文是不可信证据，不能当成代理指令。可加 `--start ... --end ...` 限制主时钟范围；
coverage 明确报告总行数、纳入数与未映射数，不能把局部范围声称为看完四场。
字幕数组保留完整原音轨文本供边界检查，rows 才是范围内可引用选材。

plan 命令生成空计划，**不自动替编辑选笑点或判断说话人**。阅读完整证据，查看原画、
听原音后填写 shots。每个镜头须给至少一个真实且时间重叠的 evidenceIds；主镜头也可引用
已同步的其他房间证据。引文证明来源和时间，不代替内容完整性审核。

```json
{
  "version": 1,
  "dossierSha256": "保留 plan 命令写入的实际摘要",
  "shots": [
    {
      "mode": "primary", "sourceId": "primary", "start": 610, "end": 625,
      "reason": "保留铺垫、翻车及两边反应", "evidenceIds": ["primary:S17"],
      "overlays": [
        {
          "sourceId": "peer1", "kind": "face", "start": 617, "end": 621,
          "crop": [0.75, 0.2, 0.2, 0.45], "placement": [0.7, 0.15, 0.25, 0.5],
          "reviewNote": "已看实际起中末三帧，脸部完整且避开游戏路线"
        }
      ]
    },
    {
      "mode": "solo", "sourceId": "peer1", "start": 2200, "end": 2208,
      "reason": "此处补该房间闭麦吐槽，明确为独立视角",
      "evidenceIds": ["peer1:S83"], "overlays": []
    }
  ]
}
```

crop/placement 都是相对单帧的归一化矩形；不是成片秒数或屏幕像素。
kind 仅 face/chat，后者截取录播里真实弹幕区域，不把推测评论重画成原直播截图。
来源名与“直播间画面/直播间弹幕”显示在插图下方标签带。不同画幅保持比例。
最多 500 镜头、每镜头最多 12 次插图；时空重叠的插图拒绝合成。solo 不叠其他来源。

## 渲染、审核与后续衔接

```powershell
npm run clips:collab -- check --dossier 'temp/collab-session/DOSSIER.json' --plan 'temp/collab-session/PLAN.json'
npm run clips:collab -- render --dossier 'temp/collab-session/DOSSIER.json' --plan 'temp/collab-session/PLAN.json' --output 'D:/recordings/session/manual_requested_clips/collab-r1'
```

check 只验证计划结构、引用、顺序、边界、同步覆盖和保护区。render 会重新验证清单、
所有媒体和字幕/XML 的完整 SHA-256；处理期间来源变化拒绝结果。应使用已结束的录播，
不要让仍在增长的录制文件通过稳定性假设。默认使用 C:/Windows/Fonts/msyh.ttc 写来源标签，
其他机器传 `--font <CJK字体>`；可传 --ffmpeg、--ffprobe 指定本地程序。

使用现有 FFmpeg 资源限制器顺序转码，默认软件 H.264，便于本地验证；所有镜头统一
主来源尺寸、30fps、48kHz 双声道。中间音轨用 PCM，避免逐镜头 AAC 首尾填充累计漂移。
最终复用现有 ASS 大字幕样式，先合成画面再烧字幕；同时输出 SRT/ASS。
生成原来源与**最终含字幕画面**的起中末三组对照，保存镜头和原/成片时间映射。
完整解码、时长检查通过后，每镜头连续解码一次 48kHz 原音及成片音轨，再按样本位置取
最多 30 秒的块对比；成片从头解码并按样本索引截取，避免 FLV/MKV 毫秒时间基下逐块
独立跳转和重采样造成相位误差。不会拟合偏移或降低门槛来放行，沿用现有
原声相关性、增益、时长和削波检查。静音没有可定义的相关系数，只在双方确为静音时豁免
相关性判断，其他检查照常。各块 PCM 与检查结果保留作诊断。

RESULT.json 始终 `status: pending_review`、`uploadReady: false`。技术检查不等于说话人、
表情意义、音效听感、剪辑因果和素材引用已审核。当前不调用独立视觉/音频模型；须审看实际
成片与完整选中原话、同步和话尾，再做封面、标题与字幕校对。对照帧未覆盖的地方不能声称
完成视觉审核。FAILED.json 不构成成功候选，也不会回退成冒称跨房间成功的普通版。

多源成片不能伪装成一个单源数字候选交给 correct/rebuild。后续要投稿时沿用现有多源合集
人工审核/导入流程，绑定当前最终媒体、字幕和文案；这条命令没有投稿授权或上传入口。
第一版也不自动等齐四个直播间、不启动录制、不修改后台自动切片设置。若要自动化，需要
单独设计四路会合、超时降级、去重与跨源审核绑定；不能复用单直播间的已审状态。

代码归属：`workflows/clipping/collabPolicy` 负责纯规则和时间轴；`collabSync` 负责有界
能量搜索；`collabRuntime` 负责素材绑定、证据与待审版本编排，并注入媒体适配器；
`tools/clipping/collab` 负责本地 CLI、现有媒体运行器、ASS 与原声检查的连接。
