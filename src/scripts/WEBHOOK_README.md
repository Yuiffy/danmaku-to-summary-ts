# 录播姬自动化 Webhook 服务

## 概述

这个 Node.js Webhook 服务用于监听 DDTV 和 mikufans录播姬的录制完成事件，自动触发弹幕转摘要的处理流水线。支持音频文件处理和可配置的超时参数。

## 新功能亮点

1. **修复DDTV超时问题**：SaveBulletScreenFile事件等待时间从3秒增加到60秒，避免文件未生成就跳过处理
2. **支持mikufans录播姬**：新增独立端点 `/mikufans`，支持BililiveRecorder格式的webhook
3. **音频录制支持**：支持为特定房间配置纯音频录制，节省存储空间
4. **可配置参数**：所有超时参数和路径均可通过配置文件调整

## 架构

```
DDTV 5 → HTTP POST /ddtv → Node.js Webhook 服务 → auto_summary.js → 处理完成
mikufans录播姬 → HTTP POST /mikufans ↗
```

## 安装和设置

### 1. 安装依赖

```bash
pnpm add express
```

### 2. 启动服务

```bash
# 从项目根目录启动
node src/scripts/webhook_server.js

# 或者使用 PM2 后台运行 (推荐)
## 方案一：使用 PM2（最推荐，专业、稳定）
## 优点：服务崩溃自动重启、后台运行无黑框、日志管理方便。

### 全局安装 PM2 和 Windows 自启插件
打开你的终端（PowerShell 或 Git Bash），运行：

```bash
pnpm add -g pm2 pm2-windows-startup
```

### 安装自启服务
运行以下命令，这会告诉 Windows 注册一个开机启动项：

```bash
pm2-startup install
```

### 启动你的服务
进入你的项目目录，使用 PM2 启动脚本：

```bash
cd D:\workspace\myrepo\danmaku-to-summary-ts

# 直接启动 JS 文件，命名为 ddtv-hook
pm2 start src/scripts/webhook_server.js --name ddtv-hook
```

### 保存当前运行列表
这一步至关重要，它会把当前正在运行的服务"冻结"并保存，下次开机 PM2 就会自动恢复这个列表：

```bash
pm2 save
```

搞定！ 下次重启电脑，PM2 会在后台自动拉起这个服务。

查看日志命令：`pm2 logs ddtv-hook`

停止服务命令：`pm2 stop ddtv-hook`

重启服务命令：`pm2 restart ddtv-hook`
```

服务将在以下端点监听请求：
- DDTV: `http://localhost:15121/ddtv`
- mikufans: `http://localhost:15121/mikufans`

## 配置说明

### 配置文件位置
`src/scripts/config.json`

### 默认配置
如果`config.json`文件不存在，将使用以下默认配置：
```json
{
  "audioRecording": {
    "enabled": true,
    "audioOnlyRooms": [],
    "audioFormats": [".m4a", ".aac", ".mp3", ".wav", ".ogg", ".flac"],
    "defaultFormat": ".m4a"
  },
  "timeouts": {
    "fixVideoWait": 60000,
    "fileStableCheck": 30000,
    "processTimeout": 1800000
  },
  "recorders": {
    "ddtv": {
      "enabled": true,
      "endpoint": "/ddtv"
    },
    "mikufans": {
      "enabled": true,
      "endpoint": "/mikufans",
      "basePath": "D:/files/videos/DDTV录播"
    }
  }
}
```

### 创建配置文件
如果需要自定义配置，创建`src/scripts/config.json`文件并覆盖需要的配置项即可。配置采用合并策略，未指定的配置项将使用默认值。

### 配置说明

#### 音频录制配置
- `audioOnlyRooms`: 数组，指定哪些房间ID录制纯音频（例如：`[12345, 67890]`）
- `audioFormats`: 支持的音频文件格式
- `defaultFormat`: 默认音频格式

#### 超时配置
- `fixVideoWait`: 等待fix视频文件生成的最大时间（毫秒），默认30秒
- `fileStableCheck`: 文件稳定性检查等待时间，默认30秒
- `processTimeout`: 处理进程超时时间，默认30分钟

#### 录播姬配置
- `mikufans.basePath`: mikufans录播姬的录制文件存储根目录

## DDTV 配置

1. 打开 DDTV 客户端
2. 进入设置 → Webhook 配置
3. 设置 Webhook URL: `http://127.0.0.1:15121/ddtv`
4. 勾选 "文件下载完成" 或 "录制完成" 事件
5. 保存配置

## mikufans录播姬配置

1. 打开 mikufans录播姬 (BililiveRecorder)
2. 进入设置 → Webhook
3. 添加新的 Webhook URL: `http://127.0.0.1:15121/mikufans`
4. 选择要发送的事件类型（推荐：`FileOpening`, `FileClosed`）
5. 保存配置

## Webhook Payload 格式

### DDTV 格式示例
```json
{
  "cmd": "SaveBulletScreenFile",
  "code": 40101,
  "data": {
    "DownInfo": {
      "DownloadFileList": {
        "DanmuFile": ["path/to/danmu.xml"],
        "CurrentOperationVideoFile": "path/to/video_original.mp4"
      }
    }
  }
}
```

### mikufans录播姬格式示例
```json
{
  "EventType": "FileOpening",
  "EventTimestamp": "2026-01-14T01:29:16.3983903+08:00",
  "EventId": "66e7b5d6-e844-40cc-b1ee-94947d4d85e5",
  "EventData": {
    "SessionId": "add80566-c420-4f00-9393-bd55d1cd218c",
    "RelativePath": "80397_阿梓从小就很可爱/2026_01_14/录制-80397-20260114-012916-397-训练！.flv",
    "RoomId": 80397,
    "Name": "阿梓从小就很可爱",
    "Title": "训练！"
  }
}
```

## 音频录制功能

### 启用音频录制
1. 编辑 `src/scripts/config.json`
2. 在 `audioOnlyRooms` 数组中添加要录制音频的房间ID
3. 重启webhook服务

### 示例配置
```json
{
  "audioRecording": {
    "enabled": true,
    "audioOnlyRooms": [12345, 67890],
    "audioFormats": [".m4a", ".aac"],
    "defaultFormat": ".m4a"
  }
}
```

### 注意事项
- 音频录制需要在录播姬中单独配置相应房间的录制格式
- 目前支持 `.m4a`, `.aac`, `.mp3`, `.wav`, `.ogg`, `.flac` 格式
- 音频文件同样会进行ASR转字幕处理

## 日志输出

服务会输出详细的处理日志：

- `📅 时间:` - 事件发生时间
- `📨 事件:` - 事件类型（DDTV cmd 或 mikufans EventType）
- `👤 主播:` - 主播名称和房间ID
- `📦 完整数据结构:` - 完整的webhook payload
- `⏳ 等待文件生成/稳定:` - 文件等待状态
- `✅ 发现文件:` - 文件找到确认
- `🚀 启动处理流程:` - 开始处理
- `[PS]` - 处理脚本的输出
- `🏁 流程结束:` - 处理完成

## 故障排除

### 常见问题

1. **服务启动失败**
   - 检查端口 15121 是否被占用
   - 确认 express 已正确安装

2. **DDTV fix视频超时**
   - 检查 `fixVideoWait` 配置值是否足够（建议60秒以上）
   - 查看DDTV日志确认fix视频生成时间

3. **mikufans文件找不到**
   - 检查 `basePath` 配置是否正确
   - 确认 `RelativePath` 拼接后的完整路径存在

4. **音频文件不支持**
   - 检查 `audioFormats` 配置是否包含所需格式
   - 确认录播姬配置的音频格式在支持列表中

5. **Webhook字段名不匹配**
   - 运行一次真正的webhook
   - 查看控制台输出的完整payload
   - 调整代码中的字段名

### 日志位置

- Webhook服务日志：控制台输出或PM2日志
- 处理脚本日志：通过webhook服务转发显示

## 停止服务

```bash
# 如果使用 PM2
pm2 stop ddtv-hook
pm2 delete ddtv-hook

# 直接杀死进程
# 找到 node webhook_server.js 的进程并终止
```

## 更新日志

### v2.0 增强版
- 修复DDTV SaveBulletScreenFile超时问题
- 新增mikufans录播姬webhook支持
- 添加音频录制配置功能
- 支持可配置的超时参数
- 改进文件稳定性检查逻辑
- 增强日志输出和错误处理

### v1.0 基础版
- 基础DDTV webhook支持
- 自动触发弹幕转摘要流水线
- 文件去重和稳定性检查
