# 直播弹幕投票机器人

**推荐使用 [Yuiffy 的改版 mikufans / BililiveRecorder](https://github.com/Yuiffy/BililiveRecorder) 转发弹幕。**需要使用包含 `LocalDanmakuRelay` 和多房间转发功能的构建；官方原版和 fork 的旧安装包不一定提供这个接口。

如果不依赖改版 mikufans，独立运行需要使用 B 站直连来源。每个被独立监听的房间都会增加一条弹幕连接；与录播软件重复监听、多房间同时连接或频繁重连，都可能增加风控风险。推荐让 mikufans 维护已有连接，投票机器人仅通过一条本机 WebSocket 接收转发；这不会替录播姬新增 B 站连接。模式由配置显式选择，不会在转发断开后自动改为直连。

## 多房间模式（推荐）

录播姬 EXE 同目录的 `local-danmaku-relay.json` 使用 `"roomSelection": "auto-record"`（替代单房间 `roomId`），并设置 `enabled`、`port`、`token`。范围跟随录播姬有效的 `AutoRecord` 设置：勾选自动录制的房间纳入，取消勾选或删除房间立即移除，不替用户勾选其他房间。

投票机器人配置参考 `src/services/live-vote/config.recorder.example.json`：

```json
{
  "source": "recorder",
  "rooms": "auto-record",
  "recorderSocketUrl": "ws://127.0.0.1:17896/api/local/danmaku",
  "globalAdminUids": ["14279"],
  "botUid": "412141275",
  "maxMessageChars": 40
}
```

`14279` 为带鱼 UID，`412141275` 为鹿饼 UID；其他部署请改成自己的账号。无需手工维护各主播名单：本房间的主播 UID 来自录播姬已获取的房间信息，仅能发起/取消自己房间的投票；`globalAdminUids` 中的带鱼可在所有已纳入房间操作。房管和其他房间的主播不自动获得权限。主播 UID 尚未确定或弹幕断开时，不启动该房间投票。

各房间计时、选项和投票人去重互相独立；同一个观众可在不同房间各投一票。房间被移除、取消自动录制、主播身份变化或连接中断，会取消该房间投票并丢弃其待发公告；本机 WebSocket 断开会取消所有投票。所有房间共用发送队列，账号发言间隔至少 3 秒，多房间同时投票时播报可能排队延后，计票仍按各自截止时间结束。

认证可通过环境变量配置，也可显式提供绝对路径 `recorderSettingsFile` 读取录播姬转发配置的 token；真实发送可显式提供 `credentialConfigPath`，读取其中的 `bilibili.cookie`，环境变量 `BILIBILI_VOTE_COOKIE` 优先。程序不会自动寻找生产凭据。`statePath` 可设为绝对路径，输出当前房间列表和连接状态，不含凭据。配置文件路径和凭据属于本机配置，不提交 Git。

多房间协议：`/api/local/danmaku` 首先发送 `rooms` 完整快照（`version: 1`，每房间含 `roomId`、`ownerUid` 字符串、`connected`），随后发送带 `roomId` 的 `danmaku` 帧；房间增删、自动录制开关、主播 UID 或连接状态变化会推送新快照。单房间端点 `/api/local/danmaku/{roomId}` 仍可使用，但只能连接当前纳入范围内的房间。

## 现有方案取舍

| 项目 | 已公开的定位 | 对本需求的取舍 |
| --- | --- | --- |
| [LiveLink](https://github.com/Mr-Salticidae/livelink) | README 自述为 Windows/Electron 主播助手，含 2-6 选项、实时柱状图和 OBS 展示 | 已有较完整的可视化体验；若只需 OBS 投票可优先试用。这里仍做轻量弹幕口令、UID 授权和本机录播姬共用来源。README 的功能状态不代表我们已独立验收。 |
| [弹幕姬投票基](https://github.com/mittwillson/danmuji-plugin-tpj) | 弹幕姬的投票插件 | 依赖弹幕姬宿主，不是此仓库可直接运行的独立机器人。 |
| [DanmakuVote](https://github.com/Decision2016/DanmakuVote) | B 站弹幕投票驱动 Minecraft/Bukkit 事件 | 证明弹幕投票玩法可行，但输出是游戏内事件，而非直播间定时播报。 |
| [JVote](https://github.com/Xinrea/JVote) | H5 投票展示项目 | 可参考展示方式；不替代本需求的授权口令和录播姬消息转发。 |

## 设计与边界

- 默认独立监听一个 B 站长房间号 (`source` 省略或设为 `bilibili`)。这是只读的直播弹幕连接，和录播姬各占一条连接；不自动改用录播姬或 XML。依赖 `blive-message-listener` 的 UID、文本与连接事件，不自行实现弹幕协议。
- 直连投票需要登录监听：设置 `BILIBILI_VOTE_LISTEN_COOKIE`，或复用显式设置的 `BILIBILI_VOTE_COOKIE`。监听 Cookie 须含 `SESSDATA`、`DedeUserID`、`buvid3`，HTTP 与弹幕握手使用同一个账号及已有设备标识。匿名连接虽然能收到文本，观众 UID 可能全部为 0，不能用于授权或每人一票，因此 CLI 缺少监听凭据时直接报错；dry-run 同样需要监听凭据，但不会发言。
- `source: "recorder"` 连接本机 BililiveRecorder WPF 转发，复用该进程已有的弹幕连接。服务只绑定 `127.0.0.1`，需要房间匹配和至少 16 位的随机字母数字 token；转发 UID、文本与收到时间，不包含 Cookie。这个模式需要部署并重启**改过源码的** WPF 录播姬；当前运行进程不会因为源码编译自动获得转发功能。
- `source: "xml"` 追踪录播姬弹幕 XML，仅适用于本机落盘且时间戳/UID 可用的场景。首次从文件末尾读，切换文件后从新文件开头读；来源停止更新时它无法识别断线，不推荐无人值守发言。
- 直连显式传入 User-Agent、Referer、Origin 和 Accept，避免 `tiny-bilibili-ws 1.1.0` 请求头合并时丢失默认 User-Agent。`getDanmuInfo` 返回 `-352` 只说明该次接口请求被拒绝，不能单凭它判断账号被封、整个 IP 被限制或需要验证码；应先核对请求头、签名和登录/设备状态。启动握手失败后机器人停止自动重试并以非零状态退出；录播姬自身的连接也受 B 站策略约束，复用不能绕过平台限制。
- 默认 **dry-run**：只打印拟发送文字。真实发弹幕必须加 `--send` 且提供独立 `BILIBILI_VOTE_COOKIE`，其中 `DedeUserID` 必须与配置 `botUid` 一致；切勿提交 Cookie。发送走 B 站直播发送接口，可能因账号资格、字数、频率或接口策略失败；失败就停止机器人，不补发或无限重试。

## 运行

需要 Node.js 22+；依赖用本项目的 pnpm lockfile 安装。先复制 `src/services/live-vote/config.example.json` 为本地 JSON 配置，换成实际**长房间号**和授权发起人的 UID，`botUid` 是鹿饼账号 UID。`source` 默认 `bilibili`，不需要录播姬端口。

启动前将监听 Cookie 注入 `BILIBILI_VOTE_LISTEN_COOKIE`（仅接收），或将同一账号 Cookie 注入 `BILIBILI_VOTE_COOKIE`（接收；加 `--send` 后才发送）。凭据不写进示例配置，也不会自动从本项目生产配置读取。

```powershell
pnpm install --frozen-lockfile
npm run build
npm run vote:run -- --config temp/live-vote.json
```

确认来源、UID 和输出后，才配置 `BILIBILI_VOTE_COOKIE` 并在命令末尾加 `--send`。生产运行请设置进程管理器和独立日志；不要在日志中输出 Cookie。不要拿现有录播/投稿 Cookie 当默认发言凭证。

本机转发模式的配置示例：

```json
{
  "roomId": "628684",
  "authorizedUids": ["123456789", "987654321"],
  "botUid": "1122334455",
  "source": "recorder",
  "recorderSocketUrl": "ws://127.0.0.1:17896/api/local/danmaku/628684",
  "maxMessageChars": 40
}
```

推荐在改版 WPF 录播姬 EXE 同目录放置 `local-danmaku-relay.json`，这样手工或守护程序重启均可启用：

```json
{
  "enabled": true,
  "roomId": 628684,
  "port": 17896,
  "token": "替换为至少16位随机英文字母或数字"
}
```

这是兼容的单房间配置，房间必须已配置在录播姬中；多房间部署使用前文的 `roomSelection`。token 属于本机凭据，不要提交 Git。启动投票机器人前，将文件的 `token` 读入 `BILILIVE_LOCAL_DANMAKU_TOKEN`，或显式配置 `recorderSettingsFile`；单房间的 `roomId` 和 URL 中的房间号须与文件一致。环境变量 `BILILIVE_LOCAL_DANMAKU_ROOM_ID`、`BILILIVE_LOCAL_DANMAKU_TOKEN` 和可选 `BILILIVE_LOCAL_DANMAKU_PORT` 仍可覆盖文件配置。文件配置在进程启动时读取，修改后需重启录播姬；多房间模式下在 UI 增删房间和切换自动录制会即时更新，无需重启。

转发器只订阅已有房间的弹幕和连接状态事件，不主动开启录制、额外连接 B 站或回放历史消息。未开播且录播姬没有监听时，WebSocket 握手仍可成功，但状态帧会是 `connected: false`；不能将本机端口已连接当成 B 站弹幕已连接。

WebSocket 以 token 作为子协议认证。连接后先发 `{"type":"status","roomId":628684,"connected":false}`；普通弹幕格式为 `{"type":"danmaku","roomId":628684,"uid":"123","text":"1","sentAt":1790259000000}`，时间是录播姬接收时的毫秒时间戳。每个客户端队列最多 256 条，积压溢出时断开该客户端，避免丢票后继续输出结果。

XML 回退示例：`"source": "xml", "recorderRoot": "D:\\recordings"`，目录必须是绝对路径。

## 弹幕规则

- 授权 UID 发 `#投票 1.复联2 2.法环`，默认 30 秒；`#投票60 1复联2 2法环` 或 `#投票 60 1、复联2 2、法环` 设置 60 秒。支持 2～9 个选项，必须从 1 连续编号，时长 30-120 秒，选项名不超过 16 个 Unicode 字符。单独 `#投票60` 不会启动，因为没有选项。
- 三选项示例：`#投票 1复联2 2老头环 3美队3`。选项以“空格 + 编号”分隔，片名内数字直接跟随名称（如 `复联2`）；数字开头的名字可写成 `1.2048`。空选项、跳号、重复编号或超出 9 项会被拒绝，不会把后续编号吞进前一个名称。
- 默认每条最多 **40 字**，开始说明、票型、结果会尽量合并；超过上限才按选项拆分，保留名称和票数。可通过 `maxMessageChars` 配置为 20～40，具体上限取决于发送账号权限。每 10 秒更新一次票型，到点后留 3 秒接收时间戳在截止前的延迟消息，最后公布票数和胜者。
- 上述三选项会播报 `投票30秒，发序号：1.复联2 2.老头环 3.美队3`；中途例如 `票型：1.复联2:0票 2.老头环:1票 3.美队3:0票`；结束例如 `结束：1.复联2:0票 2.老头环:1票 3.美队3:0票 老头环胜`。平票和无人投票会明确标注。
- 观众的 `1`、`1111`、全角 `１１１` 都算 1；`333` 算 3，以此类推，序号不能超过本次选项数。每 UID 只计**第一张**有效票，不接受夹杂其他文字，鹿饼自己的 UID 不参与。先发 `2` 再发 `3` 不会改票。断线时取消当前投票且不宣布不完整结果；重连后须重新发起。授权 UID 可发 `#取消投票`。
- 发弹幕节流至少 3 秒。文字在排队期间若断线/取消，会跳过尚未发送的旧公告；已经发到 B 站的消息无法撤回。票数只保留内存，重启或断线后不恢复。
- `#结束投票`：由本房间主播或全局管理员（带鱼）提前结束本房间投票，立即按已收到的有效票数结算，公布带选项名称的结果，不再等待原倒计时或 3 秒延迟窗口；后续票不再计入，原定到点也不会重复公布。待发的旧票型会跳过，结果仍遵守发送间隔。没有进行中的投票时不回应。
- `#取消投票`：同样需要管理权限，但只宣布取消，不公布统计结果。两种操作都只影响命令所在房间。

## 参考

- B 站[直播开放平台文档](https://open-live.bilibili.com/document/)：正式互动玩法需走平台授权和对应接入流程；这份简版目前使用社区直播弹幕监听和直播消息发送接口，非官方开放平台应用。
- [`blive-message-listener`](https://github.com/ddiu8081/blive-message-listener)：开源 TypeScript 监听库，提供 UID/文本解析和监听事件；其 README 提醒短房间号、登录状态影响消息信息。
- [`JVote`](https://github.com/Xinrea/JVote)：另一种直播 H5 投票展示项目，可参考展示体验；此实现侧重弹幕内的口令、授权与结果播报。
- [Yuiffy 的 BililiveRecorder fork](https://github.com/Yuiffy/BililiveRecorder)：推荐的改版 mikufans 来源，须使用包含本机转发功能的版本。原项目为 [BililiveRecorder](https://github.com/BililiveRecorder/BililiveRecorder)，转发修改需与机器人独立编译、测试和部署。
