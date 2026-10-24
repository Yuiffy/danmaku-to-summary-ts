# B 站接口上游与排查入口

这里维护本项目的 B 站调用归属、可参考上游及接入策略。具体账号、评论、测试回执和
补发记录保存在当次忽略的 `temp/<date>-<task>/`，不放入此指南。
调用问题先找下表的现有适配器，再核对上游对应方法和当前网页实现。

## 当前调用归属

| 能力 | 本项目入口 / 所有者 | 当前实现 |
| --- | --- | --- |
| 鹿饼通知、评论回复、点赞、视频／动态上下文、热评及佩戴粉丝牌 | `services/bilibili/comment-replies/CommentApi.ts` | 固定 B 站 HTTP 适配器，`node-fetch`；没有依赖 Python SDK |
| 评论公开可见性诊断 | `tools/bilibili/inspectComment.ts`、`comment-replies/CommentVisibility.ts` | 固定评论列表 GET，匿名默认、登录对照可选；不调用模型、不发布、不改队列 |
| 总结评论、动态详情 | `BilibiliAPIService.ts`、`scripts/bilibili_comment.py`、`bilibili_dynamic_api.py` | Node 服务及 Python SDK 桥；保留 CLI / stdout / 线程契约 |
| 投稿、封面、稿件编辑 | `scripts/batch_upload.py`、`bilibili_upload.py`、`clip_media_replace.py`、`update_cover.py` | Python `bilibili-api-python`；部分依赖上传器私有接口 |
| 合集编辑、账号投稿权限 | `scripts/bilibili_collection_edit.py`、`bilibili_upload_capabilities.py` | 独立网页接口适配器，沿用现有回执和权限预检 |
| 直播房间 / 弹幕信息 | `scripts/bilibili_room_info.py`、`bilibili_danmu_info.py` | Python SDK；另有本项目直播服务的 HTTP/WebSocket 适配器 |

## 上游索引

核对日期：2026-10-22。下列日期是查阅版本的提交日期，不承诺该项目此后持续维护，
也不表示其所有写接口已在本项目账号上验收。新接入前重新检查 releases、源码和 issue。

| 上游 | 查阅版本 / 活动 | 适合参考什么 | 接入时注意 |
| --- | --- | --- | --- |
| [renmu123/biliAPI](https://github.com/renmu123/biliAPI) / `@renmu/bili-api` | 2.15.2；[01cce27](https://github.com/renmu123/biliAPI/commit/01cce27f77fdd0600e80275f92b6908868f1762b)，2026-09-16 | TypeScript 投稿、动态、评论、WBI；CHANGELOG 有评论发送适配 | 检查具体方法；所查评论表单有 `gain_source` 拼写，不可直接替代 `gaia_source`；不沿用证书校验弱化或模拟指纹逻辑 |
| [seiuna/bilibili-api](https://github.com/seiuna/bilibili-api) / `@seiuna/bilibili-api` | 1.1.3；[7727e56](https://github.com/seiuna/bilibili-api/commit/7727e56d0f8a239509d0d101f9dcf4a294f7068c)，2026-10-07 | TypeScript 类型化实体、评论区、通知、扫码和凭据管理 | `CommentArea.add` 仍使用 `/x/v2/reply/add`；确认凭据刷新、Cookie 持久化、跨域凭据及写请求重放边界 |
| [seiuna/dsh-bilibili-plugin](https://github.com/seiuna/dsh-bilibili-plugin) | npm 1.0.4，2026-10-18 发布；依赖上述 SDK 1.1.3 | DeepSeek Harness 的通知、评论工具及上下文组织 | 插件能力不等于底层所有接口均有效；业务模型不接入它的系统权限；凭据刷新问题须同时查 SDK issue |
| [bronyacccxz/dsh-bilibili-reply](https://github.com/bronyacccxz/dsh-bilibili-reply) | [85a9241](https://github.com/bronyacccxz/dsh-bilibili-reply/commit/85a92410e41b2110920f7510446b79a9106b985b)，2026-10-20 | 浏览器发评上下文、`@` 处理和匿名可见性复查；见 [tools/README](https://github.com/bronyacccxz/dsh-bilibili-reply/blob/85a92410e41b2110920f7510446b79a9106b985b/tools/README.md) | 是技能/脚本参考，不是已接入依赖；其成功气泡及经验不能替代我们的线上核对 |
| [SK-415/bilireq](https://github.com/SK-415/bilireq) | [1389482](https://github.com/SK-415/bilireq/commit/1389482b34d3dc67c71c8ea6c0e450ac12030a29)，2026-10-13 | Python 请求、认证、签名基础 | 所查范围未提供可直接替换的发评能力 |
| [Nemo2011/bilibili-api](https://github.com/Nemo2011/bilibili-api) / [bilibili-api-python](https://pypi.org/project/bilibili-api-python/) | 仓库于 2026-07-06 归档；本机 17.4.1，查阅 PyPI 17.4.2 于 2026-06-19 发布 | 解释现有 Python 调用与兼容问题 | 属于现有存量依赖，不能再把原仓库当作活跃维护的唯一上游 |

补充协议资料：[通知消息结构](https://github.com/huang3292/bilibili-API-collect-save/blob/master/docs/message/msg.md)。
网页当前实现可从实际页面加载的官方静态资源核对，例如评论组件
`https://s1.hdslb.com/bfs/seed/jinkela/commentpc/bili-comments.js`；资源可能滚动更新，
排查时把下载时间、URL 和内容哈希留在当次临时目录。协议资料也可能落后于线上。

2026-10-24 复核发现 `MedalWall?target_id=其他用户` 可返回登录账号自己的 `data.uid`，
不能作为目标用户佩戴证据。`CommentAudience` 改用固定 nav GET 提供的 WBI key 材料，
按现存 SDK `_get_mixin_key/_enc_wbi` 规则签名固定 `/x/space/wbi/acc/info?mid=目标UID`；
key URL 仅用于解析字符串，不请求图片。核对返回 `mid` 后，以 `fans_medal.show/wear`
确认佩戴。当前响应可能省略主播 UID，此时用绑定目标用户的 `detail.medal_id` 与本账号
牌墙的同 ID 记录解析 `target_id`，名称只作一致性核对，不能单独授予额度。
本账号牌墙只作牌子 ID 目录，不能把其 `wearing_status` 当成他人的佩戴状态。
隐藏、错 UID、目录不完整且无法匹配、多个匹配均为未知；缓存 WBI key 5 分钟、目录
1 小时，不缓存目标用户当前佩戴。拒绝后不自动重签名或重试，平台风险继续暂停消费者。
热评复用固定 `/x/v2/reply` 的热度排序一页，不引入 SDK、签名服务、用户资料爬取或分页遍历；
字段限额、分层和失败语义见 [评论回复契约](bilibili-comment-replies.md)。
文字／转发动态的上下文使用现有 polymer detail GET，并带 `features=itemOpusStyle`。
2026-10-22 对照核对该参数前后的响应：转发原文文字可位于 `orig.modules.module_dynamic.major.opus.summary`，
不能只读 `desc`，也不能把只有图片的旧响应当作原帖确实没有文字；不下载图片或跟转发 URL。

## 依赖选择与新增能力

采用“保持业务适配器，逐个能力接入维护中的上游”的策略。现有 Python SDK 尚有投稿、
封面、编辑、动态与直播调用者，不能把它整体换成 Node 包并假定兼容。评论回复目前
不经该 SDK；其已验收的网页上下文修正也不会因安装新 SDK 自动继承。

新增 B 站能力优先检查上表两个 TypeScript SDK 的对应实现；同语言、接口覆盖完整、
许可与安全契约匹配时，固定依赖版本和锁文件，通过现有适配器接入。只有一小段协议
需要修正时，可在现有适配器实现，保留上游方法、commit 与核对日期的引用。
不要为了未来可能使用的能力加入未使用的运行依赖，也不要让业务代码直接散用多个 SDK。

接入或升级时需要验证的契约：

- ID 必须保留精度；Cookie / CSRF、完整网页 UA、来源字段和目标页面上下文按具体接口核对。
- 凭据只发往固定 B 站目标；不跟随携带凭据的重定向，不把 Cookie、密钥或原始错误体写进日志。
- SDK 的重试、自动凭据刷新、Cookie 写盘和自动选线必须显式审查。写请求无明确回执时保留不明状态，不能自动重发。
- 现有意图日志、队列唯一所有者、公平调度、额度和频率控制仍由本项目持有；模型不能直接调用 SDK 的写接口或系统工具。
- 注入式回归验证字段、线程与失败行为；按开发指南跑聚焦、quick、跨模块时 all。真实读写验收单独获得任务授权。
- 投稿需验证分 P、合集、封面、外部字幕、传输线路与提交回执；编辑需验证不会重建、重复或误删稿件。

## 评论只读诊断

评论内容理解由 `CommentVideoText` 读取平台字幕，参照上述 DSH skill 的 `bili-context.ps1`
和 renmu `video.playerInfo/downloadSubtitle`。采用固定 player v2 及受限 CDN，Cookie 只发往
平台 API；不照搬参考库向字幕 URL 转发 Cookie 或直接下载执行的行为。资源绑定、时长、
浏览器 UA、限额及无字幕降级契约见 [评论回复指南](bilibili-comment-replies.md#视频上下文与事实检索)。

2026-10-24 重新核对 [renmu video 实现](https://github.com/renmu123/biliAPI/blob/master/src/video/index.ts)
和 [yt-dlp Bilibili extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)：
renmu 使用 WBI 签名 player 信息并兼容 `subtitle_url_v2`；yt-dlp 字幕发现直接请求固定
`/x/player/wbi/v2`，不依赖播放流下载。账号只读对照已验证 v2 与 wbi/v2 的 aid/cid 请求
都可返回有效字幕地址。本项目在地址缺失或普通读取失败时有界切换这两个固定 GET，
并兼容备用地址字段；不新增签名服务、视频下载、ASR 或 Cookie 写盘。
列出语言但下载地址为空不证明没有字幕，只表示该次目录不足以读取正文。

```powershell
# 默认匿名，不读取账号配置。只接受已有楼中楼的正整数 oid/root/reply ID。
npm run bilibili:comment-inspect -- --oid <主体ID> --type 1 --root <根评论ID> --reply <回复ID>

# 显式使用本地配置中的账号，同时作匿名与登录对照；不要把 Cookie 放在命令行。
npm run bilibili:comment-inspect -- --oid <主体ID> --type 1 --root <根评论ID> --reply <回复ID> --authenticated --config config/production.json
```

支持业务类型 1/11/12/17；此工具查询指定根楼的子回复，不用于验证根评论自身。
每种身份最多三页、每页 20 条、单次响应 1 MiB、请求超时 10 秒；不重试、不发评、不扣模型额度。
输出只含目标、时间、查询状态、精确回复 ID、作者 UID、平台原始 state/attr 和错误码，
不输出评论正文、Cookie 或配置。`authenticated.visible` 仅说明此登录态可读。

| 状态 | 含义 |
| --- | --- |
| `anonymous.visible` | 这次无 Cookie 的列表返回了精确回复 ID；是当前公开可读的证据，不保证未来审核结果 |
| `not-returned` | 本次列表扫描结束仍未返回；可能已删除、受限或 API 与 UI 展示不同，不能据此自动补发 |
| `truncated` | 达到三页上限仍未定位；不能判定不存在，需有界扩大后另行核对 |
| `unavailable` | HTTP/平台限制、网络失败、异常响应或取消；不是“没有回复” |

退出码 0 表示有有效查询结果，**不等于已公开**；2 表示查询不可用或被页数上限截断；
1 表示参数、配置等启动错误。不要给平台 state/attr 数字赋予未经核实的固定风控语义。

排查顺序：检查任务是否生成 → 发送意图与精确回执 ID → 匿名/登录对照 → 他人网页/App
展示 → 对照当前客户端和上游发送源码。只有得到授权、核对原目标仍在且没有已有公开
回复后，才作一次受控补发；旧回执和补发关联留档，继续使用同一独占队列和发送间隔。
历史终态不会因普通重启或 `--resume` 自动重放。
