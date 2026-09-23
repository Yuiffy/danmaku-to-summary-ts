# 岁己切片的发布取舍

自动召回继续最多选择 50 个完整事件；在边界校准、重叠去除之后、人物复核和视频制作之前，
单独决定本场优先制作哪些独立稿。`maxClips` 是召回上限，不能再把候选数量当作建议投稿数量。
筛选不授权投稿，既有人工确认、字幕、人物归属和上传门禁继续执行。

## 默认策略与回退

`config/default.json` 与 `config/production.json` 的 `ownStreamClips.publicationPolicy`：

```json
{
  "mode": "curated",
  "roomIds": ["25788785"],
  "minScore": 80,
  "maxStandalone": 18,
  "standoutScore": 92,
  "bundles": {
    "enabled": false,
    "minScore": 70,
    "protectScore": 90,
    "maxGroups": 2,
    "maxMembers": 3,
    "maxSeconds": 300,
    "minCombinedScore": 85,
    "minScoreGain": 5,
    "maxCandidates": 20
  }
}
```

| mode | 行为 |
| --- | --- |
| `all` | 恢复原模式，所有通过原流程的候选继续制作 |
| `score` | 仅按 `minScore` 筛选，不限制数量 |
| `curated` | 先过分数底线，再按全场分数优先保留 `maxStandalone` 条；达到 `standoutScore` 的候选全部独立保留，允许超出预算 |
| `shadow` | 计算与 `curated` 相同的建议，但仍制作全部候选，便于比较 |

只对 allowlist 中的房间生效；缺少该配置的调用者保留原行为。日常 CLI 可用
`--publication-mode all` 临时回退。长期回退将配置的 `mode` 改成 `all`。
新启动的后台切片进程读取磁盘配置；已启动进程使用自己的配置快照，不改变正在处理或已排队投稿的内容。

只比较明确标记为模型全局重排、全量或分块选材的 0–100 数值分数；有全局分时优先使用全局分。
弹幕热度、候选池回退、缺分、无效分数不硬套这个尺度，保存在待选库。
同分按原时间和原序号稳定取舍；不按内容类别设配额，不凑满，不以时长淘汰完整独立事件。
高分保护只是编辑信号，不是爆款保证；分数尚未经过播放结果校准。

当前选择保留详细编辑，再做发布取舍，因而节省后续人物复核和制作开销，不能声称减少召回或细编请求。
这个位置也避免把仍需边界修正、最终会重叠的窗口提前挤进发布预算。

## 待选库与可重复预览

`PLAN.json.publication` 保存有效策略、所有原候选的决定、分数与原因，以及完整 `deferred` 候选。
选中项的 `publication.index` 是筛选前的原序号，不是上传 ID，也不是制作后的序号。
`PUBLICATION_REVIEW.md` 展示独立建议和待选理由；主 REVIEW 与通知给出数量摘要和该文件路径。
待选项不会混入本场可上传清单，也不会仅因筛选而申请上传 ID。
筛选前已失败的候选仍走原有失败诊断/短 ID 复核流程。

离线预览只读旧计划、写新文件，不重压、不登记、不通知、不投稿；默认也不请求模型：

```powershell
npm run clips:publication -- preview --plan "录播目录/own_stream_fun_clips/PLAN.json" --output "temp/比较/preview.json"
npm run clips:publication -- preview --plan "录播目录/own_stream_fun_clips/PLAN.json" --output "temp/比较/score85.json" --mode score --min-score 85
npm run clips:publication -- preview --plan "录播目录/own_stream_fun_clips/PLAN.json" --output "temp/比较/budget12.json" --max-standalone 12
```

预览写完整 JSON 计划和同名 Markdown。输出文件必须是新路径，不能覆盖原计划。
对已筛选的计划再次预览会先恢复原候选池，避免越筛越少；`shadow` 的重复候选会按原序号折叠。

恢复待选项先导出新输入计划，再明确回退筛选并制作到新目录。导出时 `--indices` 对应上述原序号；
`--all` 可恢复整个候选池：

```powershell
npm run clips:publication -- restore --plan "录播目录/own_stream_fun_clips/PLAN.json" --indices 2,5 --output "temp/恢复/restored.json"
node src/scripts/own_stream_clipper.js --media "原录播.flv" --srt "原录播.srt" --xml "原录播.xml" --use-plan "temp/恢复/restored.json" --publication-mode all --output-dir-name "restored_clips" --no-notify
```

恢复保留原证据并重新走制作/复核，不恢复历史投稿授权。

## 可选关联合辑

默认关闭自动合辑建议。将 `bundles.enabled` 打开时，每场发布筛选后最多增加一个模型请求；
或只对某份计划临时使用 `preview --suggest-bundles`。模型/传输重试沿用现有配置与缓存。
建议失败或不符合合同只记录原因，独立片照常制作。

合辑只从待选库中挑选：

- 片段模型分达到 `bundles.minScore`，但低于 `protectScore` 和 `standoutScore`，优先独立稿绝不进入合辑。
- 字幕与生产使用相同的可信 ASR/说话人侧车证据，哈希匹配且无未解决的文案/引用问题。
- 每段向模型提供完整窗口原话；最多 `maxCandidates` 个、总字符不超过 60000，超预算整段略过。
- 只有具体事件续篇、前后照应、升级或对比才建议；“都在玩游戏/吃饭”、相同人物或关键词不够。
- 每组 2–3 段、总长最多 300 秒；每段贡献不同发展，按原时间顺序拼接，保留完整边界。
- 模型组合分至少 85 且高于最高成员分 5 分；每个成员有自己的原话引用，禁止未知 ID、片外引用、重叠和跨组合重复。

这些检查约束结构和证据，不证明模型理解正确或组合一定更好看。`relation`、`payoff` 与标题仍标为待核，
需要看原话和画面，尤其检查“翻车”“开打”“挑战”等是否来自模型推断。建议不自动替换单片、制作或上传。
复核后用以下命令制作某个建议，复用标准大字幕、GPU 调度、NVENC/CUDA 及 CPU 回退和已有合辑编译器：

```powershell
npm run clips:publication -- preview --plan "录播目录/own_stream_fun_clips/PLAN.json" --output "temp/合辑/preview.json" --suggest-bundles
npm run clips:publication -- build-bundle --plan "temp/合辑/preview.json" --group 1 --output "temp/合辑/bundle.mp4"
```

输出 MP4、合并 SRT、来源分段 manifest、编译计划与 REVIEW。编译前重新核对原字幕证据和成员资格，
字幕变化会停止。每段先按原窗口烧字，再按实际视频时长平移合并字幕，切段间不包含被跳过的录播。
新合辑需重新审核文案、归属、字幕，并按既有成片流程登记；不会继承单片的审核或投稿状态。

## 调参验证

同时比较候选数、独立建议数、高分保留数、实际通过审核数、恢复的漏选片和合辑采纳理由。
优先用至少几场不同题材的计划回放，检查固定阈值是否因某场普遍高分而失效。
播放效果应在相同上线时长后观察播放、点击、完播、互动，区分单片和合辑；
不能把投稿数量下降直接当作质量提升，也不能用未控制题材/时间的相关性声称数量稀释了流量。
若漏选较多，可降底线或提高预算；若某场全是高分而超额，应先检查评分尺度，不通过合辑吞并高分片。
