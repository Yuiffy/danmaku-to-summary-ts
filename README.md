# 弹幕转总结项目重构版

基于TypeScript的模块化重构版本，将原有的脚本集合重构为可维护、可扩展的现代化应用程序。

## 🚀 项目概述

本项目是一个自动化处理系统，用于处理录播视频文件，生成总结、高光时刻和AI生成的回复。系统通过Webhook接收DDTV和Mikufans录播姬的事件，自动处理新录制的视频文件。

### 主要功能

- **Webhook服务**：接收DDTV和Mikufans录播姬的事件
- **音频处理**：自动将音频专用房间的视频转换为音频文件
- **字幕融合**：分析弹幕文件，提取高光时刻和总结
- **AI文本生成**：使用Gemini/OpenAI API生成晚安回复和总结
- **B站动态回复**：自动检测主播动态并回复（支持延迟回复）
- **服务管理**：统一的启动、停止和状态管理
- **配置管理**：分层配置系统，支持环境特定配置

## 📁 项目结构

```
danmaku-to-summary-ts/
├── src/
│   ├── app/                    # 应用程序入口
│   │   ├── main.ts            # 主应用程序
│   │   └── ...                # Next.js相关文件（前端）
│   ├── core/                  # 核心基础设施
│   │   ├── config/           # 配置管理系统
│   │   ├── logging/          # 日志系统
│   │   └── errors/           # 错误处理系统
│   ├── services/             # 业务服务
│   │   ├── webhook/          # Webhook服务
│   │   ├── audio/            # 音频处理服务
│   │   ├── ai/               # AI生成服务
│   │   ├── bilibili/         # B站动态回复服务
│   │   ├── fusion/           # 字幕融合服务（待实现）
│   │   └── ServiceManager.ts # 服务管理器
│   └── scripts/              # 原有脚本（兼容性保留）
├── plans/                    # 项目计划和设计文档
├── public/                   # 静态资源
└── tests/                    # 测试文件
```

## 🛠️ 技术栈

- **语言**: TypeScript 5.x
- **运行时**: Node.js 18+
- **Web框架**: Express.js
- **配置管理**: 分层配置系统（默认→环境→本地→环境变量）
- **日志系统**: 多级别、多传输器的日志系统
- **错误处理**: 统一的错误处理中间件
- **测试**: Jest + TypeScript

## 🚦 快速开始

### 环境要求

- Node.js 18+
- npm 或 pnpm
- FFmpeg（音频处理需要）

### 安装依赖

```bash
# 使用pnpm（推荐）
pnpm install

# 或使用npm
npm install
```

### 配置设置

1. 复制示例配置文件：
```bash
cp src/scripts/config.secrets.example.json src/scripts/config.secrets.json
```

2. 编辑配置文件，设置你的API密钥和其他配置：
```json
{
  "ai": {
    "text": {
      "gemini": {
        "apiKey": "你的Gemini API密钥"
      }
    }
  }
}
```

### 运行应用程序

#### 开发模式

```bash
# 启动Webhook服务
pnpm dev

# 或直接运行
node dist/app/main.js
```

#### 生产模式

```bash
# 构建项目
pnpm build

# 运行构建后的应用
pnpm start
```

#### CLI模式

```bash
# 处理单个文件
node dist/app/main.js process /path/to/video.mp4 /path/to/danmaku.xml 123456

# 显示状态
node dist/app/main.js status
```

## 🔧 配置说明

### 配置文件层次

1. **默认配置**：`src/core/config/defaults.json`
2. **环境配置**：`config.{environment}.json`
3. **本地配置**：`src/scripts/config.secrets.json`
4. **环境变量**：覆盖特定配置项

### 主要配置项

```typescript
interface AppConfig {
  app: {
    name: string;           // 应用名称
    version: string;        // 版本号
    environment: string;    // 环境：development/production
    logLevel: string;       // 日志级别
  };
  webhook: {
    port: number;           // Webhook端口（默认：15121）
    host: string;           // 监听主机
    endpoints: {
      ddtv: WebhookEndpointConfig;
      mikufans: WebhookEndpointConfig;
    };
    timeouts: {
      fixVideoWait: number;     // 等待fix视频生成超时
      fileStableCheck: number;  // 文件稳定性检查超时
      processTimeout: number;   // 处理超时
    };
  };
  audio: {
    audioOnlyRooms: number[];   // 音频专用房间ID列表
    formats: string[];          // 支持的音频格式
    defaultFormat: string;      // 默认音频格式
  };
  ai: {
    text: {
      provider: 'gemini' | 'openai';  // AI提供者
      gemini?: GeminiConfig;          // Gemini配置
      openai?: OpenAIConfig;          // OpenAI配置
    };
    roomSettings: Record<string, RoomAIConfig>; // 房间特定配置
  };
  bilibili: {
    enabled: boolean;                // 是否启用B站动态回复
    cookie: string;                  // B站Cookie
    csrf: string;                    // B站CSRF Token
    polling: {
      interval: number;              // 轮询间隔（毫秒）
      maxRetries: number;            // 最大重试次数
      retryDelay: number;            // 重试延迟（毫秒）
    };
    anchors: Record<string, {
      uid: string;                   // 主播UID
      name: string;                  // 主播名称
      roomId?: string;               // 房间ID
      enabled: boolean;              // 是否启用
      delayedReplyEnabled?: boolean;  // 是否启用延迟回复
    }>;
    delayedReply: {
      enabled: boolean;              // 是否启用延迟回复
      delayMinutes: number;          // 延迟时间（分钟）
      maxRetries: number;            // 最大重试次数
      retryDelayMinutes: number;     // 重试延迟（分钟）
    };
  };
  // ... 其他配置
}
```

## 🌐 Webhook端点

### DDTV录播姬

- **端点**: `POST http://localhost:15121/ddtv`
- **支持的事件**:
  - 文件录制完成
  - 弹幕文件保存
  - 配置变更
  - 登录失效通知

### Mikufans录播姬

- **端点**: `POST http://localhost:15121/mikufans`
- **支持的事件**:
  - 会话开始
  - 文件关闭
  - 会话结束

### B站动态回复API

- **健康检查**: `GET http://localhost:15121/api/bilibili/health`
- **检查Cookie**: `GET http://localhost:15121/api/bilibili/check-cookie`
- **获取动态（UID）**: `GET http://localhost:15121/api/bilibili/dynamics/:uid`
- **获取动态（房间ID）**: `GET http://localhost:15121/api/bilibili/room/:roomId/dynamics`
- **发布评论**: `POST http://localhost:15121/api/bilibili/comment`
- **上传图片**: `POST http://localhost:15121/api/bilibili/upload`
- **发布带图片评论**: `POST http://localhost:15121/api/bilibili/comment-with-image`
- **获取配置**: `GET http://localhost:15121/api/bilibili/config`
- **触发延迟回复**: `POST http://localhost:15121/api/bilibili/delayed-reply`

## 🔄 处理流程

1. **文件接收**：Webhook接收录播姬事件
2. **文件稳定性检查**：等待文件写入完成
3. **重复处理防护**：检查是否已在处理中
4. **音频处理**（如适用）：转换音频专用房间的视频
5. **字幕融合**：分析弹幕，提取高光时刻
6. **AI生成**：生成晚安回复和总结
7. **B站动态回复**：
   - 延迟回复：直播结束后延迟指定时间回复最新动态
   - 动态轮询：定期轮询主播动态，发现新动态后自动回复
8. **结果输出**：保存处理结果到指定目录

## 🧪 测试

### 运行测试

```bash
# 运行所有测试
pnpm test

# 运行特定测试
pnpm test -- WebhookService

# 测试覆盖率
pnpm test:coverage
```

### 测试结构

- **单元测试**：测试单个组件和函数
- **集成测试**：测试服务间的集成
- **配置测试**：测试配置加载和验证

## 📊 监控和健康检查

### 健康检查端点

```
GET http://localhost:15121/health
```

### 状态端点

```
GET http://localhost:15121/status
```

### 处理历史

```
GET http://localhost:15121/history
```

### 正在处理的文件

```
GET http://localhost:15121/processing-files
```

## 🔧 开发指南

### 添加新服务

1. 在 `src/services/` 下创建服务目录
2. 定义接口（`I{ServiceName}.ts`）
3. 实现服务类（`{ServiceName}.ts`）
4. 在 `ServiceManager` 中注册服务
5. 编写单元测试

### 添加新的Webhook处理器

1. 在 `src/services/webhook/handlers/` 下创建处理器
2. 实现 `IWebhookHandler` 接口
3. 在 `WebhookService` 中注册处理器
4. 更新配置文件中的端点设置

### 日志记录

```typescript
import { getLogger } from '../core/logging/LogManager';

const logger = getLogger('MyService');

logger.info('信息日志', { context: 'value' });
logger.error('错误日志', { error: error }, error);
```

### 错误处理

```typescript
import { AppError, ValidationError } from '../core/errors/AppError';

// 抛出标准错误
throw new ValidationError('配置验证失败', { field: 'apiKey' });

// 捕获和处理错误
try {
  // 业务逻辑
} catch (error) {
  if (error instanceof AppError) {
    // 处理应用错误
  } else {
    // 处理未知错误
  }
}
```

## 📈 部署

### Docker部署

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/
COPY config/ ./config/

EXPOSE 15121

CMD ["node", "dist/app/main.js"]
```

### PM2部署（推荐）

#### 安装PM2

```bash
# 全局安装PM2
npm install -g pm2

# 或使用pnpm
pnpm add -g pm2
```

#### 使用PM2生态系统配置文件

项目已包含 `ecosystem.config.js` 文件，支持多种环境配置：

```bash
# 启动生产环境
npm run pm2:start

# 启动开发环境
npm run pm2:start:dev

# 查看状态
npm run pm2:status

# 查看日志
npm run pm2:logs

# 重启服务
npm run pm2:restart

# 停止服务
npm run pm2:stop

# 删除服务
npm run pm2:delete

# 保存PM2配置
npm run pm2:save

# 设置开机自启
npm run pm2:startup
```

#### 手动PM2命令

```bash
# 使用生态系统配置文件
pm2 start ecosystem.config.js --env production

# 直接启动（带参数）
pm2 start dist/app/main.js --name danmaku-webhook -- --port 15121 --host 0.0.0.0

# 查看所有进程
pm2 list

# 监控进程
pm2 monit

# 查看详细状态
pm2 show danmaku-webhook

# 重载应用（零停机重启）
pm2 reload danmaku-webhook

# 清空日志
pm2 flush
```

#### PM2管理脚本

在 `package.json` 中已配置完整的PM2管理脚本：

```json
{
  "scripts": {
    "pm2:start": "pm2 start ecosystem.config.js --env production",
    "pm2:start:dev": "pm2 start ecosystem.config.js --env development",
    "pm2:stop": "pm2 stop ecosystem.config.js",
    "pm2:restart": "pm2 restart ecosystem.config.js",
    "pm2:reload": "pm2 reload ecosystem.config.js",
    "pm2:delete": "pm2 delete ecosystem.config.js",
    "pm2:logs": "pm2 logs danmaku-webhook",
    "pm2:status": "pm2 status danmaku-webhook",
    "pm2:list": "pm2 list",
    "pm2:save": "pm2 save",
    "pm2:startup": "pm2 startup",
    "pm2:monitor": "pm2 monit",
    "pm2:flush": "pm2 flush",
    "pm2:kill": "pm2 kill"
  }
}
```

### 命令行参数

应用程序支持以下命令行参数：

```bash
# 启动服务模式（默认端口和主机）
node dist/app/main.js

# 指定端口和主机
node dist/app/main.js --port 8080 --host 0.0.0.0

# 处理单个文件
node dist/app/main.js process /path/to/video.mp4 /path/to/danmaku.xml 123456

# 显示状态
node dist/app/main.js status

# 显示帮助
node dist/app/main.js --help
```

#### 支持的参数

| 参数 | 说明 | 默认值 | 示例 |
|------|------|--------|------|
| `--port <端口>` | Webhook服务端口 | 15121 | `--port 8080` |
| `--host <主机>` | Webhook服务主机 | localhost | `--host 0.0.0.0` |
| `--help` | 显示帮助信息 | - | `--help` |

#### 环境变量覆盖

也可以通过环境变量覆盖配置：

```bash
# 设置端口
export PORT=8080

# 设置主机
export HOST=0.0.0.0

# 设置日志级别
export LOG_LEVEL=debug

# 启动应用
node dist/app/main.js
```

### 服务管理

#### 启动服务

```bash
# 开发环境
npm run webhook:dev

# 生产环境
npm run webhook:prod

# 自定义参数
npm run webhook -- --port 8080 --host 0.0.0.0
```

#### 服务状态检查

```bash
# 检查健康状态
curl http://localhost:15121/health

# 检查详细状态
curl http://localhost:15121/status

# 查看处理历史
curl http://localhost:15121/history

# 查看正在处理的文件
curl http://localhost:15121/processing-files
```

#### 服务重启

```bash
# 使用PM2重启
npm run pm2:restart

# 或直接重启
npm run restart:webhook
```

## 🔍 故障排除

### 常见问题

1. **Webhook服务无法启动**
   - 检查端口是否被占用
   - 检查配置文件是否正确

2. **AI生成失败**
   - 检查API密钥配置
   - 检查网络连接和代理设置

3. **音频处理失败**
   - 检查FFmpeg是否安装
   - 检查文件权限

4. **文件重复处理**
   - 检查重复处理防护配置
   - 清理处理记录缓存

### 日志查看

```bash
# 查看应用日志
tail -f logs/app.log

# 查看错误日志
tail -f logs/error.log
```

## 📚 相关文档

- [架构设计文档](plans/ai_summary_enhancement_plan.md)
- [Webhook增强计划](plans/webhook_enhancement_plan.md)
- [B站动态回复计划](plans/bilibili_dynamic_reply_plan.md)
- [配置参考](src/core/config/README.md)
- [API文档](docs/api.md)

## 🤝 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情

## 🙏 致谢

- DDTV录播姬项目
- Mikufans录播姬项目
- 所有贡献者和用户

---

**注意**: 本项目仍在积极开发中，API和配置可能会发生变化。建议在生产环境使用前进行充分测试。
