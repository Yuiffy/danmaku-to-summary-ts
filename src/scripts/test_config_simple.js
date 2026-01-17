#!/usr/bin/env node

/**
 * 简单的配置加载测试脚本
 */

const { ConfigProvider } = require('../../dist/core/config/ConfigProvider');

async function testConfig() {
  console.log('========================================');
  console.log('      配置加载测试');
  console.log('========================================\n');

  try {
    // 初始化配置
    await ConfigProvider.initialize();
    console.log('✅ 配置初始化完成\n');

    // 获取配置
    const config = ConfigProvider.getConfig();
    console.log('配置信息:');
    console.log('----------------------------------------');
    console.log(`B站配置:`);
    console.log(`  enabled: ${config.bilibili.enabled}`);
    console.log(`  cookie: ${config.bilibili.cookie ? '已配置' : '未配置'}`);
    console.log(`  csrf: ${config.bilibili.csrf ? '已配置' : '未配置'}`);
    console.log(`  polling.interval: ${config.bilibili.polling.interval}ms`);
    console.log(`  anchors: ${Object.keys(config.bilibili.anchors).length} 个`);
    console.log('----------------------------------------');

    console.log('\n========================================');
    console.log('      测试完成！');
    console.log('========================================');

  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error);
    process.exit(1);
  }
}

// 运行测试
testConfig().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('测试失败:', error);
  process.exit(1);
});
