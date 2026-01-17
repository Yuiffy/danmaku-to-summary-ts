#!/usr/bin/env node

/**
 * B站API测试脚本
 * 用于测试B站动态回复功能
 */

const { ConfigProvider } = require('../../dist/core/config/ConfigProvider');
const { BilibiliAPIService } = require('../../dist/services/bilibili/BilibiliAPIService');
const { ReplyHistoryStore } = require('../../dist/services/bilibili/ReplyHistoryStore');

async function testBilibiliAPI() {
  console.log('========================================');
  console.log('      B站API测试脚本');
  console.log('========================================\n');

  try {
    // 初始化配置
    await ConfigProvider.initialize();
    console.log('✅ 配置初始化完成\n');

    // 创建B站API服务实例
    const apiService = new BilibiliAPIService();
    const historyStore = new ReplyHistoryStore();

    // 初始化历史存储
    await historyStore.initialize();
    console.log('✅ 回复历史存储初始化完成\n');

    // 测试Cookie有效性
    console.log('测试Cookie有效性...');
    const isValid = await apiService.isCookieValid();
    console.log(`Cookie有效性: ${isValid ? '✅ 有效' : '❌ 无效'}\n`);

    if (!isValid) {
      console.error('❌ Cookie无效，请检查配置');
      return;
    }

    // 测试获取动态列表
    console.log('测试获取动态列表...');
    const testUid = '14279'; // 测试账号UID
    const dynamics = await apiService.getDynamics(testUid);
    console.log(`✅ 获取到 ${dynamics.length} 条动态\n`);

    // 显示动态列表
    if (dynamics.length > 0) {
      console.log('动态列表:');
      console.log('----------------------------------------');
      for (let i = 0; i < Math.min(dynamics.length, 5); i++) {
        const dynamic = dynamics[i];
        console.log(`[${i + 1}] ID: ${dynamic.id}`);
        console.log(`    类型: ${dynamic.type}`);
        console.log(`    内容: ${dynamic.content.substring(0, 50)}${dynamic.content.length > 50 ? '...' : ''}`);
        console.log(`    发布时间: ${dynamic.publishTime.toLocaleString('zh-CN')}`);
        console.log(`    URL: ${dynamic.url}`);
        console.log('----------------------------------------');
      }
    }

    // 测试检查是否已回复
    console.log('\n测试检查回复历史...');
    const testDynamicId = '1153657516031213571'; // 用户提供的测试动态ID
    const hasReplied = await historyStore.hasReplied(testDynamicId);
    console.log(`动态 ${testDynamicId} 是否已回复: ${hasReplied ? '✅ 是' : '❌ 否'}\n`);

    // 测试发布评论（仅用于测试，不会实际发布）
    console.log('⚠️  注意：测试发布评论功能需要谨慎使用');
    console.log('⚠️  如需测试，请取消下面的注释\n');
    /*
    console.log('测试发布评论...');
    const testComment = '这是一条测试评论';
    const result = await apiService.publishComment({
      dynamicId: testDynamicId,
      content: testComment
    });
    console.log(`✅ 评论发布成功: ${result.replyId}\n`);
    
    // 记录到历史
    await historyStore.recordReply({
      dynamicId: testDynamicId,
      uid: testUid,
      replyTime: new Date(),
      contentSummary: testComment,
      success: true
    });
    console.log('✅ 回复历史已记录\n');
    */

    console.log('========================================');
    console.log('      测试完成！');
    console.log('========================================');

  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error);
    process.exit(1);
  }
}

// 运行测试
testBilibiliAPI().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('测试失败:', error);
  process.exit(1);
});
