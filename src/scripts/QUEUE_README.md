# Whisper 队列管理器使用说明

## 概述

Whisper 队列管理器提供了持久化任务队列功能，支持程序重启后自动恢复未完成的任务。

## 主要功能

- ✅ **持久化存储**: 任务队列保存在 `.whisper_queue.json` 文件中
- ✅ **自动恢复**: 程序重启后自动恢复中断的任务
- ✅ **状态跟踪**: 跟踪每个任务的状态（pending/processing/completed/failed）
- ✅ **队列可视化**: 启动时显示队列状态和待处理任务
- ✅ **自动清理**: 自动清理旧的已完成任务（保留最近100个）

## 任务状态

| 状态 | 说明 |
|------|------|
| `pending` | 等待处理 |
| `processing` | 正在处理 |
| `completed` | 已完成 |
| `failed` | 处理失败 |

## 使用方式

### 自动使用（推荐）

队列管理器已集成到 `enhanced_auto_summary.js` 中，无需手动操作：

1. 程序启动时自动加载队列
2. 检测并恢复中断的任务
3. 处理媒体文件时自动添加到队列
4. 处理完成后自动更新状态

### 手动测试

运行测试脚本验证队列功能：

```bash
cd src/scripts
node test_queue_manager.js
```

测试脚本会：
- 添加测试任务到队列
- 模拟任务状态变化
- 测试重启恢复功能
- 显示队列统计信息

## 队列文件

队列数据保存在 `src/scripts/.whisper_queue.json`：

```json
{
  "lastUpdate": "2026-02-03T14:37:22.000Z",
  "tasks": [
    {
      "id": "1738574242000-录制-25788785-xxx.flv",
      "mediaPath": "D:\\Videos\\录制-25788785-xxx.flv",
      "roomId": "25788785",
      "addedTime": 1738574242000,
      "status": "pending"
    }
  ]
}
```

## 监控队列

### 查看队列文件

```bash
# Windows
type src\scripts\.whisper_queue.json

# Linux/Mac
cat src/scripts/.whisper_queue.json
```

### 查看队列状态

程序启动时会自动显示：

```
📋 加载队列: 3 个任务
   待处理: 2, 处理中: 1, 已完成: 0, 失败: 0

📊 队列状态:
   总任务数: 3
   待处理: 2
   处理中: 1
   已完成: 0
   失败: 0

📋 待处理任务:
   1. 录制-25788785-xxx.flv (等待 5.2 分钟)
   2. 录制-25788785-yyy.flv (等待 2.1 分钟)
```

## 重启恢复流程

1. **程序启动**
   - 自动加载 `.whisper_queue.json`
   - 检测 `processing` 状态的任务

2. **恢复中断任务**
   - 将 `processing` 状态重置为 `pending`
   - 显示恢复的任务列表

3. **继续处理**
   - 按 `whisperPriority` 从高到低处理所有 `pending` 任务，同优先级按添加顺序处理
   - 更新任务状态并保存

## 优先级和图片 API 防护

- 岁己房间 `25788785` 在队列代码里有默认兜底优先级 `100`，防止配置迁移或重构时漏配后退化为普通任务。需要调整时，在 `config/production.json` 的 `roomSettings.25788785.whisperPriority` 显式覆盖。
- AI 漫画生成阶段会在 Whisper 槽位释放后继续后台执行。为避免后台任务并发打图片 API，漫画生成默认使用全局并发槽 `1`，并且同一个 `_COMIC_FACTORY.png` 默认使用输出锁；不要关闭 `ai.comic.outputLockEnabled`，除非确认不会并发处理同一高亮。

## 注意事项

1. **不要删除队列文件**: `.whisper_queue.json` 包含重要的任务信息
2. **安全重启**: 可以随时重启程序，任务不会丢失
3. **手动清理**: 如需清空队列，删除 `.whisper_queue.json` 文件
4. **磁盘空间**: 队列文件很小（通常 < 100KB），不会占用大量空间

## 故障排除

### 队列文件损坏

如果队列文件损坏，程序会：
- 显示警告信息
- 创建新的空队列
- 继续正常运行

### 任务卡住

如果任务长时间处于 `processing` 状态：
1. 检查 Whisper 锁文件 `.whisper_lock`
2. 查看进程日志确认是否在处理
3. 如确认卡死，可重启程序自动恢复

### 清空队列

```bash
# 删除队列文件（谨慎操作）
rm src/scripts/.whisper_queue.json
```

## API 参考

### queueManager.addTask(mediaPath, roomId)

添加任务到队列

- **参数**:
  - `mediaPath`: 媒体文件路径
  - `roomId`: 房间ID（可选）
- **返回**: 任务对象

### queueManager.markProcessing(taskId)

标记任务为处理中

### queueManager.markCompleted(taskId)

标记任务为已完成

### queueManager.markFailed(taskId, error)

标记任务为失败

### queueManager.recoverInterruptedTasks()

恢复中断的任务

### queueManager.printStatus()

显示队列状态

### queueManager.getStats()

获取队列统计信息

## 更多信息

详细的优化说明请参考：[docs/whisper-queue-optimization.md](../../docs/whisper-queue-optimization.md)
