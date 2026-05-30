# Whisper 队列管理 - 快速参考

## 📋 核心功能

✅ **持久化队列** - 任务保存到文件，重启不丢失  
✅ **自动恢复** - 程序重启后自动继续处理  
✅ **状态跟踪** - 实时跟踪任务处理状态  
✅ **可视化** - 启动时显示队列状态  

## 🔄 任务状态

| 状态 | 图标 | 说明 |
|------|------|------|
| `pending` | ⏳ | 等待处理 |
| `processing` | 🔄 | 正在处理 |
| `completed` | ✅ | 已完成 |
| `failed` | ❌ | 处理失败 |

## 📁 重要文件

```
src/scripts/
├── .whisper_queue.json          # 队列数据文件（自动生成）
├── .whisper_lock                # Whisper 锁文件
├── whisper_queue_manager.js     # 队列管理器
├── test_queue_manager.js        # 测试脚本
└── QUEUE_README.md              # 详细使用说明
```

## 🚀 快速开始

### 正常使用（自动）

```bash
# 程序会自动管理队列，无需额外操作
node src/scripts/enhanced_auto_summary.js video.flv
```

### 测试队列功能

```bash
# 运行测试脚本
node src/scripts/test_queue_manager.js
```

### 查看队列状态

```bash
# Windows
type src\scripts\.whisper_queue.json

# Linux/Mac
cat src/scripts/.whisper_queue.json
```

## 💡 使用场景

### 场景1: 正常处理
```
录制完成 → 添加到队列 → 处理 → 完成
```

### 场景2: 多个任务排队
```
视频1 → 处理中
视频2 → 等待中
视频3 → 等待中
```

### 场景3: 程序重启恢复
```
处理中断 → 重启程序 → 自动恢复 → 继续处理
```

## 🔍 监控命令

```bash
# 查看队列文件
cat src/scripts/.whisper_queue.json

# 查看锁文件
cat src/scripts/.whisper_lock

# 查看处理日志
pm2 logs danmaku-to-summary --lines 50
```

## ⚙️ 队列管理

### 查看队列统计
程序启动时自动显示：
```
📊 队列状态:
   总任务数: 5
   待处理: 2
   处理中: 1
   已完成: 2
   失败: 0
```

### 清空队列（谨慎）
```bash
# 删除队列文件
rm src/scripts/.whisper_queue.json
```

## 🛡️ 安全特性

- ✅ **重启安全**: 可随时重启，任务不丢失
- ✅ **容错处理**: 队列文件损坏时自动重建
- ✅ **自动清理**: 保留最近100个已完成任务
- ✅ **锁机制**: 防止并发处理导致冲突

## 📊 队列文件示例

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

## 🔧 故障排除

### 问题: 任务卡在 processing 状态
**解决**: 重启程序，会自动重置为 pending

### 问题: 队列文件损坏
**解决**: 删除文件，程序会自动创建新队列

### 问题: 想清空所有任务
**解决**: 删除 `.whisper_queue.json` 文件

## 📚 详细文档

- [完整优化说明](../../docs/whisper-queue-optimization.md)
- [详细使用说明](./QUEUE_README.md)
- [实现总结](../../docs/queue-implementation-summary.md)

## 🎯 关键优势

1. **不丢失任务** - 重启后自动恢复
2. **透明管理** - 无需手动操作
3. **实时监控** - 随时查看队列状态
4. **高可靠性** - 完善的容错机制

---

**版本**: v1.1 | **更新**: 2026-02-03
