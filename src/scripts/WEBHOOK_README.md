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
npm install pm2 -g
pm2 start src/scripts/webhook_server.js --name "ddtv-watcher"
pm2 startup  # 设置开机自启 (Windows)
pm2 save
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
