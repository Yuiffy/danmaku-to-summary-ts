# SessionEnded延迟处理问题修复

## 问题描述

用户发现虽然在 `SessionStarted` 时取消了 `SessionEnded` 的延迟处理定时器,但旧会话的文件仍然被处理了。

## 问题根源

### 事件序列分析

从日志中可以看到完整的事件流程:

1. **15:59:34** - SessionEnded (SessionId: 9c7e6654..., 第一个会话结束)
2. **15:59:36** - FileClosed (对应第一个会话的文件 `223618`)
   - 此时会话不存在(已结束)
   - 检测到有 SessionEnded 延迟定时器
   - **错误地取消定时器并立即处理文件** ❌
3. **15:59:36** - SessionEnded (重复事件或延迟到达)
   - 会话不存在 → 启动30秒延迟处理
4. **15:59:37** - SessionStarted (SessionId: f283c188..., 新会话开始)
   - 取消了 SessionEnded 的30秒延迟定时器 ✅
5. **16:00:50** - `FileStabilityChecker` 完成 → 开始处理 `223618` 文件 ❌

### 核心问题

**旧的逻辑**:
- FileClosed 到达时,如果检测到 SessionEnded 延迟定时器,就**立即取消定时器并处理文件**
- 这导致即使后续有 SessionStarted(断线重连),文件处理也无法被阻止

**正确的逻辑应该是**:
- FileClosed 到达时,如果检测到 SessionEnded 延迟定时器,应该**将文件加入待处理队列**
- 等待30秒延迟结束后,再决定是否处理这些文件
- 如果30秒内有 SessionStarted,则清空待处理队列(说明是断线重连)
- 如果30秒后没有 SessionStarted,则处理待处理队列中的文件

## 解决方案

### 实现思路

使用 `pendingFiles` Map 来保存待处理的文件,而不是立即处理:

1. 在 `MikufansWebhookHandler` 中添加 `pendingFiles` Map
2. 在 `collectSegment` 中,如果检测到 SessionEnded 延迟定时器,将文件加入待处理队列
3. 在 `handleSessionStarted` 时,清空待处理队列(说明是断线重连)
4. 在 `processSessionEndedWithoutSession` (30秒延迟结束)时,处理待处理队列中的文件

### 代码修改

#### 1. 添加 pendingFiles Map

```typescript
// SessionEnded延迟期间收到的待处理文件(roomId -> {videoPath, payload}[])
private pendingFiles: Map<string, Array<{videoPath: string, payload: any}>> = new Map();
```

#### 2. 在 collectSegment 中将文件加入待处理队列

```typescript
private async collectSegment(roomId: string, videoPath: string, payload: any): Promise<void> {
  const session = this.liveSessionManager.getSession(roomId);
  if (!session) {
    // 检查是否有SessionEnded延迟定时器
    const sessionEndedTimer = this.sessionEndedTimers.get(roomId);
    if (sessionEndedTimer) {
      // 有SessionEnded延迟定时器，说明在等待确认是否断线重连
      // 将文件加入待处理队列，等待延迟结束后处理
      if (!this.pendingFiles.has(roomId)) {
        this.pendingFiles.set(roomId, []);
      }
      this.pendingFiles.get(roomId)!.push({videoPath, payload});
      this.logger.info(`📝 SessionEnded延迟期间收到文件，加入待处理队列: ${roomId} (${path.basename(videoPath)})`);
    } else {
      // 没有延迟定时器，说明会话已经结束，直接处理
      this.logger.warn(`会话不存在: ${roomId}，直接处理文件`);
      await this.processMikufansFile(videoPath, payload);
    }
    return;
  }
  // ... 正常收集片段逻辑
}
```

#### 3. 在 SessionStarted 时清空待处理队列

```typescript
private async handleSessionStarted(sessionId: string, payload: any): Promise<void> {
  // ... 创建会话逻辑

  // 清除待处理的文件（说明是断线重连，这些文件属于当前会话）
  const pendingFiles = this.pendingFiles.get(roomId);
  if (pendingFiles && pendingFiles.length > 0) {
    this.logger.info(`🔄 清除待处理文件: ${roomId} (${pendingFiles.length}个文件，属于当前会话)`);
    this.pendingFiles.delete(roomId);
  }
}
```

#### 4. 在延迟结束后处理待处理队列

```typescript
private async processSessionEndedWithoutSession(roomId: string, payload: any): Promise<void> {
  // 再次检查会话是否存在（可能在延迟期间收到了SessionStart）
  const session = this.liveSessionManager.getSession(roomId);
  if (session) {
    this.logger.info(`📝 延迟处理时发现会话已存在，跳过处理: ${roomId}`);
    // 清除待处理文件（这些文件属于新会话）
    this.pendingFiles.delete(roomId);
    return;
  }

  this.logger.info(`📝 SessionEnded延迟结束: ${roomId} (会话仍不存在，开始处理待处理文件)`);

  // 处理延迟期间收到的文件
  const pendingFiles = this.pendingFiles.get(roomId);
  if (pendingFiles && pendingFiles.length > 0) {
    this.logger.info(`📦 处理 ${pendingFiles.length} 个待处理文件`);
    for (const {videoPath, payload} of pendingFiles) {
      await this.processMikufansFile(videoPath, payload);
    }
    this.pendingFiles.delete(roomId);
  } else {
    this.logger.info(`ℹ️  没有待处理的文件`);
  }
}
```

## 效果

修复后的行为:

1. **15:59:36** - FileClosed 触发 → **文件加入待处理队列** (不立即处理)
2. **15:59:37** - SessionStarted → **清空待处理队列** (说明是断线重连)
3. 文件不会被处理,因为它们属于当前会话,会在后续的 FileClosed 事件中正常收集

**如果是真正的会话结束**:
1. **15:59:36** - FileClosed 触发 → 文件加入待处理队列
2. **16:00:06** - 30秒延迟结束 → **处理待处理队列中的文件**

## 日志示例

### 断线重连场景

```
15:59:36 INFO 📝 SessionEnded延迟期间收到文件，加入待处理队列: 25788785 (录制-25788785-20260121-223618-488-快进来 煮煮你.flv)
15:59:37 INFO 🔄 取消SessionEnded延迟处理: 25788785 (检测到SessionStart)
15:59:37 INFO 🔄 清除待处理文件: 25788785 (1个文件，属于当前会话)
15:59:37 INFO 🎬 直播开始: 岁己SUI (Session: f283c188..., Room: 25788785)
```

### 真正结束场景

```
15:59:36 INFO 📝 SessionEnded延迟期间收到文件，加入待处理队列: 25788785 (录制-25788785-20260121-223618-488-快进来 煮煮你.flv)
16:00:06 INFO 📝 SessionEnded延迟结束: 25788785 (会话仍不存在，开始处理待处理文件)
16:00:06 INFO 📦 处理 1 个待处理文件
16:00:06 INFO FileClosed事件：检查文件稳定... (录制-25788785-20260121-223618-488-快进来 煮煮你.flv)
```

## 总结

这个问题的本质是**时序控制**。正确的做法是:

1. **不要在 FileClosed 时立即处理文件**
2. **将文件加入待处理队列,等待 SessionEnded 延迟结束**
3. **如果延迟期间有 SessionStarted,清空队列(断线重连)**
4. **如果延迟结束后没有 SessionStarted,处理队列(真正结束)**

这个方案比使用 AbortController 更简单,更符合逻辑,也更容易维护。

