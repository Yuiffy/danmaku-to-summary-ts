#!/usr/bin/env node

const configLoader = require('./config-loader');

console.log('===========================================');
console.log('      配置加载器测试                      ');
console.log('===========================================');

// 测试1: 获取配置
console.log('\n1. 测试获取配置...');
try {
    const config = configLoader.getConfig();
    console.log('✅ 配置加载成功');
    console.log(`   Gemini API Key: ${config.aiServices?.gemini?.apiKey ? '已配置' : '未配置'}`);
    console.log(`   tuZi API Key: ${config.aiServices?.tuZi?.apiKey ? '已配置' : '未配置'}`);
    console.log(`   B站 Cookie: ${config.bilibili?.cookie ? '已配置' : '未配置'}`);
} catch (error) {
    console.error(`❌ 配置加载失败: ${error.message}`);
}

// 测试2: 获取API Key
console.log('\n2. 测试获取API Key...');
try {
    const geminiKey = configLoader.getGeminiApiKey();
    const tuZiKey = configLoader.getTuZiApiKey();
    console.log(`✅ Gemini API Key: ${geminiKey ? '已配置' : '未配置'}`);
    console.log(`✅ tuZi API Key: ${tuZiKey ? '已配置' : '未配置'}`);
} catch (error) {
    console.error(`❌ 获取API Key失败: ${error.message}`);
}

// 测试3: 检查配置状态
console.log('\n3. 测试检查配置状态...');
try {
    const geminiConfigured = configLoader.isGeminiConfigured();
    const tuZiConfigured = configLoader.isTuZiConfigured();
    console.log(`✅ Gemini 已配置: ${geminiConfigured}`);
    console.log(`✅ tuZi 已配置: ${tuZiConfigured}`);
} catch (error) {
    console.error(`❌ 检查配置状态失败: ${error.message}`);
}

// 测试4: 获取名称
console.log('\n4. 测试获取名称...');
try {
    const names = configLoader.getNames('26966466');
    console.log(`✅ 主播名称: ${names.anchor}`);
    console.log(`✅ 粉丝名称: ${names.fan}`);
} catch (error) {
    console.error(`❌ 获取名称失败: ${error.message}`);
}

// 测试5: 查找配置路径
console.log('\n5. 测试查找配置路径...');
try {
    const configPath = configLoader.findConfigPath();
    const secretsPath = configLoader.findSecretsPath();
    console.log(`✅ 配置文件路径: ${configPath}`);
    console.log(`✅ Secrets文件路径: ${secretsPath}`);
} catch (error) {
    console.error(`❌ 查找配置路径失败: ${error.message}`);
}

console.log('\n===========================================');
console.log('       测试完成！                          ');
console.log('===========================================');
