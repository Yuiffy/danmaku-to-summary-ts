#!/usr/bin/env node

/**
 * 迁移工具：从旧脚本架构迁移到新TypeScript架构
 * 
 * 这个工具帮助用户将现有的配置和脚本迁移到新的模块化架构。
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const exists = promisify(fs.exists);
const mkdir = promisify(fs.mkdir);

/**
 * 迁移配置
 */
async function migrateConfig() {
  console.log('📋 开始迁移配置...');
  
  const oldConfigPath = path.join(__dirname, 'config.json');
  const oldSecretsPath = path.join(__dirname, 'config.secrets.json');
  const newConfigDir = path.join(__dirname, '..', '..', 'config');
  
  // 确保新配置目录存在
  if (!await exists(newConfigDir)) {
    await mkdir(newConfigDir, { recursive: true });
  }
  
  // 迁移主配置
  if (await exists(oldConfigPath)) {
    try {
      const oldConfig = JSON.parse(await readFile(oldConfigPath, 'utf8'));
      
      // 转换为新配置格式
      const newConfig = {
        app: {
          name: 'danmaku-to-summary',
          version: '2.0.0',
          environment: 'production',
          logLevel: 'info'
        },
        webhook: {
          enabled: true,
          port: oldConfig.port || 15121,
          host: '0.0.0.0',
          endpoints: {
            ddtv: {
              enabled: oldConfig.recorders?.ddtv?.enabled ?? true,
              endpoint: oldConfig.recorders?.ddtv?.endpoint || '/ddtv'
            },
            mikufans: {
              enabled: oldConfig.recorders?.mikufans?.enabled ?? true,
              endpoint: oldConfig.recorders?.mikufans?.endpoint || '/mikufans',
              basePath: oldConfig.recorders?.mikufans?.basePath || 'D:/files/videos/DDTV录播'
            }
          },
          timeouts: {
            fixVideoWait: oldConfig.timeouts?.fixVideoWait || 60000,
            fileStableCheck: oldConfig.timeouts?.fileStableCheck || 30000,
            processTimeout: oldConfig.timeouts?.processTimeout || 1800000
          }
        },
        audio: {
          enabled: oldConfig.audioRecording?.enabled ?? true,
          audioOnlyRooms: oldConfig.audioRecording?.audioOnlyRooms || [],
          formats: oldConfig.audioRecording?.audioFormats || ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac'],
          defaultFormat: oldConfig.audioRecording?.defaultFormat || '.m4a',
          ffmpeg: {
            path: 'ffmpeg',
            timeout: 30000
          },
          storage: {
            keepOriginalVideo: true,
            maxFileAgeDays: 30
          }
        },
        ai: {
          text: {
            enabled: true,
            provider: 'gemini',
            gemini: {
              apiKey: '', // 需要从secrets配置迁移
              model: 'gemini-pro',
              temperature: 0.7,
              maxTokens: 1000
            }
          },
          comic: {
            enabled: false,
            provider: 'python'
          },
          defaultNames: {
            anchor: '主播',
            fan: '粉丝'
          },
          roomSettings: {}
        },
        fusion: {
          timeWindowSec: 60,
          densityPercentile: 90,
          lowEnergySampleRate: 5,
          myUserId: '12345',
          stopWords: ['的', '了', '在'],
          fillerRegex: '^[\\s\\W]*$'
        },
        storage: {
          basePath: 'D:/files/videos/DDTV录播',
          tempPath: path.join('D:/files/videos/DDTV录播', 'temp'),
          outputPath: path.join('D:/files/videos/DDTV录播', 'output'),
          cleanup: {
            enabled: true,
            intervalHours: 24,
            maxAgeDays: 7
          }
        },
        monitoring: {
          enabled: true,
          metrics: {
            enabled: false,
            port: 9090
          },
          health: {
            enabled: true,
            endpoint: '/health'
          }
        }
      };
      
      // 写入新配置
      const newConfigPath = path.join(newConfigDir, 'production.json');
      await writeFile(newConfigPath, JSON.stringify(newConfig, null, 2), 'utf8');
      console.log(`✅ 配置已迁移到: ${newConfigPath}`);
      
    } catch (error) {
      console.error(`❌ 迁移配置失败: ${error.message}`);
    }
  } else {
    console.log('ℹ️ 未找到旧配置文件，使用默认配置');
  }
  
  // 迁移密钥配置
  if (await exists(oldSecretsPath)) {
    try {
      const oldSecrets = JSON.parse(await readFile(oldSecretsPath, 'utf8'));
      
      // 创建新的secrets配置
      const newSecrets = {
        ai: {
          text: {
            gemini: {
              apiKey: oldSecrets.geminiApiKey || ''
            },
            openai: {
              apiKey: oldSecrets.openaiApiKey || ''
            }
          }
        },
        proxy: oldSecrets.proxy || ''
      };
      
      // 写入新secrets配置
      const newSecretsPath = path.join(__dirname, 'config.secrets.json');
      await writeFile(newSecretsPath, JSON.stringify(newSecrets, null, 2), 'utf8');
      console.log(`✅ 密钥配置已迁移到: ${newSecretsPath}`);
      
    } catch (error) {
      console.error(`❌ 迁移密钥配置失败: ${error.message}`);
    }
  }
}

/**
 * 创建启动脚本
 */
async function createStartupScripts() {
  console.log('🚀 创建启动脚本...');
  
  // 创建Windows批处理脚本
  const batContent = `@echo off
echo 启动弹幕转总结服务...
cd /d "%~dp0"
node dist/app/main.js
pause
`;
  
  const batPath = path.join(__dirname, '启动服务.bat');
  await writeFile(batPath, batContent, 'utf8');
  console.log(`✅ 创建Windows启动脚本: ${batPath}`);
  
  // 创建Shell脚本
  const shContent = `#!/bin/bash
echo "启动弹幕转总结服务..."
cd "$(dirname "$0")"
node dist/app/main.js
`;
  
  const shPath = path.join(__dirname, 'start-service.sh');
  await writeFile(shPath, shContent, 'utf8');
  
  // 设置执行权限
  if (process.platform !== 'win32') {
    const { chmod } = require('fs');
    chmod(shPath, 0o755, () => {});
  }
  
  console.log(`✅ 创建Shell启动脚本: ${shPath}`);
}

/**
 * 创建兼容性包装器
 */
async function createCompatibilityWrappers() {
  console.log('🔄 创建兼容性包装器...');
  
  // webhook_server.js 包装器
  const webhookWrapper = `#!/usr/bin/env node

/**
 * 兼容性包装器：将旧的webhook_server.js调用重定向到新架构
 * 
 * 用法: node webhook_server.js
 */

console.log('⚠️  注意：旧版webhook_server.js已弃用，正在启动新版服务...');
console.log('📚 请迁移到新架构：node dist/app/main.js');

// 启动新服务
const { spawn } = require('child_process');
const path = require('path');

const mainPath = path.join(__dirname, '..', 'dist', 'app', 'main.js');

const child = spawn('node', [mainPath], {
  stdio: 'inherit',
  shell: true
});

child.on('error', (error) => {
  console.error('启动失败:', error.message);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code);
});
`;
  
  const wrapperPath = path.join(__dirname, 'webhook_server.js');
  await writeFile(wrapperPath, webhookWrapper, 'utf8');
  console.log(`✅ 创建Webhook兼容性包装器: ${wrapperPath}`);
  
  // enhanced_auto_summary.js 包装器
  const enhancedWrapper = `#!/usr/bin/env node

/**
 * 兼容性包装器：处理单个文件的旧脚本调用
 * 
 * 用法: node enhanced_auto_summary.js <videoPath> [xmlPath]
 */

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('用法: node enhanced_auto_summary.js <videoPath> [xmlPath] [roomId]');
  console.log('示例: node enhanced_auto_summary.js /path/to/video.mp4 /path/to/danmaku.xml 123456');
  process.exit(1);
}

const videoPath = args[0];
const xmlPath = args[1];
const roomId = args[2];

console.log('⚠️  注意：旧版enhanced_auto_summary.js已弃用，使用新架构处理...');
console.log(\`处理文件: \${videoPath}\`);

// 使用新架构处理
const { spawn } = require('child_process');
const path = require('path');

const mainPath = path.join(__dirname, '..', 'dist', 'app', 'main.js');

const child = spawn('node', [mainPath, 'process', videoPath, xmlPath || '', roomId || ''], {
  stdio: 'inherit',
  shell: true
});

child.on('error', (error) => {
  console.error('处理失败:', error.message);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code);
});
`;
  
  const enhancedPath = path.join(__dirname, 'enhanced_auto_summary.js');
  await writeFile(enhancedPath, enhancedWrapper, 'utf8');
  console.log(`✅ 创建增强处理兼容性包装器: ${enhancedPath}`);
}

/**
 * 创建迁移指南
 */
async function createMigrationGuide() {
  console.log('📖 创建迁移指南...');
  
  const guideContent = `# 从旧架构迁移到新架构指南

## 概述

本项目已从基于脚本的架构重构为基于TypeScript的模块化架构。本指南帮助您完成迁移过程。

## 主要变化

### 1. 架构变化
- **旧架构**: 独立的JavaScript脚本文件
- **新架构**: TypeScript模块化应用程序，包含服务、核心基础设施和统一入口

### 2. 配置变化
- **旧配置**: \`src/scripts/config.json\` 单一文件
- **新配置**: 分层配置系统
  - 默认配置: \`src/core/config/defaults.json\`
  - 环境配置: \`config/{environment}.json\`
  - 本地配置: \`src/scripts/config.secrets.json\`
  - 环境变量: 最高优先级

### 3. 启动方式变化
- **旧方式**: \`node src/scripts/webhook_server.js\`
- **新方式**: \`node dist/app/main.js\`

## 迁移步骤

### 步骤1: 安装依赖
\`\`\`bash
# 安装TypeScript和构建工具
npm install
# 或
pnpm install
\`\`\`

### 步骤2: 构建项目
\`\`\`bash
# 构建TypeScript代码
npm run build
# 或
pnpm build
\`\`\`

### 步骤3: 迁移配置
\`\`\`bash
# 运行迁移工具
node src/scripts/migrate-to-new-architecture.js
\`\`\`

### 步骤4: 更新配置
1. 检查生成的配置文件: \`config/production.json\`
2. 根据需要调整配置
3. 确保API密钥等敏感信息正确配置

### 步骤5: 测试运行
\`\`\`bash
# 启动服务
npm start
# 或直接运行
node dist/app/main.js
\`\`\`

## 兼容性说明

### 保留的兼容性
1. **配置文件**: 自动迁移旧配置到新格式
2. **启动脚本**: 创建了兼容性包装器
3. **处理逻辑**: 核心功能保持不变

### 需要更新的部分
1. **自定义脚本**: 如果创建了自定义脚本，需要更新为使用新API
2. **部署脚本**: 更新部署脚本以使用新的启动方式
3. **监控配置**: 新的健康检查端点

## 新功能

### 1. 服务管理
- 统一的启动、停止和重启
- 服务状态监控
- 健康检查端点

### 2. 改进的配置管理
- 分层配置系统
- 环境特定配置
- 配置验证

### 3. 增强的日志系统
- 结构化日志
- 多级别日志
- 文件和控制台输出

### 4. 错误处理
- 统一的错误处理
- 错误分类和恢复
- 详细的错误上下文

## 故障排除

### 常见问题

1. **服务无法启动**
   - 检查端口是否被占用
   - 检查配置文件格式
   - 查看日志文件

2. **配置迁移失败**
   - 手动检查配置文件
   - 参考默认配置格式

3. **依赖安装失败**
   - 清理node_modules重新安装
   - 检查Node.js版本（需要18+）

## 获取帮助

- 查看详细文档: [README.md](../README.md)
- 查看架构设计: [plans/](../plans/)
- 提交问题: GitHub Issues

## 下一步

1. 测试所有功能正常工作
2. 更新部署脚本
3. 配置监控和告警
4. 性能优化和调优
`;

  const guidePath = path.join(__dirname, 'MIGRATION_GUIDE.md');
  await writeFile(guidePath, guideContent, 'utf8');
  console.log(`✅ 创建迁移指南: ${guidePath}`);
}

/**
 * 主迁移函数
 */
async function main() {
  console.log('🎯 开始迁移到新架构...');
  console.log('='.repeat(50));
  
  try {
    await migrateConfig();
    console.log('-'.repeat(50));
    
    await createStartupScripts();
    console.log('-'.repeat(50));
    
    await createCompatibilityWrappers();
    console.log('-'.repeat(50));
    
    await createMigrationGuide();
    console.log('-'.repeat(50));
    
    console.log('🎉 迁移完成！');
    console.log('');
    console.log('下一步:');
    console.log('1. 检查迁移的配置文件');
    console.log('2. 运行: npm run build');
    console.log('3. 启动服务: npm start');
    console.log('4. 测试所有功能是否正常工作');
    console.log('');
    console.log('详细指南请查看: src/scripts/MIGRATION_GUIDE.md');
    
  } catch (error) {
    console.error(`❌ 迁移过程中发生错误: ${error.message}`);
    process.exit(1);
  }
}

// 运行迁移
if (require.main === module) {
  main();
}

module.exports = {
  migrateConfig,
  createStartupScripts,
  createCompatibilityWrappers,
  createMigrationGuide
};