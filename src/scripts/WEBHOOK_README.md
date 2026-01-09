# DDTV 自动化 Webhook 服务

## 概述

这个 Node.js Webhook 服务用于监听 DDTV 的录制完成事件，自动触发弹幕转摘要的处理流水线。

## 架构

```
DDTV 5 → HTTP POST /ddtv → Node.js Webhook 服务 → PowerShell auto_summary.ps1 → 处理完成
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

服务将在 `http://localhost:3000/ddtv` 监听请求。

## DDTV 配置

1. 打开 DDTV 客户端
2. 进入设置 → Webhook 配置
3. 设置 Webhook URL: `http://127.0.0.1:3000/ddtv`
4. 勾选 "文件下载完成" 或 "录制完成" 事件
5. 保存配置

## Webhook Payload 格式

DDTV 发送的 Webhook 通常包含以下字段：

```json
{
  "EventType": "FileDownloadComplete",
  "VideoFile": "/path/to/video.mp4"
}
```

如果字段名不同，服务会在控制台输出完整的 payload，你可以据此调整代码中的字段名。

## 测试

运行测试脚本验证服务是否正常：

```bash
node src/scripts/test_webhook.js
```

## 日志输出

服务会输出详细的处理日志：

- `[时间] 收到 Webhook:` - 显示收到的完整 payload
- `-> 检测到视频文件:` - 显示找到的视频路径
- `-> 检测到同名 XML:` - 如果找到对应的弹幕文件
- `[PS]` - PowerShell 脚本的输出
- `-> 流水线执行完毕，退出码:` - 处理结果

## 故障排除

### 常见问题

1. **服务启动失败**
   - 检查端口 3000 是否被占用
   - 确认 express 已正确安装

2. **PowerShell 脚本找不到**
   - 确认 `auto_summary.ps1` 在 `src/scripts/` 目录中
   - 检查相对路径是否正确

3. **Python/Node 脚本找不到**
   - auto_summary.ps1 中的 `$PyRoot` 路径可能需要调整
   - 考虑改为绝对路径

4. **Webhook 字段名不匹配**
   - 运行一次真正的 DDTV webhook
   - 查看控制台输出的 payload
   - 调整 `webhook_server.js` 中的字段名

### 日志位置

- Webhook 服务日志：控制台输出
- PowerShell 脚本日志：通过 webhook 服务转发显示

## 停止服务

```bash
# 如果使用 PM2
pm2 stop ddtv-watcher
pm2 delete ddtv-watcher

# 直接杀死进程
# 找到 node webhook_server.js 的进程并终止
```
