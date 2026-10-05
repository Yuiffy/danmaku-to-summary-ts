# Topic Clip Event Editing

The keyword workflow also supports a pre-render review path controlled by
`clipTopics.review.mode: "preflight"`. Its maintained contract is described under
[Preflight Review](#preflight-review); per-run comparisons belong in ignored task storage.
When that path is enabled it replaces the event/copy calls below, rather than
adding two shadow review calls after them. The legacy path remains available.

The keyword topic workflow now treats a publishable event, not a keyword hit or
an arbitrary duration, as the unit of selection. This applies to `clipTopics`;
own-stream and manual-queue selection keep their existing policies.

## 疑似 ASR 人名召回

`clipTopics.ambiguousRecall` 在正常字面关键词之外保留人名假设，供同一次 preflight
请求判断语义。默认关闭；生产启用。它只在 `review.enabled: true` 且
`review.mode: preflight` 时运行，仍遵守 `keywords` 与 `ignoredRoomIds`。

- `contextSeconds` 限制附近字幕的时间范围，默认 45 秒，上限 120 秒。
- `rules` 每条有稳定 `id`、目标 `keyword`、原始识别 `forms`；可用 `roomIds`
  限定房间。必须有 `requireNearby`（附近任一词）或 `cuePattern`（本 cue 正则）；
  `excludePatterns` 保护普通词组和误命中的较长词。目标不在当前关键词内时不召回。
- 生产规则覆盖“随即／随机／最急／最级／c机”等会话线索，以及“自己好起来”、
  “这一集…消息”、“小碎…海獭”等局部语境。它们不是全局纠错别名，源 SRT 不改。
- 一个 cue 已有字面命中时保留原命中。新增命中在 burst、preflight input 和计划
  `hits` 中携带 `recall.kind: ambiguous_asr`、`requiresSemanticConfirmation`
  与 `hypotheses`（规则、原词、可能目标、字符位置）。`keywords` 此时表示可能目标，
  不是声称字幕里真的出现了该名字；所有时间和字幕正文仍来自原始 SRT。

AI 必须结合语法、事件及说话关系逐条判为 `mention / false_match / uncertain`。
“随机抽取”、副词“随即”、反身代词“自己”、剧集“这一集”等明确普通含义应判
`false_match`，不得因为规则命中就补人名。不确定项保持原文并待复核。
句子须跨相邻 cue 连读，不能删掉“被／对／和／跟”来强套副词或反身代词解释。
`clip.hitIds` 只列该事件实际依赖的身份锚点，顶层 `hits` 仍逐条保存所有判断；
已确认事件中的非核心疑词可保留原文并写 warning。疑词涉及身份、角色或主要事实时，
该片仍须 `needs_review`。

疑似命中只有在模型确认 `mention` 且引用片内另一条独立字幕支持语义后，才可能
通过身份校验。模型自报 `ready`、只引用该歧义词本身、引用片外证据都不能放行。
AI 可建议原词的局部人名 patch，但仅限该已确认出现位置，并必须引用同一独立
依据；其他普通用法不继承这个修正。用户确认的、绑定来源的改词保持原有优先级。
这些高歧义词不加入旧 `possibleAsrForms` 的全局别名豁免。

本层复用现有 preflight 请求、缓存校验、候选编号、字幕修订和最终审核，不另外
整场请求一次 AI，不产生发布授权。AI 不可用时沿用待定候选，不能直接烧录或投稿。
初始回答已通过结构校验、但边界修复失败或关闭时，保留有效人名判断、原选窗和
边界问题，把候选置为 `needs_review`；不因边界失败清空语义判断或回退到固定窗。
无效回答和初次模型调用失败仍使用原有待定回退。
模型返回空 `clips`、但还有 `uncertain` 的疑似人名时，为包含该线索的原有 burst
保留待复核候选及编号。这些粗窗不是 AI 确认的事件边界，不能烧录或自动投稿。
全为 `false_match` 的普通词仍不生成候选；已有事件计划也不追加重复粗窗。
新增候选可能增加正常预审请求数；语境窗口和保护词只减少明显噪声，不保证零误判。

规则实现属于编译 workflow 的纯 TypeScript 决策模块。新候选 release 验证通过后，
仍需单独授权并激活工作流才用于实际运行。旧 release 暂时保留字面匹配；不会由
这次验证命令自动激活或修改真实队列。

## 关键词切片最终审核后自动投稿

`clipTopics.automaticPublication` 将关键词切片的最终审核与现有上传队列连接起来：
`mode: "auto"`、`scope: "configured_keywords"`、`policyVersion: "topic-v1"` 表示
用户授权现有关键词流程的新成片在明确通过最终审核后自动入队。默认配置保持
`off`，生产启用；`activatedAt` 是生效时间，`authorizationNote` 记录授权范围。

范围沿用 `clipTopics.enabled`、配置的 `keywords` 和 `ignoredRoomIds`：允许现有
来源房间中的关键词切片，忽略房间仍被排除，不把关键词授权扩大成任意素材投稿。
旧 `clipTopics.autoUpload.enabled` 不构成授权，也不能跳过预审或最终审核。

只有此次新制作、预审 `ready`、字幕已烧入并有完整封面/文案的成片才可能放行。
最终复核绑定当前来源证据、关键词及身份判断、预审修订、完整保留字幕、成片、封面
与公开文案；全片解码和抽帧用于检查实际文件，抽帧不代表已完整观看或听审。
审核不可用、身份/字幕/音频或连续动作证据不足、内容边界不完整时保留待核。
审核通过和 `auto_queue` 决定保存到原 metadata；同一个数字 ID 进入既有单实例
worker，worker 在上传前重验文件、证据和授权。源录播保留供异步检查。

企微仍发送原有完整列表，按时间显示准确 ID 及“已投稿”“已排队投稿”“待人工
复核”等状态。入队失败显示原因，回执不明先核对队列，重复素材指向既有 ID 而不
再次要求批准。不逐条发送成功消息或 BV 号，也不覆盖人工在 B 站修改的内容。

历史成片、旧计划/分组重放、手动候选修复、编号导入或 REVIEW 刷新均不继承这次
自动授权；原有待定候选仍需按下文编号流程确认并明确入队。已有投稿保持去重。
`topic-v1` 与岁己普通片的 `own-stream-v1` 分别验证自己的策略和证据，不能互用。

## 按编号改词并投稿

用户说“把 123 号待定的不确定词 zzz 改为睡睡睡，然后烧录并投稿”时，执行：

```powershell
python src/scripts/clip_upload_registry.py correct --id 123 --from "zzz" --to "睡睡睡" --enqueue --note "用户确认 zzz 应为睡睡睡，并要求烧录投稿"
```

这里的 `123` 是全局数字 ID，不能使用每场重复的 `E1-1` 或 REVIEW 行号。
这条命令只改该候选的字幕、保存用户确认并入队，立即返回；后台
`clip-upload-queue-runner` 自动烧录、制作封面、审计、投稿并回写同一个 ID。
不需要代理生成脚本、手改 JSON 状态、重新 ASR、执行 FFmpeg 或直接调用上传器。

- 想先看待定字幕：`python src/scripts/clip_upload_registry.py subtitles --id 123`。
  老候选没有 SRT 时会补生成，不会烧录或投稿。
- 只改字幕不投稿：上面的 `correct` 命令去掉 `--enqueue`。
- 用户明确只改第 7 条字幕时加 `--cue 7`。否则替换当前候选内所有字面匹配，
  不把 `--from` 当正则表达式；原词找不到则失败，不会偷偷入队。
- 同一文字若出现在该候选的标题、简介或封面文案中，也做同样的字面替换，
  避免字幕与投稿文案不一致，不会重写其他文案。
- 字幕已确认、只需投稿：`python src/scripts/clip_upload_registry.py enqueue --ids 123`。
- 确认整条为背景外语误识别或无效字幕时，可用 `correct --id 123 --cue 7 --from "该条完整原文" --drop-cue --note "原音核对依据"`。
  与 `--to` 互斥，必须指定完整文本、编号与依据；仅删除本片该条叠加字幕，不剪音画，不改源SRT。
  保存可追溯修订、使旧烧录和批准失效，不能删空全片。删除后编号会顺移，批量处理应从后往前。
- 候选里的人名误识别同时影响文案/标签时，`correct` 可附加 `--title`、`--description`、`--cover-text`、`--tags`；这些修订与字幕版本一起保存。单条 JSON 切片需要进入指定合集时，`enqueue --ids 123 --collection-section-id <小节ID>`，不改该直播间的默认合集路由。
  普通成片直接排队上传；待定候选由 worker 先烧录，再上传。
- 收到入队成功后，确认 `npm run pm2:status:clip-upload` 在线即可报告“已入队”。
  不要在当前会话等待烧录或不断轮询；未在线时运行 `npm run pm2:clip-upload:start`。
- 字幕修正本身不等于投稿授权。只有用户明确说投稿，才添加 `--enqueue`。
  用户没有确认的其他不确定词不得猜改，也不要把例子里的编号和词用于真实稿件。

候选在进入待定区之前就有独立的 `*_candidate.srt`。每次修正写入新的
`*_candidate_r0001.srt` 等版本，保留旧版本和逐条修改记录；源录播 SRT 不动。
`subtitles` 与 `show` 始终给出当前字幕版本，不必手动寻找长路径。
确认记录绑定源证据、时间范围、字幕哈希、版本号和文案哈希；worker 不会重新生成
未经确认的字幕覆盖改词。上传重试复用已完成成片，重复入队不会新增同一 ID 的活动任务。

注册表状态：`pending_cut`（待定，有粗剪预览和 SRT）→ `queued`（已授权）→ `rendering`
→ `uploading` → `uploaded`。媒体或证据校验失败会保留候选和错误信息，停止投稿；
在 `show` / `queue` 中查看原因，修正后重新入队。已排队或正在烧录的字幕版本不能再修改。

制作阶段按 ID 隔离失败：某条字幕、文案或媒体校验失败，只停止该条；同任务内
其他候选继续制作，已通过的成片继续上传。`queue` 的 `renderFailures` 保留各 ID
的原因，重启或上传限流重试不会重新处理这些失败条目。其他条目结束后，含失败项
的任务仍显示 `failed`，成功条目保持 `uploaded`；修复后仅重新入队失败 ID。

文案数字校验支持同一条片内证据中的中文日期与阿拉伯数字日期等价，例如
“二零二零年十二月”对应“2020年12月”。逐字读出的两位年份加月份（如“二零年
十二月”）以原录播年份为基准，解释为最近一次已到达的对应年份；录播年份缺失
时不补全世纪。月份、日期须成组匹配，不能跨字幕或不同日期拼接，也不能用日期
数字支持金额或次数。该规则用于初次选材和队列制作，不改写字幕或文案，不解除
来源、归属和媒体校验。

金额和数量也支持明确的中文整数写法，例如“三十块钱”对应“30元”、
“两百零五元”对应“205元”、“十二次”对应“12次”。新增等价匹配支持 0–9999
的完整中文整数及明确的元/块钱、次、个、人、岁单位；元与块钱视为相同单位，
其他单位不得互换。不能把“三十次”当“30元”，也不能从日期或时刻中借数字。
“一百二”、“二三十”、“几十”、小数、万/亿及没有明确单位的口语不做猜测性转换。
阿拉伯数字原值校验和这些等价规则都只使用明确引用、已提供且完整位于片内的
字幕/弹幕；隐藏的 ASR 原文、片外上下文和跨证据拼接不提供数字支持。
初次选材、重审和队列制作共享该规则，保留原有 `unsupported_number` 错误格式，
不更改字幕、文案或用户批准，也不将数字校验通过视为其他待核问题已解决。

预审或边界修订请求超出 `review.maxEvidenceChars` 时，先尝试无损压缩 ASR 的
重复字段：仅当 `recognizedText` 与 `rawText` 完全相同时，在请求中省略前者并
明确说明两者相等。保留全部字幕、原文跨度、弹幕、编号、时间、校正日志及其他
证据字段，保存的原输入和源 sidecar 不变。压缩后仍超预算则继续拦截，不提高
预算、不删上下文、不把请求未执行当成审核通过。

## Own-Stream Review IDs

### 切片前自动复核与快速确认

岁己自动切片先用原文、片内声纹证据和弹幕校对发布文案，再决定是否烧录。
人物复核输入附带可引用的片内字幕编号和已通过局部声纹校验的编号表；有问题的
引号、数字、动作引用以及模型主动返回的 `needs_review` 都有一次自动修订机会。
修订接收逐条校验错误和上一轮结果；单人转述缺少讲述者依据时也可先做独立对话
分析。模型必须重新引用证据，通过原有校验才能放行，不能靠自报置信度通过。
结构化输出按每条候选限制动作、说话人、弹幕及人工问题的引用编号，禁止在不连续的
分组编号之间自行补号；不同候选的证据列表不能混用。程序仍独立校验返回结果。
观众评论的 claim 使用独立 `evidenceDanmakuIds`，不再被迫在字幕 `cueIds` 中引用弹幕
或无关字幕；它必须标为 `audience`，公开字段说明观众视角，且不能填写音轨讲述者。
字幕引用仍须来自片内语音，弹幕不能用来证明主播说过或做过某事。

`ownStreamClips.attribution.maxRequests` 是整批首次复核、对话分析和修订的共同上限；
生产设置为 32，仍为未复核批次保留请求。`maxElapsedMs` 限制启动后续请求的总时限。
已通过项不额外重审；自动修订保留 `attributionReview.history`、最终模型信息和
`aiStatus.attribution.automaticallyRepaired` 计数。`repairAttempts: 0` 可关闭自动修订。
默认沿用现有模型和思考级别；需要定向比较时可设置 `repairModel` /
`repairReasoningEffort`，只影响修订请求，不自动尝试其他提供方或协议。

生产岁己启用 `holdUnresolvedBeforeRender`：修订后仍未通过的项标为
`held_before_render` / `preRenderHold`，只保存独立 SRT 和元数据，保留全局编号，
不烧录、不生成封面。这是待确认候选，不是被丢弃的选材，也不是关键词预审协议。
确认后沿用该编号 `rebuild --id ... --review-note ... --source-kind ...`，再用
`cut --ids ... --review-note ...` 制作；恢复制作仍验证源文件、字幕版本和媒体质量。
已经制作、排队或投稿的旧项不因新配置自动改动。关闭该开关可恢复旧的成片待核方式。

`REVIEW.md` 开头的“快速确认”汇总剩余疑点。模型写简短问题和候选说法，程序从
实际引用生成片内时间、原录播时间和原话；引用无效时不展示虚构的时间位置。
重复疑点合并，例如“片内0:12：这里是小岁自己说的，还是在转述朋友？”；人工可以
直接回复“编号＋改法”。企微展示这些简短说明，本地明细保留完整机器校验和历史。
字幕疑词仍按词/外语音轨分组；缺少原音证据的字词保持待听，不把文案修订当成听写结果。
自动复核和人工反馈本身不等于投稿授权。已明确启用的岁己自动成片另走
[最终审核后自动投稿](clip-publication-policy.md#审核通过后自动投稿)：只有启用之后
的新成片通过全部门禁才自动入队，剩余疑点才交给人工；历史 ID 刷新仍不投稿。

岁己整场自动切片使用一份按起始时间排序的 `REVIEW.md` / 企微总清单。
每条都显示全局候选 ID、时间和状态；已成片、待复核、复核不可用、
制作失败及被规则剔除的候选不会因为状态不同而打乱时间顺序。
剔除项只保存元数据和可定位的字幕，不自动切视频。批次级模型异常附在清单末尾。
企微只保留有助人工判断的复核说明、原文节选和剔除说明，不逐项展开机器校验码；
完整“核对项”仍保存在本地 REVIEW/JSON，不改变复核状态或上传拦截。
自动投稿时，列表显示注册表确认的“已投稿”或“已排队投稿”，不把入队当成成功；
普通版和精切共用最终清单，上传成功不额外发送消息或 BV 号。

文案应保留已经核实的人名：现场嘉宾、被提及者、转述中的执行者和对象一视同仁，
优先使用配置的公开称呼（例如“小栞”），不因为本人未出声就退化成“对方”。
每个字段先交代姓名后可自然使用代词，抽象封面不强塞名字；真正泛指、重名或只有
同音 ASR/弹幕猜测时仍保留未知。复核已经证实角色姓名但文案仍匿名时，走现有的
有限次文案修订或保持待复核，不做脱离证据的全文替换，也不自动改已投稿内容。

ID 是定位依据，不是通过审核或授权投稿。`UPLOAD_MANIFEST.json` 也会包含被保留的
待复核记录；注册时使用 `import-json --include-pending`，对应状态为 `needs_review`。
普通上传读取仍严格校验，仅对 `--only` 选中的条目加载质量门禁；未选中的待复核条目
不会阻塞同批已通过的条目。`--force` 不会解除复核限制。

已存在的录播可不重跑模型、不重剪，只补 ID、更新总清单并按需补发企微：

```powershell
npm run clips:review -- --plan "D:\recordings\own_stream_fun_clips\PLAN.json"
npm run clips:review -- --plan "D:\recordings\own_stream_fun_clips\PLAN.json" --notify
python src/scripts/clip_upload_registry.py show 123
python src/scripts/clip_upload_registry.py subtitles --id 123
```

重复刷新保留原 ID，不把重新排列后的行号当作全局 ID。未变化的通知不会重复发送；
网络调用结果不明确时保留通知回执，禁止直接重发整批。

企微清单每个待核编号只展示最多两条短理由、带录播时间的相关 SRT 原句，以及
附近弹幕（明确标为观众）。优先读取当前成片 SRT，连续未编辑的窗口换算为录播时间；
存在拼接或精切时显示片内时间，避免伪造原录播时刻。缺失时使用
本编号的源字幕/已保存证据；不借用其他修订的原话。完整理由、机器码和原始模型
响应仍留在本地 REVIEW/元数据。摘要不会改变审核结果或授予上传权限。理由及批次告警
使用短中文；英文机器错误只保留在本地。字幕原句中的外语/乱码仍原样放在 SRT 证据行。

普通片最终审核的问题都只涉及标题、简介或封面，而字幕、选材和媒体检查均通过时，
无论问题被归为内容、人物归属还是封面视觉，都会尝试一次独立文案修订、制作新封面，
再重新审核实际成片。缺失/过期的人物审核可补跑；文案不变时复用现成封面和视频。
它保留数字 ID、源窗口、视频和字幕，不创建人工批准；最终独立审核通过后才自动入队。
同一修订结果不会无依据重复请求。待核旧 ID 可显式调用：

```powershell
python src/scripts/clip_upload_registry.py recheck-auto --ids 123 --enqueue
```

按当前事实影响标准重新复核已经制作的普通片，可显式使用：

```powershell
python src/scripts/clip_upload_registry.py recheck-auto --ids 123 --review-final --enqueue
```

`--review-final` 只重审现有视频、SRT、封面、文案及完整来源证据，不调用 ASR、不修改
字幕或重压；与 `--repair-subtitles` 互斥。少量不影响理解或核心事实的错字允许通过，
实质文案误差、人物/数字/否定错误、边界缺失和选材排除仍拦截。重新保存当前独立审核，
保持原编号和必需人物/质检要求，只有 `auto_queue` 才调用原自动入队入口；禁用、历史、
已投稿、人工批准及活动队列中的 ID 不处理。列表刷新不触发此命令。
终止的旧队列授权不阻止重新复核当前成片；复核保留原授权和队列记录，不更新投稿授权。
旧任务提交结果不明或修订后来源标识变化时，仍须先核对原投稿，不能因新复核通过重复提交。
终止的旧自动任务可显式使用保存的旧元数据快照核对并重试：

```powershell
python src/scripts/clip_upload_registry.py retry-auto --id 123 --prior-metadata "path/to/preserved-prior.json"
```

仅处理未投稿、无活动任务、当前成片已独立通过且只剩来源标识变化阻断的原编号。
旧快照必须匹配原队列授权中的审核、决策、上传文案哈希；实时创作中心列表须覆盖旧任务
时间且没有旧/新标题，并距离最后旧尝试至少五分钟。查询失败、时间覆盖不足、线上已有稿件
或当前必需审核未通过都不重投。新授权和查重回执保存在原编号，旧授权及失败任务保留；
`--dry-run` 仅核对，不写队列或注册表。该入口不生成 AI/人工批准，也不用于已投稿稿件。
实际上传子进程重新验证新任务后，仅把与旧快照标题、媒体路径完全对应的旧提交意图归档，
保留其他结果不明的意图；不会在入队时清空上传进程的共享状态。
上传 worker 在同一个短锁中读取队列和注册表，避免新任务配到旧授权。进度回写只合并
当前任务编号的状态字段，保留同时新增的编号、投稿授权、媒体和审核条件。

该维护入口仅处理启用自动策略后生成、仍未投稿且没有活动队列/字幕修订的普通片。
影响事实的字幕疑词、真实选材排除、故事边界仍保留待核；不靠改文案解除这些问题。
缺失/过期的必需质检读取当前完整字幕和实际媒体补跑，获得独立的逐项结果才放行；
与随后最终审核复用一次媒体解码和抽帧，不重新制作。质检失败不会盲目重复请求。
来源、视频或字幕变化使本次修订失效。时间轴修复继承原注册表/元数据中的
`attributionRequired` 与 `qaRequired`，重新完成必需审核，不继承旧批准或丢弃审核条件。

普通片成片审核仅剩明确字幕疑词、其他四项及媒体检查都通过时，自动流程可做一次局部
原音核对；既有待核 ID 的维护入口为：

```powershell
python src/scripts/clip_upload_registry.py recheck-auto --ids 123 --repair-subtitles --enqueue
```

每片最多四个疑句窗、每窗最多三十秒、总计最多两分钟；复用原录播，不重跑整场 ASR。
Fun-ASR-Nano 与 SenseVoice 分别无热词、无字幕提示、关闭 ITN 转写；只有独立结果在唯一
上下文锚点下同意时，才修正对应 cue 的至多两个汉字。不自动改变数字、否定、代词或家庭
身份、配置中的姓名。两个模型一致确认原词也可以作为局部复核证据；不一致仍待核。
短词须有唯一的至少六字上下文锚点及另一侧相邻两字；较长原句可由唯一完整匹配确认。
邻近另一疑词不必逐字相同，但不能缺少上述局部锚点。对齐实现更新时可复用原请求和
原音哈希仍一致的旧结果，不重新转写；同一对齐版本不会无依据重试。
已有手工字幕修订、精切、边界/内容排除、必需 QA 的片段不走此入口。

修词保留源 SRT、旧视频及原编号，用标准 GPU 两阶段 copy 模式另存重压。人物审核保留
原 G-ID、声纹证据和源哈希，只在内存中投影已确认的词；之后重新审核实际字幕、成片和
封面。`automaticSubtitleRepair` 保存原音窗、双模型结果、字面替换和不可变证明文件；
最终审核的 `digests.subtitleAudio` 绑定该证明，入队及提交时重新核对文件。任何证据变化
都会拦截，不生成 `ownStreamHumanReview`。相同证据下的不确定结果不会盲目反复请求。
第一次修词后的最终审核如发现新的具体疑句，最多允许一次完整 cue 加前后各 0.25 秒的
窄窗核对，以避免邻句相似措辞干扰。新疑句必须区别于已核对的词，且仍在整片四窗、
两分钟总预算内；仍需双模型一致、
重新人物及成片复核。前一证明及累积字面改词保留在第二次证明中，上传边界逐层核对。
理由中“当前词与识别/参考词不一致”的比较只定位当前待核词，不把另一句已确认的
参考表述当成新增疑句。最终审核仍读取完整字幕，比较文字不会被删改。

岁己生产配置启用 `ownStreamClips.attribution.sourceReviewBeforeRender`：初选和人物
复核之后，独立 AI 先读取每片完整文本及前后各三十秒、弹幕和房间选材排除，核查
故事收尾、影响事实的字幕疑词和文案条件；少量小错不阻塞，通过才进行媒体制作。切前复核有实质问题或服务不可用
时保存同一候选、字幕和短理由，不裁视频、压字幕或制作封面。流式批次也在提交
媒体任务前完成此复核；普通重跑不把过去通过结果当作当前通过。该步骤只准入制作，
不能代替成片后的画面、技术检查或自动投稿授权。默认配置关闭，生产仅在房间
允许列表内启用，复用本场原文，不为每个候选重做四小时 ASR。

对**已经生成且烧好字幕**的自有直播片段，人工核对视频与原文后，可明确保存复核：

```powershell
python src/scripts/clip_upload_registry.py approve-review --id 123 --review-note "已核对片中人物、原话及文案" --title "核对后的标题" --description "只描述片中事实" --cover-text "第一行\n第二行" --source-kind live_speech
```

该命令不调用 AI、不重做 ASR，也不投稿；只验证文案出处、生成对应封面并保存绑定
视频、字幕、封面、文案、窗口和原始来源的人工确认。原 AI 复核结果不覆盖。
原文不支持的引号/数字、来源变动、缺失或失败的媒体仍会拦截。
已剔除但未切出的项必须先确认窗口并重新生成；连贯长片可使用下文的逐条时长授权，不能仅凭确认文字直接发布。
这里不修改已烧录的字幕；字幕有误时不能用文案确认替代字幕修正。
确认后再次明确 `enqueue --ids 123` 才是上传授权。编号命令会区分自有直播修订与
未渲染的关键词候选，两种元数据协议仍独立。

### 已成片字幕校对与重压

`correct` 也支持 `own_stream_fun_review` 成片，包括待复核或制作失败项。
它只保存逐条字面修订，不运行 AI/ASR、不覆盖原视频或源录播 SRT：

```powershell
python src/scripts/clip_upload_registry.py subtitles --id 123
python src/scripts/clip_upload_registry.py correct --id 123 --from "原词" --to "核实后的词" --cue 4 --note "已核听第4条"
python src/scripts/clip_upload_registry.py cut --ids 123 --review-note "已核对字幕与文案，重压待查看"
```

新字幕、旧版本及元数据历史保存在成片目录下 `subtitle_revisions/<ID>/`。
重压从源录播按原窗口生成新的 MP4、SRT 和封面，复用标准 NVENC/CUDA 两阶段
copy 模式及 CPU 回退；绝不在已烧字的视频上再叠一次字幕。批准的 SRT 字节直接
送入压制，避免二次改词、重分句或修改时间戳。编号、复核索引和投稿状态文件不变。

若文案或人物归属仍需确认，先准备修订：

```powershell
python src/scripts/clip_upload_registry.py rebuild --id 123 --review-note "已核对原话和归属" --source-kind live_speech --title "核对后的标题" --description "只描述片中事实" --cover-text "第一行\n第二行"
```

`rebuild` 只准备待重压资料，不立即压制或投稿。

若原字幕存在已确认的时间轴错配，使用绑定原录播/字幕及证据哈希的校准转写描述符：

```powershell
python src/scripts/clip_upload_registry.py rebuild --id 123 --start 1200 --end 1230 --transcript-record "path/to/RESULT.json" --source-kind live_speech --review-note "修复原音与字幕时间轴" --allow-short --duration-note "完整话题约30秒"
python src/scripts/clip_upload_registry.py cut --ids 123 --automatic-review --review-note "重建后重新独立复核"
```

原 ID、旧视频/SRT、投稿状态均保留。必须重新渲染；新复核不伪造人审，也不自动替换
已有 BV。已投稿稿件禁止再次入队；线上媒体替换须单独授权，并保留仅自己可见等设置。

用户已授权修复原线上稿件且上述新审核通过时，使用原 ID/BV：

```powershell
python src/scripts/clip_upload_registry.py replace-media --id 123 --expected-bvid BVexample --note "用户要求修复原稿音画字幕错配"
```

该操作仅替换原稿的单个视频和封面、修正自动生成的源时间行，保留线上标题、简介其余
内容及隐私/评论/字幕等设置。提交前再次核对线上修改和成片证据；只上传文件，不调用
新投稿入口。回执保留原 uploadState，未知提交结果禁止盲目重试。

普通的边界调整继续按需传入
`--start` / `--end` 调整源录播的绝对秒数；已保存改词后拒绝改窗，以免丢弃修订。
`approve-review` 仍只确认已生成的视频；存在待重压字幕时不能用它批准旧视频。

用户明确要求校对后投稿时，最后一条 `correct` 可附加 `--enqueue`，或单独执行
`enqueue --ids 123`。已有文案/来源复核可继承，未确认的归属须先通过 `rebuild`
明确保存。队列绑定字幕版本、哈希、文案和原始来源，worker 重压并通过媒体审计
后才能投稿。入队命令立即返回；确认 worker 在线即可，不在会话里反复轮询。
字幕修改会使旧视频暂不可上传；改词失败不入队，排队中的版本不可修改，重试复用
已成功生成的版本。已投稿 ID 允许本地校对重压，但禁止 `enqueue`（包括 `--force`）
再次投稿，需走原稿替换流程。

已经成片的关键词切片（`local_review` / `topic_candidate_manual_cut`）也通过同一
`rebuild` / `cut` 入口按原 ID 补齐话题上下文。先核对起因、指代、讨论和收尾，
再以源录播绝对秒数保存完整窗口及对应文案：

```powershell
python src/scripts/clip_upload_registry.py rebuild --id 123 --start 1200 --end 1290 --review-note "已核对完整话题、人物和发布文案" --source-kind live_speech --title "完整主题标题" --description "片内事实概述" --cover-text "主题封面" --xml "D:\录播\原录播.xml"
python src/scripts/clip_upload_registry.py subtitles --id 123
python src/scripts/clip_upload_registry.py cut --ids 123 --review-note "已检查修订字幕，生成完整窗口待查看"
```

`--xml` 仅在旧元数据漏存原弹幕路径时显式补充；保存后绑定文件哈希，不能替换
已有路径或忽略之后的源文件变动。不指定时，旧关键词稿件可继续使用原复核保存
且仍位于新窗口内的弹幕证据。原 `aiReview` / `editorial` 留作历史，新窗口的
文案、字幕与人工复核独立绑定；旧窗口的 ready 状态不会批准新视频。重压保留
原视频、数字 ID、复核索引、已投稿 BV 及状态文件，复用标准 GPU 压制和媒体审计。
已投稿稿件最后须替换原线上稿件，不能通过 `enqueue` 新投一次。

### 被上下文或重叠规则剔除后的重新选窗

对 `outside_candidate_context` 或 `overlap_after_alignment` / `overlap` 剔除项，
先检查完整源字幕和相邻已保留稿件，再通过原编号准备一个新的完整事件窗口：

```powershell
python src/scripts/clip_upload_registry.py rebuild --id 123 --replan --start 1200 --end 1290 --review-note "重新核对了起因、讨论和收尾，与已保留片段不重叠" --source-kind live_speech --title "新窗口的标题" --description "片内事实概述" --cover-text "新窗口封面"
```

`--replan` 必须同时提供新起止时间、完整文案和来源复核，不能原窗不变直接放行。
程序检查源证据与同一录播其他保留 ID 的窗口，保留原剔除记录及新编辑计划；
字幕修订、入队确认、重压时仍检查来源和重叠。其他剔除原因不因此解除。
之后使用原编号 `subtitles` / `correct` / `cut`，有投稿授权时再 `enqueue`。
完整事件低于自动最短时长时，`rebuild --allow-short --duration-note "完整起因、回应与结尾的审核依据"`
可保存只适用于该窗口的编辑复核。仍须核验源范围、上下文、人物与媒体，不加入无关片段凑时长。
已经烧录且窗口不变的短片允许校对重压，不套用新选窗的最短时长限制。

### 连贯长片的逐条授权

岁己自动 AI 选材已取消固定秒数的淘汰条件。分块召回、全场选材、全局重排、
详细编辑及缓存校验均保留来源有效的完整话题，由 AI 根据内容决定长短；新选中的
长片不需要额外时长授权即可进入正常制作与复核。程序继续检查时间有效性、来源
范围、引用、重叠和媒体质量。`minClipSeconds/maxClipSeconds` 仍用于本地信号候选
窗口与下述旧稿修订，不能用来判断新 AI 片段是否合格。

若一个完整事件或连贯主题确实需要较长铺垫、讨论和收尾，应保留完整长度，
同时让标题、简介概括全段。若中途已换嘉宾、开始新游戏或进入独立事件，应重新选窗。

历史上仅因 `duration_out_of_bounds` 被剔除的自有直播候选保留原记录，不自动复活或投稿；
需要恢复时，可保留原 ID 和原窗口：

```powershell
python src/scripts/clip_upload_registry.py rebuild --id 123 --allow-long --duration-note "同一主题的完整铺垫、讨论和收尾，缩短会丢失必要上下文" --review-note "已检查完整选材范围和发布文案" --source-kind live_speech --title "涵盖全段的标题" --description "全段内容的事实概述" --cover-text "主题封面"
```

这会保存绑定当前起止时间的 `durationApproval`，保留原剔除理由及证据，不提高
全局自动选材上限。`--allow-long` 必须有非空理由；源证据、最小时长、片内引文/
数字、人物归属和媒体校验仍生效。仅改时长授权不能解除重叠等其他剔除原因。
之后照常 `subtitles` / `correct` / `cut`；确有投稿授权时才附加 `--enqueue`。

回归验证：

```powershell
python -m unittest tests.test_own_revision_registry tests.test_topic_candidate_registry tests.test_review_pending_registry
npm test -- --runInBand src/scripts/render_own_revision.test.ts src/scripts/review_rendered_clip.test.ts
```

可选真实媒体测试：设置 `DANMAKU_TEST_REAL_MEDIA=1` 后运行
`tests.test_own_revision_registry.OwnRevisionRegistryTests.test_real_source_render_and_media_audit_without_upload`。
该测试使用隔离注册表和合成源录播，不投稿。`DANMAKU_MEDIA_TEST_OUTPUT` 可指定本地
测试产物目录（在仓库内应使用被忽略的 `temp/`）。

## Preflight Review

Enable `clipTopics.review.enabled` with `mode: "preflight"` to prepare all
candidate groups before rendering. `strategy: "single"` produces event boundaries,
keyword decisions, local subtitle corrections and final public copy in one call
per group. `strategy: "staged"` is an explicit alternative, not an automatic retry.
`review.enabled: false` returns to event editing; `mode: "shadow"` is advisory.
Read model, reasoning effort, evidence limits and timeouts from the current
configuration instead of copying the settings of an old experiment.

The request includes complete source subtitles with IDs, ASR/correction provenance
when available, nearby audience evidence and source-host metadata. A keyword hit
does not itself establish identity. Exact model/protocol routing is validated;
failures must not silently switch providers, protocols or reasoning effort.

Persist and validate the complete `_TOPIC_PLAN.json` before media work. Only
`ready` candidates receive burned final media and covers. Every held candidate gets
an editable, clip-relative SRT and an unburned stream-copy review preview before
registration, including already corroborated AI corrections but not rejected guesses.
Failed or `needs_review` candidates retain evidence and reasons, and reserve globally unique numeric IDs in the same
upload registry (`pending_cut`). REVIEW and WeChat show those IDs beside the
per-stream labels such as `E1-1`; a candidate keeps its numeric ID after rendering.
Source changes, unsaved plans and exceeded evidence budgets hold the
affected candidates rather than truncating their subtitles. Never overwrite the
recording's original SRT. A preflight `ready` result alone does not authorize upload;
new rendered artifacts covered by the configured automatic policy still need the
independent final review above. Other candidates retain the manual approval path.

### 选窗失败的自动恢复

预审返回的起止范围违反时长限制、彼此重叠，或起因/收尾/回指依赖校验失败时，
允许同一模型、协议和思考级别进行一次选窗修订。修订请求保留完整的原上下文，
反馈只带上一版起止、关键词锚点、必要回指 ID 和具体错误，不重复附上长篇逐句解释
与旧公开文案；完整模型回答仍保存在 `groups[].responses` 中。修订重新返回边界、
字幕改词及公开文案，仍须经过原有校验。

当必要起因、回应或未解回指落在上下文头尾三条字幕或已知的窗口外原字幕时，
先补读对应方向的连续原文，再让模型重新选窗。补读步长沿用
`contextPrePaddingSeconds` / `contextPostPaddingSeconds`（默认前 180、后 300 秒）。
若完整补读请求超过 `review.maxEvidenceChars`，逐级减少新增范围，保留全部原有
字幕和至少三条新增字幕（原录播剩余不足三条时全部保留）；不抽样或截断原有证据。
扩展也遵守 `editorial.maxGroupSeconds`，不会提高字符预算或成片时长上限。
`sourceContext` 提供原字幕的整体时间范围及 `hasEarlier` / `hasLater`，用于区分
上下文用尽与录播字幕结束，不证明未提供的内容或声学停顿。

扩展范围内已有召回规则找到的关键词锚点一并提供，原锚点 ID 保持不变。模型可
重选一个完整事件，或在超出成片时长限制时选择互不重叠、各有真实锚点与完整起因
收束的独立子事件；每片重新生成并校验文案，不能把依赖前文的回答强拆成独立片。
`groups[].contextRecovery` 和逐片 `aiReview.contextRecovery` 记录前后范围、补入的
字幕 ID、新增锚点数及请求字符数。

第一次修订后若具体依赖仍需要新的窗口外原文，最多再补读并修订一次；同一分组
合计最多两次修订，无新增证据时不反复请求。正常通过的预审不增加请求，已成功
分组不重做。服务失败、源证据变化和模型路由不符不走这条修订路径；修订仍不合格、
没有后续字幕或预算无法容纳新增证据时保留待核候选及完整失败记录。不能机械拉长
最终视频、拼接无关问答、修改时长限制或沿用旧文案来放行。

已入队的关键词候选若因上述选窗失败而缺少正式计划，worker 可在制作阶段重新预审
同一原始关键词事件，保留全局编号。它读取配置的前后上下文和原弹幕，要求恰好一个
完整且通过预审的结果，保留原关键词锚点，并核对与同源其他保留候选/成片的重叠。
若完整补读超过请求预算，逐级减少新增上下文，保留原候选窗口、原上下文字幕及结构化
边界审核引用的全部原字幕；每侧有新增原文时至少保留三条。`candidateRecovery.diagnostics`
中的 `preflightGroups[].contextBudget` 记录请求范围、必须保留范围及实际供应范围。
此阶段不再次递归触发预审选窗修订。源文件变化、未批准字幕字节变化、覆盖用户已确认
改词、仍需人工核对或丢失原事件都会停止该 ID，其他 ID 继续制作和投稿。

通过恢复后写入新的 `*_candidate_rNNNN.srt`，重新生成成片、封面和文案。原字幕、
粗剪和审核留在 `candidateRecovery.original` 中，新范围不能复用旧粗剪或旧字幕批准。
原用户投稿意图只授权同一编号和原事件：`candidateRecovery` 将它与新字幕哈希、
新窗口、文案、当前 AI 预审及源文件绑定，worker 据此制作和审计，再沿用原上传任务。
AI 重选在 REVIEW 中显示为 AI 复核，不冒充用户重新看过成片。独立 `cut` 仍不入队。
恢复尝试在模型调用前持久化，失败或中断不会自动循环；检查失败原因后显式重新
`enqueue --ids ...` 可开始新尝试，旧尝试保存到 `candidateRecoveryHistory`。

该恢复逻辑属于编译 workflow；验证只生成候选 release。启用新运行版本仍须按
[部署契约](architecture.md#compiled-workflow-releases) 单独激活，不由测试自动修改活动版本。

Normal clips and candidates share one numeric ID space. An explicit upload request,
`npm run upload:clips -- enqueue --ids 123`, snapshots the approved candidate SRT
and creates a background job. The command never waits for rendering. The existing
single-instance worker renders candidates before grouping and validating uploads;
ordinary clips skip rendering. `--dry-run` only reports the intended action and
never prepares, approves, renders or enqueues. `--force` does not bypass evidence checks.

For a render-only review or a public-copy repair, inspect the candidate with
`npm run upload:clips -- show 123`, then run
`npm run upload:clips -- cut --ids 123 --review-note "Source checked"`.
Use `--title`, `--description`, or `--cover-text` for evidence-backed public-copy
corrections (one candidate per command when overriding copy). The command checks
the source fingerprint, keyword identity, accepted subtitle corrections and final
copy before using the shared GPU manual-cut path. Explicit user approval can
resolve model uncertainty without another model/ASR call. Original-source drift,
modified unapproved SRT bytes, out-of-window evidence and unsupported public copy
still block upload. Approval does not invent missing plans or public copy after
an AI service failure. The original AI review remains alongside the user correction
history and approval snapshot.
After checking the video and cover, run `npm run upload:clips -- enqueue --ids 123`
to publish. The standalone `cut` command never enqueues; only `enqueue` carries
upload authorization. Automatic discovery prepares rough previews for held
candidates without burning subtitles, approving content or authorizing upload.

### 待预审粗剪视频

待预审候选自动生成 `*_preview_rNNNN_*.mp4` 和同名 `.srt`，在同一目录打开视频即可
由支持外挂字幕自动加载的播放器载入。`REVIEW.md` 提供可点击链接，并显示候选在
粗剪中的起止秒数。默认保留前 8 秒、后 2 秒上下文；copy 模式可能多保留一个关键帧
间隔。字幕按实际视频包时间戳校准，包含上下文及当前候选已确认的改词。
候选的版本化 SRT 仍以候选起点计时；预览 SRT 以粗剪起点计时，二者不能互换。

旧候选或粗剪失败项可按原编号补生成，支持逗号分隔的多个编号：

```powershell
python src/scripts/clip_upload_registry.py preview --ids 123,124
```

命令不需要预先批准文案或人物归属，不调用 AI/ASR、不烧字、不生成封面、不投稿。
失败按 ID 隔离，保留可重试原因；上传队列正在处理的编号不能同时生成预览。
粗剪保存在独立 `reviewPreview` 元数据中，不填写成片 `output.mediaPath`，不改变
`pendingCut`、字幕确认或上传状态。`show` 也能查看粗剪路径。

重复准备复用现有视频；`correct` 会同步更新同名预览 SRT，保留原候选字幕修订历史。
后续 `cut` 或已授权 worker 校验源文件、视频文件和窗口后，直接使用粗剪完成精确
裁边及标准 GPU 字幕烧录，封面清理不会删除预览。重新选窗或源媒体变化会使旧粗剪
失效，重新生成时保留旧预览。源字幕证据变化仍须重新预审，不能用粗剪绕过证据校验。

`review.qualityRules` enables the source-grounded quality constraints; an extra
independent audit is optional, not required on every single-call preparation.
Quality preparation also returns a `boundaryReview`: setup/closure cue IDs,
reasons for both boundaries, dependencies from delayed answers or pronouns to
their prerequisite cues, and any unresolved cue IDs. The editor must follow the
earlier incident across intervening chat, include all necessary source footage,
or hold the candidate. Local validation holds missing, unseen, out-of-window or
unresolved prerequisites; it does not silently expand a clip or turn outside
evidence into public copy. Linked IDs establish traceability, not semantic proof.
The review is preserved in the plan and per-clip `aiReview`; staged final copy
keeps the locked review. Legacy configurations without quality rules retain the
optional schema. Request version changes invalidate old selection caches without
revisiting already rendered or published candidates. This adds no model round.

Within the existing audience-row budget, target-name messages and messages
closely repeated in nearby speech receive shared priority; remaining slots keep
context coverage. A flood of keyword messages must not erase a delayed question.
This affects evidence recall only, never speech attribution or identity approval.
Candidate 2268 exposed both failures: uniform sampling dropped the introduction
and delayed question, and the selected answer lost its earlier group-chat setup.
Regression coverage lives in `preflight_boundaries.test.ts`; live semantic quality
still requires editorial inspection.

Closing review reads the next three supplied cues (or all remaining cues), cites
their words/IDs in `endReason`, and distinguishes a continuation, rebuttal, delayed
answer or closing laugh from a new independent topic. Select the complete exchange
before writing its hook; narrowing a title cannot justify dropping its follow-up.
Context exhaustion and subtitle timestamps alone do not prove a natural ending.
An end inside a coarse original ASR span is held for boundary repair or inspection,
even when its displayed subtitle row looks complete. Word timing is not invented.
This gate uses existing `rawRef` / `originalAsrSpans` evidence and adds no ASR call.

Ready render selections retain up to three seconds of existing source footage
after the selected closing cue, stopping before the next speech (80 ms margin),
the supplied context end, a sibling clip or `maxClipSeconds`. Overlapping/touching
speech provides no padding; necessary follow-ups must be selected as full cues.
No silence or frozen frames are synthesized, and held candidates are not extended.
The additive `aiReview.endingHold` records `speechEnd`, actual `seconds` and
`requestedSeconds`; the final window and copy window bind the padded cut, while
the selected speech cue IDs and subtitle words stay fixed. This changes new
preflight requests/render selections; it does not revise already published IDs.
The new compiled `clipping/preflightEnding` entry must be explicitly activated
after validation for the timing gate and padding to run. Until then, source CLIs
keep the older boundary behavior and use the revised prompts; the compatibility
path tolerates only an absent new entry, never a damaged release.

`preflight_facts.js` reads user-confirmed facts from
`data/runtime/topic_verified_facts.json`. Each correction is bound to the exact
source path, SHA-256, time range and user authorization; stale or mismatched entries
do not apply and must not become global ASR replacements. In ordinary host speech,
use the source host by default; distinguish guests, quotations, audience messages
and playback when the source contains evidence for those exceptions.

Acceptance checks cover complete setup and ending, attribution, conditional and
negative wording, subtitle corrections, final copy and the rendered media. Tokens,
elapsed time, model self-approval and unit-test results are not substitutes for
editorial quality review. Keep recordings, prompts, cost ledgers, failed attempts
and visual checks for each comparison under `temp/<date>-<task>/`.

## Pipeline

1. Recall keyword bursts with the existing matching rules and context padding.
2. Pool overlapping context windows into bounded editorial requests. Pooling
   provides shared evidence; it does not itself merge the events. The complete
   audio-track subtitles are retained, with source cue IDs and available speaker
   labels, rather than taking the first N lines or sampling away a payoff.
3. Let the configured topic model choose independent events across each group.
   Combine the setup, development, reversal, and immediate host reaction to the
   same story into one continuous source interval. A new topic requires its own
   independently worthwhile clip, or is omitted. No existing MP4s are concatenated.
4. Resolve the returned cue IDs to exact source times. Reject unknown/out-of-range
   evidence, missing keyword anchors, invalid duration, and overlapping outputs.
   Never silently truncate the model's event to satisfy a duration limit.
5. Apply a final cross-group overlap safety check. Editorial score takes priority;
   duration is only a tie-breaker. Repeated keyword wording alone no longer deletes
   different non-overlapping events. Conflicting candidates remain in the plan for
   manual review, with a warning; this safety check is not a semantic merge.
6. Generate title, description, and two-line cover copy in a separate request for
   each locked final interval. Supply only its complete in-clip subtitle evidence,
   not recall titles, other events, or outside-context facts. Validate the clip ID,
   cited evidence, quoted text, numeric claims, and basic copy format.
7. Use the existing media/subtitle/cover pipeline, review, short-ID registration,
   and notification. Configured automatic publication additionally requires the
   independent bound final-artifact review; event editing alone grants no approval.

## Duration And Request Limits

The defaults in both JSON configs and config loaders are:

```json
{
  "preferredClipSeconds": 180,
  "maxClipSeconds": 480,
  "editorial": {
    "enabled": true,
    "maxGroupSeconds": 1800,
    "maxEvidenceChars": 80000
  }
}
```

Three minutes is a preference. A longer event must supply an `extensionReason`
explaining the necessary setup or payoff. Eight minutes is a hard ceiling, not a
target: if an event cannot fit, select a complete sub-event or leave it for review.
Explicit caller limits remain respected; do not override them per clip.

Request limits stop adjacent groups from growing indefinitely. An individual
oversized burst is not truncated to meet the evidence budget: it falls back to
recall windows marked for review. Successful event and final-copy responses use
the existing validated selection cache under the recording's mapped output-side
`temp/<source filename>/topic_selection` directory. Prompt or final-boundary
changes invalidate the relevant cache key.

## Attribution And Failure Handling

The recorded audio can include guests, retelling, quoted dialogue, and playback.
First-person speech is not proof that the host is the person in the story. Copy
must distinguish the host's reaction from events being recounted or watched.
Uncertain source attribution is marked `needs_review`; linked cue IDs prove a
time/provenance association, not that ASR identities or interpreted claims are true.

On model or validation failure, preserve the original recall windows with
`editorial.status: "fallback"` and a planning warning. Do not call a mechanical
union an editorial merge. If final copy fails, use neutral source/time templates,
mark `copyStatus: "fallback"`, and retain the failure. Never reuse old candidate
copy for changed boundaries.

`<recording>_TOPIC_PLAN.json` records the source hash, grouped keyword anchors,
selected and suppressed candidates, editorial assessments, linked evidence,
request diagnostics, and failures. Per-clip metadata records `editorial`, final
copy grounding, the copy model, and its locked `copyWindow`. `REVIEW.md` links the
plan and exposes long-event and attribution review notes. New preflight-ready
finals within the configured `topic-v1` policy may auto-enqueue after final review;
unresolved and historical candidates keep the existing human approval path.

WeChat notifications also list every pending preflight candidate with its time
range, title, blocking evidence checks, and relevant source excerpts. Pending
candidates are counted separately from generated media. Overlap suppression
records identify the omitted candidate and retained replacements, and subtract
retained time intervals to report any uncovered ranges directly in the message.
Full coverage means no unique footage was omitted; partial coverage remains a
potential missed-clip issue, not an automatic editorial approval.

Preflight plans preserve both selected and suppressed candidates with an explicit
`selected` flag. `clipTopics.review.transientMaxAttempts` defaults to 2 for daiYu:
explicit transient HTTP errors are retried once on the same model before holding
the group. Local aborts are not retried while the upstream outcome may be unknown.
This does not change the configured model, reasoning effort, evidence validation,
or approval gate, and retry-only changes do not invalidate successful model caches.

Recovery callers can pass `planningGroupIds: ['E9']` to `generateTopicClips` to
retry only a failed group using the same complete source evidence. Unknown or
empty selectors fail before AI requests. Use a separate `clipTopics.outputDirName`
such as `topic_clips/retry_E9` so the partial retry cannot replace the original
whole-stream plan, review, or successful media.

Set `clipTopics.editorial.enabled` to `false` to use legacy per-burst AI planning.
Disabling AI text or `aiSegmentBurst` still uses the existing rule-based path.
These switches do not independently restore the former 180-second hard ceiling.

## Bounded audio checks for ambiguous recall

`clipTopics.review.audioChecks.enabled` adds a local audio check before the AI
preflight request for ambiguous ASR anchors. It uses VAD, an unprompted Nano pass,
ordinary-context consistency checks, then an aligned-only pass with canonical
name hotwords. Prompted text is separate evidence and cannot automatically approve
a name patch. Failed, silent, mismatched or budget-skipped anchors stay uncertain;
they cannot be promoted by a model's `mention` verdict. The normal semantic,
boundary, subtitle and publication gates still apply.

Group plans and candidate `aiReview.audioChecks` retain the source-bound result
and diagnostic paths. See [ASR local audio contract](asr-backends.md#关键词预审的自动局部音频复核)
for cost limits, resource protection, failure states and rollback. Enabling this
feature affects new processing calls and does not replay historical candidates.

## Regression Case

Mofu's 2026-09-06 recording produced `[6743, 6923]`, `[6849, 7029]`, and
`[7015, 7168.814]`. The 74- and 14-second overlaps crossed a story, a reversal,
the host's reaction, and a subsequent topic. Simply removing the middle clip lost
unique story development. Tests now require joint consideration, preservation
of the reversal in a longer continuous event, a separately bounded new topic,
and fresh copy based on the respective final intervals.

```powershell
npm test -- --runInBand src/scripts/clipping/topic_editorial.test.ts src/scripts/clipping/topic_selection.test.ts src/scripts/topic_clipper.test.ts
```

The regression uses fixed source timings and deterministic model responses. Live
model output still requires editorial listening/viewing review; passing these
tests does not promise that every future semantic decision is correct.
