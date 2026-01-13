# Webhook 增强计划

## 概述
增强现有的webhook服务器以支持：
1. 修复DDTV SaveBulletScreenFile事件的超时问题
2. 添加mikufans录播姬webhook支持
3. 支持音频录制配置

## 详细实施步骤

### 1. 修复超时问题
**文件**: `src/scripts/webhook_server.js`
**修改内容**:
- 第235行: 将 `await sleep(3000);` 改为 `await sleep(30000);` (30秒)
- 添加重试机制: 最多重试3次，每次等待10秒
- 添加配置参数: `FIX_VIDEO_WAIT_TIME` (默认30秒)

### 2. 添加mikufans录播姬支持
**新文件**: `src/scripts/webhook_server.js` (添加新路由)
**端点**: `POST /mikufans`
**处理逻辑**:
1. 解析mikufans webhook格式
2. 识别事件类型: `FileOpening`, `FileClosed`, `SessionStarted`, `SessionEnded`
3. 对于`FileOpening`事件:
   - 提取`RelativePath`
   - 构建完整路径: `D:\files\videos\DDTV录播\` + `RelativePath`
   - 等待文件稳定
   - 触发处理流程
4. 对于`FileClosed`事件:
   - 直接处理已完成的文件

**mikufans webhook格式示例**:
```json
{
  "EventType": "FileOpening",
  "EventTimestamp": "2026-01-14T01:29:16.3983903+08:00",
  "EventId": "66e7b5d6-e844-40cc-b1ee-94947d4d85e5",
  "EventData": {
    "SessionId": "add80566-c420-4f00-9393-bd55d1cd218c",
    "RelativePath": "80397_阿梓从小就很可爱/2026_01_14/录制-80397-20260114-012916-397-训练！.flv",
    "FileOpenTime": "2026-01-14T01:29:16.3983903+08:00",
    "RoomId": 80397,
    "ShortId": 510,
    "Name": "阿梓从小就很可爱",
    "Title": "训练！",
    "AreaNameParent": "虚拟主播",
    "AreaNameChild": "虚拟Gamer",
    "Recording": true,
    "Streaming": true,
    "DanmakuConnected": true
  }
}
```

### 3. 音频录制支持
**文件**: `src/scripts/auto_summary.js`
**修改内容**:
- 扩展`VIDEO_EXTS`数组: 添加 `.aac`, `.mp3`, `.wav`, `.ogg`, `.flac`
- 修改`isVideoFile`函数名称为`isMediaFile`以更准确

**配置文件**: `src/scripts/config.json`
```json
{
  "audioRecording": {
    "enabled": true,
    "audioOnlyRooms": [12345, 67890],
    "audioFormats": [".m4a", ".aac", ".mp3", ".wav"],
    "defaultFormat": ".m4a"
  },
  "timeouts": {
    "fixVideoWait": 30000,
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

### 4. 配置文件系统
**新文件**: `src/scripts/config.js`
```javascript
const fs = require('fs');
const path = require('path');

const defaultConfig = {
  audioRecording: {
    enabled: true,
    audioOnlyRooms: [],
    audioFormats: ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac'],
    defaultFormat: '.m4a'
  },
  timeouts: {
    fixVideoWait: 30000,
    fileStableCheck: 30000,
    processTimeout: 1800000
  },
  recorders: {
    ddtv: {
      enabled: true,
      endpoint: '/ddtv'
    },
    mikufans: {
      enabled: true,
      endpoint: '/mikufans',
      basePath: 'D:/files/videos/DDTV录播'
    }
  }
};

function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...defaultConfig, ...userConfig };
    }
  } catch (error) {
    console.error('Error loading config:', error);
  }
  return defaultConfig;
}

module.exports = { loadConfig };
```

### 5. 更新webhook服务器
**修改**: `src/scripts/webhook_server.js`
- 导入配置文件
- 添加`/mikufans`路由
- 使用配置参数替代硬编码值
- 添加音频文件处理支持

### 6. 更新文档
**文件**: `src/scripts/WEBHOOK_README.md`
**更新内容**:
1. 添加mikufans录播姬配置说明
2. 添加音频录制配置说明
3. 添加超时参数说明
4. 更新故障排除部分

### 7. 测试计划
1. 测试DDTV webhook超时修复
2. 测试mikufans webhook处理
3. 测试音频文件处理
4. 测试配置文件加载

## 架构图

```mermaid
graph TB
    subgraph "Webhook 服务器"
        DDTV_Route[/ddtv]
        Mikufans_Route[/mikufans]
        Config[配置文件]
        Processor[文件处理器]
    end
    
    subgraph "录播姬"
        DDTV[DDTV 5]
        Mikufans[mikufans录播姬]
    end
    
    subgraph "文件系统"
        VideoFiles[视频文件 .mp4, .flv]
        AudioFiles[音频文件 .m4a, .aac]
        DanmakuFiles[弹幕文件 .xml]
    end
    
    subgraph "处理流程"
        AutoSummary[auto_summary.js]
        Whisper[Whisper ASR]
        Fusion[融合总结]
    end
    
    DDTV --> DDTV_Route
    Mikufans --> Mikufans_Route
    
    DDTV_Route --> Processor
    Mikufans_Route --> Processor
    Config --> Processor
    
    Processor --> VideoFiles
    Processor --> AudioFiles
    Processor --> DanmakuFiles
    
    VideoFiles --> AutoSummary
    AudioFiles --> AutoSummary
    DanmakuFiles --> AutoSummary
    
    AutoSummary --> Whisper
    AutoSummary --> Fusion
```

## 实施顺序
1. 创建配置文件系统
2. 修复超时问题
3. 添加音频支持
4. 添加mikufans支持
5. 更新文档
6. 测试验证

## 注意事项
1. 确保向后兼容性
2. 配置文件使用相对路径
3. 错误处理要完善
4. 日志要详细便于调试