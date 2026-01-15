#!/usr/bin/env node

/**
 * 简单测试漫画生成服务
 */

const path = require('path');
const { spawn } = require('child_process');

async function testPythonScript() {
  console.log('=== 测试Python漫画生成脚本 ===\n');
  
  try {
    const pythonScriptPath = path.join(__dirname, 'ai_comic_generator.py');
    const testHighlightPath = path.join(__dirname, 'test_data', 'test_AI_HIGHLIGHT.txt');
    
    console.log('1. 测试Python脚本执行...');
    console.log(`   Python脚本: ${pythonScriptPath}`);
    console.log(`   输入文件: ${testHighlightPath}`);
    
    return new Promise((resolve, reject) => {
      const pythonProcess = spawn('python', [pythonScriptPath, testHighlightPath], {
        stdio: 'pipe',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
      
      let output = '';
      let errorOutput = '';
      
      pythonProcess.stdout.on('data', (data) => {
        output += data.toString();
        console.log(`   Python输出: ${data.toString().trim()}`);
      });
      
      pythonProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
        console.error(`   Python错误: ${data.toString().trim()}`);
      });
      
      pythonProcess.on('close', (code) => {
        console.log(`   Python进程退出码: ${code}`);
        
        if (code === 0) {
          console.log('   ✅ Python脚本执行成功');
          resolve(true);
        } else {
          console.log('   ❌ Python脚本执行失败');
          reject(new Error(`Python脚本执行失败，退出码: ${code}`));
        }
      });
      
      pythonProcess.on('error', (error) => {
        console.error(`   ❌ 启动Python进程失败: ${error.message}`);
        reject(error);
      });
      
      // 设置超时
      setTimeout(() => {
        pythonProcess.kill();
        console.log('   ⚠️ Python进程超时，已终止');
        reject(new Error('Python进程超时'));
      }, 30000); // 30秒超时
    });
    
  } catch (error) {
    console.error('测试过程中出错:', error);
    throw error;
  }
}

async function testComicService() {
  console.log('\n2. 测试漫画生成服务集成...');
  
  try {
    // 直接测试Python脚本
    const pythonScriptPath = path.join(__dirname, 'ai_comic_generator.py');
    const testHighlightPath = path.join(__dirname, 'test_data', 'test_AI_HIGHLIGHT.txt');
    
    console.log(`   执行命令: python ${pythonScriptPath} ${testHighlightPath}`);
    
    const { execSync } = require('child_process');
    const result = execSync(`python "${pythonScriptPath}" "${testHighlightPath}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    
    console.log(`   ✅ 漫画生成服务集成测试成功`);
    console.log(`   输出: ${result.trim()}`);
    
    return true;
  } catch (error) {
    console.error(`   ❌ 漫画生成服务集成测试失败: ${error.message}`);
    return false;
  }
}

// 运行测试
async function runTests() {
  try {
    await testPythonScript();
    await testComicService();
    
    console.log('\n=== 所有测试完成 ===');
    console.log('✅ 漫画生成流程测试通过');
  } catch (error) {
    console.error('\n=== 测试失败 ===');
    console.error(`❌ 测试失败: ${error.message}`);
    process.exit(1);
  }
}

runTests();