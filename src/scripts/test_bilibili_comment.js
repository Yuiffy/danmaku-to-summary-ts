#!/usr/bin/env node

/**
 * B站评论发布测试脚本
 * 用于测试B站动态评论发布功能
 */

const { ConfigProvider } = require('../../dist/core/config/ConfigProvider');
const { BilibiliAPIService } = require('../../dist/services/bilibili/BilibiliAPIService');
const { ReplyHistoryStore } = require('../../dist/services/bilibili/ReplyHistoryStore');

async function testPublishComment() {
  console.log('========================================');
  console.log('      B站评论发布测试脚本');
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

    // 获取动态列表
    console.log('获取动态列表...');
    const testUid = process.env.BILIBILI_UID || '14279';
    const dynamics = await apiService.getDynamics(testUid);
    console.log(`✅ 获取到 ${dynamics.length} 条动态\n`);

    if (dynamics.length === 0) {
      console.log('❌ 没有找到动态，无法测试评论功能');
      return;
    }

    // 显示动态列表供选择
    console.log('动态列表:');
    console.log('----------------------------------------');
    for (let i = 0; i < Math.min(dynamics.length, 10); i++) {
      const dynamic = dynamics[i];
      console.log(`[${i + 1}] ID: ${dynamic.id}`);
      console.log(`    类型: ${dynamic.type}`);
      console.log(`    内容: ${dynamic.content.substring(0, 50)}${dynamic.content.length > 50 ? '...' : ''}`);
      console.log(`    发布时间: ${dynamic.publishTime.toLocaleString('zh-CN')}`);
      console.log(`    URL: ${dynamic.url}`);
      console.log('----------------------------------------');
    }

    // 检查是否已回复
    const testDynamicId = dynamics[0].id;
    const hasReplied = await historyStore.hasReplied(testDynamicId);
    console.log(`\n动态 ${testDynamicId} 是否已回复: ${hasReplied ? '✅ 是' : '❌ 否'}\n`);

    // 测试发布评论
    console.log('⚠️  准备发布测试评论...');
    console.log('⚠️  这将实际发布一条评论到B站动态\n');

    const testComment = process.env.BILIBILI_TEST_COMMENT || '这是一条测试评论';
    console.log(`评论内容: ${testComment}`);
    console.log(`目标动态ID: ${testDynamicId}`);
    console.log(`目标动态URL: ${dynamics[0].url}\n`);

    // 确认是否继续
    console.log('⚠️  请确认是否继续发布评论？');
    console.log('⚠️  按 Ctrl+C 取消，或等待 5 秒后自动继续...\n');

    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('开始发布评论...\n');

    const result = await apiService.publishComment({
      dynamicId: testDynamicId,
      content: testComment
    });

    console.log(`✅ 评论发布成功!`);
    console.log(`   回复ID: ${result.replyId}`);
    console.log(`   回复时间: ${new Date(result.replyTime).toLocaleString('zh-CN')}\n`);

    // 记录到历史
    await historyStore.recordReply({
      dynamicId: testDynamicId,
      uid: testUid,
      replyTime: new Date(),
      contentSummary: testComment,
      success: true
    });
    console.log('✅ 回复历史已记录\n');

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
testPublishComment().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('测试失败:', error);
  process.exit(1);
});
