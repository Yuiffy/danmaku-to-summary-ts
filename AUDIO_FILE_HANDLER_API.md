# 音频文件处理接口 API 文档

## 概述

新增了 **AudioFileHandler** 接口，用于处理音频文件。该接口能够：

1. 从文件名中自动提取直播间ID和其他信息
2. 自动查找对应的XML弹幕文件
3. 启动完整的处理流程（音频处理、AI生成、漫画生成等）

## 核心特性

- ✅ 自动从文件名解析直播间ID
- ✅ 智能查找关联的XML文件
- ✅ 文件稳定性检查
- ✅ 重复处理防护
- ✅ 完整的日志记录
- ✅ 支持多种音频格式（m4a、mp3、wav、aac、flac）

## API 端点

### 处理音频文件

**端点：** `POST /handle-file`

**请求体：**
```json
{
  "filePath": "录制-1741667419-20260116-192814-176-浣熊咖啡厅正式营业！.m4a"
}
```

**响应示例（成功）：**
```json
{
  "success": true,
  "message": "处理流程已启动",
  "filePath": "D:\\files\\videos\\DDTV录播\\1741667419_十六萤Izayoi\\2026_01_16\\录制-1741667419-20260116-192814-176-浣熊咖啡厅正式营业！.m4a",
  "xmlPath": "D:\\files\\videos\\DDTV录播\\1741667419_十六萤Izayoi\\2026_01_16\\录制-1741667419-20260116-192814-176-浣熊咖啡厅正式营业！.xml",
  "roomId": "1741667419",
  "timestamp": "20260116 192814",
  "title": "浣熊咖啡厅正式营业！"
}
```

**响应示例（失败）：**
```json
{
  "success": false,
  "error": "无法从文件名中提取信息，文件名格式应为: 录制-<直播间ID>-<时间>-<标题>.m4a",
  "filePath": "invalid_filename.m4a"
}
```

## 文件名格式

文件名必须遵循以下格式：
```
录制-<直播间ID>-<日期>-<时间>-<序号>-<标题>.<扩展名>
```

### 格式说明

| 部分 | 说明 | 示例 |
|------|------|------|
| 前缀 | 必须为"录制" | 录制 |
| 直播间ID | 纯数字 | 1741667419 |
| 日期 | YYYYMMDD格式 | 20260116 |
| 时间 | HHMMSS格式 | 192814 |
| 序号 | 任意数字 | 176 |
| 标题 | 直播标题 | 浣熊咖啡厅正式营业！ |
| 扩展名 | 音频格式 | .m4a |

### 有效的文件名示例

```
录制-1741667419-20260116-192814-176-浣熊咖啡厅正式营业！.m4a
录制-25788785-20260115-194314-692-找你有事！速来.mp3
录制-1713548468-20260116-195937-155-第一次任务开始啦~.wav
```

## 工作流程

### 1. 文件名解析

从文件名中提取以下信息：
- `roomId`: 直播间ID
- `timestamp`: 时间戳（格式: YYYYMMDD HHMMSS）
- `title`: 直播标题

### 2. 文件验证

- 检查文件是否存在
- 检查是否已在处理队列中（重复处理防护）
- 等待文件稳定（大小不再变化）

### 3. XML文件查找

按以下优先级查找XML文件：
1. 同目录下与音频文件同名的XML文件
2. 同目录下以直播间ID命名的XML文件
3. 其他包含直播间ID或标题的XML文件

### 4. 处理启动

启动处理脚本 `enhanced_auto_summary.js`，传入：
- 音频文件路径
- XML弹幕文件路径（如果找到）
- 环境变量 `ROOM_ID`

## 支持的音频格式

- `m4a` - MPEG-4 Audio
- `mp3` - MPEG Layer III
- `wav` - Waveform Audio
- `aac` - Advanced Audio Coding
- `flac` - Free Lossless Audio Codec

## 错误处理

### 常见错误

| 错误消息 | 原因 | 解决方案 |
|---------|------|--------|
| 无法从文件名中提取信息 | 文件名格式不符合要求 | 检查文件名是否包含直播间ID和时间信息 |
| 文件不存在 | 文件路径不正确或文件已删除 | 检查文件路径和文件是否存在 |
| File already being processed | 文件正在处理中 | 等待处理完成后再提交 |
| File stability check failed | 文件仍在写入中 | 等待文件完全写入后再提交 |

## 日志输出

处理过程中，系统会输出详细的日志信息：

```
[INFO] AudioFileHandler: 
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
[INFO] AudioFileHandler: 📅 时间: 2026/1/16 22:20:26
[INFO] AudioFileHandler: 📨 事件: 音频/视频文件处理
[INFO] AudioFileHandler: ✓ 从文件名中提取信息成功
[INFO] AudioFileHandler: ✓ 文件存在验证成功
[INFO] AudioFileHandler: ✓ 文件稳定性验证成功
[INFO] AudioFileHandler: ✓ 找到对应的XML文件
[INFO] AudioFileHandler: ✓ 处理流程已启动
```

## 使用示例

### 使用 curl

```bash
curl -X POST http://localhost:12523/handle-file \
  -H "Content-Type: application/json" \
  -d '{"filePath":"录制-1741667419-20260116-192814-176-浣熊咖啡厅正式营业！.m4a"}'
```

### 使用 Python

```python
import requests
import json

url = "http://localhost:12523/handle-file"
payload = {
    "filePath": "录制-1741667419-20260116-192814-176-浣熊咖啡厅正式营业！.m4a"
}

response = requests.post(url, json=payload)
result = response.json()

print(f"处理成功: {result['success']}")
if result['success']:
    print(f"直播间ID: {result['roomId']}")
    print(f"XML文件: {result['xmlPath']}")
```

### 使用 JavaScript/Node.js

```javascript
const http = require('http');

const data = JSON.stringify({
  filePath: '录制-1741667419-20260116-192814-176-浣熊咖啡厅正式营业！.m4a'
});

const options = {
  hostname: 'localhost',
  port: 12523,
  path: '/handle-file',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  let responseData = '';
  
  res.on('data', (chunk) => {
    responseData += chunk;
  });
  
  res.on('end', () => {
    const result = JSON.parse(responseData);
    console.log('处理结果:', result);
  });
});

req.on('error', (error) => {
  console.error('请求失败:', error);
});

req.write(data);
req.end();
```

## 处理流程详解

接收到请求后，系统会执行以下步骤：

```
1. 验证请求格式
   ↓
2. 从文件名提取信息 (roomId, timestamp, title)
   ↓
3. 验证文件存在
   ↓
4. 检查重复处理（DuplicateProcessorGuard）
   ↓
5. 标记为处理中
   ↓
6. 等待文件稳定（FileStabilityChecker）
   ↓
7. 查找对应的XML文件
   ↓
8. 启动处理子进程 (enhanced_auto_summary.js)
   ├─ 音频处理 (ffmpeg)
   ├─ 弹幕融合 (do_fusion_summary.js)
   ├─ AI文本生成
   └─ AI漫画生成
   ↓
9. 标记为处理完成
   ↓
10. 返回成功响应
```

## 集成建议

### 推荐的集成方式

1. **文件监听器集成**
   - 监听录制目录
   - 文件完全写入后自动调用接口

2. **批量处理**
   - 收集多个音频文件
   - 通过队列逐个提交

3. **错误重试**
   - 实现重试机制处理暂时性错误
   - 记录失败的文件供后续处理

## 性能考虑

- **超时配置**：默认30分钟（可在配置文件调整）
- **并发处理**：支持多个文件同时处理
- **资源占用**：取决于音频文件大小和处理复杂度

## 故障排查

### 问题：接口无响应

**排查步骤：**
1. 检查Webhook服务是否运行
2. 验证端口 12523 是否开放
3. 检查防火墙设置

### 问题：文件标记为已在处理中

**原因：** 可能上一次处理未完成或服务异常退出

**解决：** 等待处理完成或重启服务

### 问题：未找到XML文件

**原因：** XML文件与音频文件不在同一目录或命名不匹配

**解决方案：**
1. 将XML文件放在同一目录
2. 确保XML文件名包含直播间ID或相关标题
3. 检查路径是否包含中文字符导致的编码问题

## 版本信息

- **API版本**: 1.0.0
- **处理器**: AudioFileHandler
- **端点路径**: /handle-file
- **支持格式**: m4a, mp3, wav, aac, flac
