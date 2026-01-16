#!/usr/bin/env node

/**
 * 测试漫画生成服务
 */

const path = require('path');

// 动态导入ES模块
async function testComicGeneration() {
  console.log('=== 测试漫画生成服务 ===\n');
  
  try {
    // 动态导入ComicGeneratorService
    const { ComicGeneratorService } = await import('../dist/services/comic/ComicGeneratorService.js');
    
    // 创建漫画生成服务实例
    const comicService = new ComicGeneratorService();
    
    // 测试文件路径
    const testHighlightPath = path.join(__dirname, 'test_data', 'test_AI_HIGHLIGHT.txt');
    const testComicScriptPath = path.join(__dirname, 'test_data', 'test_COMIC_SCRIPT.txt');
    
    console.log('1. 测试从AI高亮文件生成漫画...');
    console.log(`   输入文件: ${testHighlightPath}`);
    
    const comicPath = await comicService.generateComicFromHighlight(testHighlightPath, 'test-room-123');
    
    if (comicPath) {
      console.log(`   ✅ 漫画生成成功: ${comicPath}`);
    } else {
      console.log('   ❌ 漫画生成失败');
    }
    
    console.log('\n2. 测试从漫画脚本文件生成漫画...');
    console.log(`   输入文件: ${testComicScriptPath}`);
    
    const comicPath2 = await comicService.generateComicFromHighlight(testComicScriptPath, 'test-room-456');
    
    if (comicPath2) {
      console.log(`   ✅ 漫画生成成功: ${comicPath2}`);
    } else {
      console.log('   ❌ 漫画生成失败');
    }
    
    console.log('\n3. 测试批量生成漫画...');
    const testDataDir = path.join(__dirname, 'test_data');
    console.log(`   测试目录: ${testDataDir}`);
    
    const count = await comicService.generateComicsInBatch(testDataDir);
    console.log(`   ✅ 批量生成了 ${count} 个漫画`);
    
    console.log('\n=== 测试完成 ===');
    
  } catch (error) {
    console.error('测试过程中出错:', error);
    process.exit(1);
  }
}

// 运行测试
testComicGeneration();