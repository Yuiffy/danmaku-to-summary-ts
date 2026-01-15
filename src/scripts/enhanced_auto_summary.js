#!/usr/bin/env node

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
console.log(`处理文件: ${videoPath}`);

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
