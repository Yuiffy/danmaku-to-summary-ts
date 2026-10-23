# 主播行程与联动记忆

`workflows/itinerary/policy.ts` 负责证据窗口、计划验证、日期、取消覆盖和候选上下文；
`runtime.ts` 负责文件读取、注入模型适配器、串行锁和回执。
`asr/participant_collection.js` 与 `live_generation_context.js` 接入现有流程。
此模块保存私有候选计划，不承担发布、回复发送或录播队列职责。

## 自动流程与范围

1. ASR 参与者发现前刷新所选圈子各主播的近期动态，每个来源最多五条、七天内的帖子，
   每条最多 1800 字。复用本机动态 API，接口缓存与返回条数仍限制覆盖；没开播的成员也能
   提供跨房间线索。相同动态集合复用回执，不在每场重复付费。
2. 下播准备晚安上下文时，本地扫描完整 SRT/XML，按行程词、人物及附近语音选窗口，
   再结合标题、动态提取未来十四天计划。弹幕复用 `radioDanmaku.parseComments`，
   旧 XML 浏览器预览不参与解析。模型并不另读全量直播文本。
3. 相对日期锚定原始语音/动态的北京时间，而非执行日期；凌晨以该行时间为准。
   日期无法定位则不收录，单日事件不猜持续天数，每个事件最长七天、每次最多十二条。
4. 下一场按开播时间查询，排除当时尚未公开的证据，按活动日期与人物跨房间召回。
   较晚且能核验人物的取消/否认覆盖旧计划；改期输出旧日期取消和新日期计划。
5. 历史人物只加入开放声纹候选，不能写 `plannedParticipantIds/confirmedParticipantIds`、
   限制候选集或确认逐句身份。晚安文字和 Python 图片上下文共享历史线索及限制，
   只有本场互动/画面/声纹证据才能支持实际角色，不能仅因同住计划就增加图片人物。

两份配置的 `ai.itineraryMemory` 默认选择 `sui, shiori, mizuki, miting, mofu`。
`scope: "all"` 可扩到拥有 `streamerRegistry.roomIds` 身份绑定的房间；未知房主不隐式开启。
`enabled: false` 同时关闭读写；缩小范围后，范围外的旧来源也不参与召回。
刷新依附录播处理；没有录播处理时不会另起动态轮询定时器。

## 证据与持久化

输出须引用真实行 ID、逐字原文和已注册人物。保存原始文件 SHA-256、行偏移/绝对时间，
动态保存发布时间和链接，日期须引用原话。确定计划至少须有一个人物能在引用中匹配；
只有 ASR 同音人名推测、弹幕推测或无法确定的第一人称主语一律 tentative。
模型明确提出的 tentative 同音身份候选可保留，但不能升级成确定身份。
tentative 取消不能抹除明确计划。语义仍可能判断错误，
任何计划都不构成本场身份或到场证明。地点只取城市/公开活动，不生成具体酒店/私人地址，
公开回复也不得泄露引用中的住宿细节。

默认 `data/runtime/itinerary-memory/` 保存：

- `<source-id>.json`：每份来源当前投影，含 evidence、plans、coverage、usage、generation。
- `receipts/<source-id>-<fingerprint>.json`：各原文/配置版本的回执，保留累计用量。
- `.lock`：每份来源独占 PID 锁，仅确认进程不存在才回收，不按等待时长夺锁。

同目录临时文件原子替换；模型处理时原文改变则拒绝结果。同原文、注册表、配置和 schema
版本只请求一次，失败和空结果也缓存。修改来源/配置才重新尝试，重跑不会不断消费额度。
发请求前先持久化 `outcome_unknown` 意图；进程中断或结果丢失时不自动重复可能已计费的调用。
失败不阻塞原 ASR/晚安流程。到期计划查询时失效，审计文件保留，尚无自动磁盘清理。
使用 JSON schema 约束模型输出；语义/引用逐项验证，一条被拒绝不连带丢弃其他独立有效计划。
模型原始 responseText/responseSha256 和逐项 rejected 原因保存在私有回执中用于诊断。
模型写错行号时，仅在逐字原文唯一匹配一条已提供证据行时修复，记录 repairedCitations；
原文不存在或匹配多行则拒绝，不对引用进行猜测或改写。

## Token 预算与只读命令

一次最多 12000 字符压缩证据、18000 字符完整任务提示、2400 输出 token。
预估使用每 UTF-16 字符 1.5 token，同时报告 UTF-8 字节数；均只针对本地提示，不包含
文本适配器附加的系统提示，不是精确 tokenizer 计数或价格。真实供应商用量保存在
`generation.attempts` 的 prompt/cached/completion/reasoning/totalTokens，与估算分开。
严格模型请求关闭模型/供应商回退和瞬时重试，并避免文本适配器自动抬高输出上限。
动态集合更新为独立小请求；首次刷新最多新增各选中来源一份动态提取。

窗口超预算时先保留“人物 + 日期 + 会面/联动”等高分完整窗口，再分散选择同分窗口。
`coverage.truncated` 显式标记裁剪，不能声称完整分析所有计划。扩大范围或预算前应检查
多个来源的命中质量、截断比例和真实用量。新增字段或改变语义时递增 policy 的 VERSION。

以下命令不调用模型、不写记忆、不激活工作流：

```powershell
npm run itinerary:memory -- usage
npm run itinerary:memory -- show --room 25788785 --started-at '2026-10-19T20:00:00+08:00'
npm run itinerary:memory -- estimate --srt 'D:/recordings/example.srt' --xml 'D:/recordings/example.xml' --room 25788785 --started-at '2026-10-19T20:00:00+08:00'
```

遵循统一配置层；生产检查使用 `NODE_ENV=production` 或 `CONFIG_PATH`。
`usage` 返回各输入版本的估算和供应商 attempts；缓存复用不生成额外请求回执。
验证仅构建 workflow candidate，生产启用通过独立 `workflow:activate` 操作完成。
