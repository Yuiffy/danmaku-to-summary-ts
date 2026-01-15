#!/usr/bin/env node

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
