#!/usr/bin/env node

/**
 * 测试配置加载
 */

const path = require('path');

async function testConfigLoading() {
  console.log('=== 测试配置加载 ===\n');
  
  try {
    // 使用require而不是import
    const { ConfigProvider } = require('../dist/core/config/ConfigProvider');
    
    // 初始化配置
    console.log('1. 初始化配置...');
    const config = await ConfigProvider.initialize();
    
    console.log('2. 检查配置结构...');
    console.log(`   - 应用名称: ${config.app.name}`);
    console.log(`   - 环境: ${config.app.environment}`);
    console.log(`   - 日志级别: ${config.app.logLevel}`);
    
    console.log('\n3. 检查AI配置...');
    console.log(`   - AI文本生成启用: ${config.ai.text.enabled}`);
    console.log(`   - AI提供者: ${config.ai.text.provider}`);
    
    if (config.ai.text.gemini) {
      console.log(`   - Gemini API密钥配置: ${config.ai.text.gemini.apiKey ? '是' : '否'}`);
      console.log(`   - Gemini 模型: ${config.ai.text.gemini.model}`);
      console.log(`   - Gemini 代理: ${config.ai.text.gemini.proxy || '未配置'}`);
    }
    
    console.log('\n4. 检查代理配置...');
    // 检查根级别的代理配置
    if (config.proxy) {
      console.log(`   - 根级别代理: ${config.proxy}`);
    } else {
      console.log(`   - 根级别代理: 未配置`);
    }
    
    console.log('\n5. 获取Gemini API密钥...');
    const geminiApiKey = ConfigProvider.getGeminiApiKey();
    console.log(`   - Gemini API密钥: ${geminiApiKey ? '已配置' : '未配置'}`);
    
    console.log('\n=== 配置加载测试完成 ===');
    
  } catch (error) {
    console.error('配置加载测试失败:', error);
    process.exit(1);
  }
}

// 运行测试
testConfigLoading();