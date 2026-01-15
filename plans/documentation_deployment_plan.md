# 文档和部署脚本更新计划

## 文档更新策略

### 1. 文档结构重组

```
docs/
├── README.md                    # 项目总览
├── QUICK_START.md              # 快速开始指南
├── ARCHITECTURE.md             # 架构文档
├── CONFIGURATION.md            # 配置指南
├── API_REFERENCE.md            # API参考
├── DEVELOPMENT.md              # 开发指南
├── DEPLOYMENT.md               # 部署指南
├── TROUBLESHOOTING.md          # 故障排除
└── CHANGELOG.md                # 变更日志
```

### 2. 主要文档内容

#### README.md (项目总览)
```markdown
# Danmaku to Summary TS

一个自动处理直播录播文件，生成AI总结的工具。

## 主要功能

- 🎯 **自动监听**：支持DDTV和mikufans录播姬webhook
- 🔊 **音频处理**：自动将指定房间的视频转为音频
- 🤖 **AI生成**：使用Gemini API生成晚安回复
- 🎨 **漫画生成**：生成直播总结漫画
- 📊 **智能融合**：融合字幕和弹幕，提取精华内容

## 快速开始

```bash
# 安装依赖
npm install

# 启动webhook服务器
npm run webhook

# 处理单个文件
npm run process -- /path/to/video.mp4
```

## 项目状态

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)]()
[![Test Coverage](https://img.shields.io/badge/coverage-85%25-green)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()

## 相关链接

- [配置指南](./docs/CONFIGURATION.md)
- [API参考](./docs/API_REFERENCE.md)
- [开发指南](./docs/DEVELOPMENT.md)
```

#### CONFIGURATION.md (配置指南)
```markdown
# 配置指南

## 配置文件结构

项目使用分层配置系统，配置文件位于 `config/` 目录：

```
config/
├── defaults/            # 默认配置
│   └── default.json
├── environments/        # 环境配置
│   ├── development.json
│   └── production.json
└── local.json          # 本地配置（git忽略）
```

## 配置加载优先级

1. 命令行参数
2. 环境变量
3. `config/environments/{NODE_ENV}.json`
4. `config/local.json`
5. `config/defaults/default.json`
6. 内置默认值

## 主要配置项

### Webhook配置
```json
{
  "webhook": {
    "enabled": true,
    "port": 15121,
    "host": "localhost",
    "endpoints": {
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
}
```

### AI服务配置
```json
{
  "ai": {
    "text": {
      "enabled": true,
      "provider": "gemini",
      "gemini": {
        "apiKey": "${GEMINI_API_KEY}",
        "model": "gemini-1.5-flash",
        "temperature": 0.7
      }
    }
  }
}
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `NODE_ENV` | 运行环境 | `development` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `WEBHOOK_PORT` | Webhook端口 | `15121` |
| `GEMINI_API_KEY` | Gemini API密钥 | - |
| `STORAGE_BASE_PATH` | 存储基础路径 | - |

## 房间级配置

支持为不同直播间配置不同的处理策略：

```json
{
  "ai": {
    "roomSettings": {
      "26966466": {
        "audioOnly": true,
        "anchorName": "栞栞Shiori",
        "fanName": "獭獭栞",
        "enableTextGeneration": true,
        "enableComicGeneration": true
      }
    }
  }
}
```

## 迁移现有配置

如果你有旧版本的配置文件，可以使用迁移工具：

```bash
npm run migrate-config -- old-config.json
```

这将自动将旧配置转换为新格式。
```

#### API_REFERENCE.md (API参考)
```markdown
# API参考

## Webhook API

### POST /ddtv
处理DDTV录播姬的webhook请求。

**请求体格式：**
```json
{
  "cmd": "FileClosed",
  "data": {
    "RoomId": 12345,
    "Name": "主播名称",
    "DownInfo": {
      "DownloadFileList": {
        "VideoFile": ["/path/to/video_fix.mp4"],
        "DanmuFile": ["/path/to/danmaku.xml"]
      }
    }
  }
}
```

**响应：**
- `200 OK`: 处理已开始
- `400 Bad Request`: 请求格式错误
- `500 Internal Server Error`: 服务器错误

### POST /mikufans
处理mikufans录播姬的webhook请求。

**请求体格式：**
```json
{
  "EventType": "FileClosed",
  "EventData": {
    "RelativePath": "主播/日期/录制-房间号-时间.flv",
    "RoomId": 12345,
    "Name": "主播名称"
  }
}
```

## 健康检查 API

### GET /health
检查服务健康状态。

**响应：**
```json
{
  "status": "healthy",
  "timestamp": "2026-01-14T15:30:00.000Z",
  "version": "1.0.0",
  "services": {
    "webhook": "running",
    "audio": "ready",
    "ai": "ready"
  }
}
```

## 管理 API

### GET /metrics
获取服务指标（需要启用监控）。

### POST /reload-config
重新加载配置（开发环境）。

## CLI API

### 处理命令
```bash
# 处理单个文件
node dist/cli.js process /path/to/video.mp4 [/path/to/danmaku.xml]

# 批量处理目录
node dist/cli.js batch /path/to/directory

# 启动webhook服务器
node dist/cli.js webhook

# 查看帮助
node dist/cli.js --help
```

## 事件系统

服务通过事件总线发布以下事件：

| 事件 | 说明 | 数据格式 |
|------|------|----------|
| `file.received` | 收到新文件 | `{ filePath, roomId, type }` |
| `audio.processed` | 音频处理完成 | `{ inputPath, outputPath, roomId }` |
| `ai.generated` | AI生成完成 | `{ type, inputPath, outputPath, roomId }` |
| `pipeline.completed` | 流程完成 | `{ success, results, duration }` |
```

## 部署脚本设计

### 1. 构建脚本

```javascript
// scripts/build.js
#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

async function build() {
  console.log('🚀 开始构建项目...');
  
  try {
    // 清理构建目录
    console.log('🧹 清理构建目录...');
    await fs.remove('dist');
    await fs.remove('coverage');
    
    // 编译TypeScript
    console.log('📦 编译TypeScript...');
    execSync('npx tsc --project tsconfig.build.json', { stdio: 'inherit' });
    
    // 复制配置文件
    console.log('📄 复制配置文件...');
    await fs.copy('config', 'dist/config');
    await fs.copy('public', 'dist/public');
    
    // 复制Python脚本
    console.log('🐍 复制Python脚本...');
    await fs.copy('src/scripts/python', 'dist/scripts/python');
    
    // 设置文件权限
    console.log('🔧 设置文件权限...');
    if (process.platform !== 'win32') {
      execSync('chmod +x dist/cli.js', { stdio: 'inherit' });
    }
    
    // 生成版本信息
    console.log('🏷️  生成版本信息...');
    const packageJson = require('../package.json');
    const versionInfo = {
      version: packageJson.version,
      buildTime: new Date().toISOString(),
      nodeVersion: process.version,
    };
    
    await fs.writeJson('dist/version.json', versionInfo, { spaces: 2 });
    
    console.log('✅ 构建完成！');
    console.log(`📁 输出目录: ${path.resolve('dist')}`);
    
  } catch (error) {
    console.error('❌ 构建失败:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  build();
}
```

### 2. 部署脚本

```javascript
// scripts/deploy.js
#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');

class Deployer {
  constructor(options = {}) {
    this.options = {
      environment: 'production',
      skipBuild: false,
      skipTests: false,
      ...options,
    };
  }
  
  async deploy() {
    console.log(`🚀 开始部署到 ${this.options.environment} 环境...`);
    
    try {
      // 1. 运行测试
      if (!this.options.skipTests) {
        await this.runTests();
      }
      
      // 2. 构建项目
      if (!this.options.skipBuild) {
        await this.build();
      }
      
      // 3. 验证构建
      await this.validateBuild();
      
      // 4. 备份当前版本
      await this.backupCurrentVersion();
      
      // 5. 部署新版本
      await this.deployNewVersion();
      
      // 6. 重启服务
      await this.restartServices();
      
      // 7. 验证部署
      await this.verifyDeployment();
      
      console.log('✅ 部署完成！');
      
    } catch (error) {
      console.error('❌ 部署失败:', error.message);
      await this.rollback();
      process.exit(1);
    }
  }
  
  async runTests() {
    console.log('🧪 运行测试...');
    execSync('npm test', { stdio: 'inherit' });
  }
  
  async build() {
    console.log('📦 构建项目...');
    execSync('npm run build', { stdio: 'inherit' });
  }
  
  async validateBuild() {
    console.log('🔍 验证构建...');
    
    // 检查必要文件
    const requiredFiles = [
      'dist/cli.js',
      'dist/config/defaults/default.json',
      'dist/version.json',
    ];
    
    for (const file of requiredFiles) {
      if (!fs.existsSync(file)) {
        throw new Error(`必要文件缺失: ${file}`);
      }
    }
    
    // 检查Node版本兼容性
    const versionInfo = require('../dist/version.json');
    const currentMajor = parseInt(process.version.replace('v', '').split('.')[0]);
    const requiredMajor = 18;
    
    if (currentMajor < requiredMajor) {
      throw new Error(`Node.js版本过低，需要v${requiredMajor}+，当前: ${process.version}`);
    }
  }
  
  async backupCurrentVersion() {
    const backupDir = `backups/${new Date().toISOString().replace(/[:.]/g, '-')}`;
    
    if (fs.existsSync('deploy')) {
      console.log('💾 备份当前版本...');
      await fs.copy('deploy', backupDir);
    }
  }
  
  async deployNewVersion() {
    console.log('🚚 部署新版本...');
    
    // 创建部署目录
    await fs.ensureDir('deploy');
    
    // 复制构建文件
    await fs.copy('dist', 'deploy');
    
    // 复制环境配置文件
    const envConfig = `config/environments/${this.options.environment}.json`;
    if (fs.existsSync(envConfig)) {
      await fs.copy(envConfig, 'deploy/config/environment.json');
    }
    
    // 创建启动脚本
    await this.createStartupScript();
  }
  
  async createStartupScript() {
    const scriptContent = `#!/bin/bash
# 启动脚本 - ${this.options.environment} 环境

cd "$(dirname "$0")"

# 加载环境变量
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# 设置Node环境
export NODE_ENV=${this.options.environment}

# 启动webhook服务器
node cli.js webhook
`;
    
    await fs.writeFile('deploy/start.sh', scriptContent);
    execSync('chmod +x deploy/start.sh', { stdio: 'inherit' });
  }
  
  async restartServices() {
    console.log('🔄 重启服务...');
    
    // 使用PM2管理进程
    if (this.isPm2Installed()) {
      execSync('pm2 restart danmaku-summary || pm2 start deploy/start.sh --name danmaku-summary', {
        stdio: 'inherit',
      });
    } else {
      console.log('⚠️  PM2未安装，请手动重启服务');
    }
  }
  
  async verifyDeployment() {
    console.log('🔍 验证部署...');
    
    // 等待服务启动
    await this.sleep(3000);
    
    // 检查健康状态
    try {
      const healthCheck = execSync('curl -s http://localhost:15121/health', {
        encoding: 'utf8',
      });
      
      const health = JSON.parse(healthCheck);
      if (health.status === 'healthy') {
        console.log('✅ 服务健康检查通过');
      } else {
        throw new Error('服务健康检查失败');
      }
    } catch (error) {
      throw new Error(`部署验证失败: ${error.message}`);
    }
  }
  
  async rollback() {
    console.log('↩️  尝试回滚...');
    
    // 查找最新的备份
    const backups = await fs.readdir('backups').catch(() => []);
    if (backups.length > 0) {
      const latestBackup = backups.sort().reverse()[0];
      console.log(`恢复备份: ${latestBackup}`);
      
      await fs.copy(`backups/${latestBackup}`, 'deploy');
      await this.restartServices();
    }
  }
  
  isPm2Installed() {
    try {
      execSync('pm2 --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 命令行接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  
  // 解析命令行参数
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--env':
      case '-e':
        options.environment = args[++i];
        break;
      case '--skip-build':
        options.skipBuild = true;
        break;
      case '--skip-tests':
        options.skipTests = true;
        break;
      case '--help':
      case '-h':
        showHelp();
        return;
    }
  }
  
  // 确认部署
  if (!options.skipTests || !options.skipBuild) {
    const answer = await askQuestion(`确认部署到 ${options.environment || 'production'} 环境？ (y/N): `);
    if (answer.toLowerCase() !== 'y') {
      console.log('部署取消');
      process.exit(0);
    }
  }
  
  const deployer = new Deployer(options);
  await deployer.deploy();
}

function showHelp() {
  console.log(`
部署脚本使用说明

用法:
  npm run deploy [选项]

选项:
  -e, --env <环境>     部署环境 (development, staging, production)
  --skip-build         跳过构建步骤
  --skip-tests         跳过测试步骤
  -h, --help          显示帮助信息

示例:
  npm run deploy -- -e production
  npm run deploy -- --skip-tests
  `);
}

function askQuestion(question) {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer);
    });
  });
}

if (require.main === module) {
  main().finally(() => rl.close());
}
```

### 3. 迁移脚本

```javascript
// scripts/migrate.js
#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');

class Migrator {
  constructor() {
    this.oldConfigPath = process.argv[2];
  }
  
  async migrate() {
    if (!this.oldConfigPath) {
      console.error('请指定旧配置文件路径');
      console.log('用法: npm run migrate -- <旧配置文件路径>');
      process.exit(1);
    }
    
    console.log(`🔄 开始迁移配置: ${this.oldConfigPath}`);
    
    try {
      // 读取旧配置
      const oldConfig = await this.readOldConfig();
      
      // 转换为新配置
      const newConfig = this.convertConfig(oldConfig);
      
      // 保存新配置
      await this.saveNewConfig(newConfig);
      
      // 迁移密钥文件
