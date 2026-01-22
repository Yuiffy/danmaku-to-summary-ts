/**
 * StreamEnd回调合并功能测试脚本
 *
 * 用途：测试LiveSessionManager和FileMerger的合并功能
 * 使用方法：node src/scripts/test_stream_merge.js
 */

const path = require('path');
const fs = require('fs');

// 添加超时工具函数
function withTimeout(promise, timeoutMs, errorMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    )
  ]);
}

// 导入服务（需要先编译TypeScript）
// 注意：如果TypeScript未编译，需要先运行 npm run build
let LiveSessionManager, FileMerger;

try {
  // 尝试从编译后的JS文件导入
  const distPath = path.join(__dirname, '../../dist/services/webhook');
  LiveSessionManager = require(path.join(distPath, 'LiveSessionManager')).LiveSessionManager;
  FileMerger = require(path.join(distPath, 'FileMerger')).FileMerger;
} catch (error) {
  console.error('无法导入服务，请确保已运行 npm run build');
  console.error('或者使用 ts-node 运行此脚本');
  process.exit(1);
}

// 测试配置
const TEST_CONFIG = {
  roomId: '1741667419',
  roomName: '十六萤Izayoi',
  title: '聊半小时',
  basePath: 'D:/files/videos/DDTV录播',
  segments: [
    {
      videoPath: 'D:/files/videos/DDTV录播/1741667419_十六萤Izayoi/2026_01_19/录制-1741667419-20260119-220437-226-聊半小时..flv',
      xmlPath: 'D:/files/videos/DDTV录播/1741667419_十六萤Izayoi/2026_01_19/录制-1741667419-20260119-220437-226-聊半小时..xml',
      fileOpenTime: new Date('2026-01-19T22:04:37.000Z'),
      fileCloseTime: new Date('2026-01-19T22:05:30.000Z')
    },
    {
      videoPath: 'D:/files/videos/DDTV录播/1741667419_十六萤Izayoi/2026_01_19/录制-1741667419-20260119-220531-698-聊半小时..flv',
      xmlPath: 'D:/files/videos/DDTV录播/1741667419_十六萤Izayoi/2026_01_19/录制-1741667419-20260119-220531-698-聊半小时..xml',
      fileOpenTime: new Date('2026-01-19T22:05:31.000Z'),
      fileCloseTime: new Date('2026-01-19T22:06:37.000Z')
    },
    {
      videoPath: 'D:/files/videos/DDTV录播/1741667419_十六萤Izayoi/2026_01_19/录制-1741667419-20260119-220638-079-聊半小时..flv',
      xmlPath: 'D:/files/videos/DDTV录播/1741667419_十六萤Izayoi/2026_01_19/录制-1741667419-20260119-220638-079-聊半小时..xml',
      fileOpenTime: new Date('2026-01-19T22:06:38.000Z'),
      fileCloseTime: new Date('2026-01-19T22:07:15.000Z')
    }
  ]
};

// 验证函数
function validateTestFiles() {
  console.log('\n=== 验证测试文件 ===');
  let allValid = true;

  for (let i = 0; i < TEST_CONFIG.segments.length; i++) {
    const segment = TEST_CONFIG.segments[i];
    const videoExists = fs.existsSync(segment.videoPath);
    const xmlExists = fs.existsSync(segment.xmlPath);

    console.log(`\n片段 ${i + 1}:`);
    console.log(`  视频: ${path.basename(segment.videoPath)} - ${videoExists ? '✓' : '✗'}`);
    console.log(`  XML:  ${path.basename(segment.xmlPath)} - ${xmlExists ? '✓' : '✗'}`);

    if (!videoExists || !xmlExists) {
      allValid = false;
    }
  }

  return allValid;
}

// 测试函数
async function runTest() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     StreamEnd回调合并功能测试                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  // 验证测试文件
  if (!validateTestFiles()) {
    console.error('\n❌ 测试文件验证失败，请检查文件路径');
    process.exit(1);
  }

  console.log('\n✅ 所有测试文件存在');

  // 创建服务实例
  const sessionManager = new LiveSessionManager();
  const fileMerger = new FileMerger();

  try {
    // 步骤1: 创建会话
    console.log('\n=== 步骤1: 创建会话 ===');
    const session = sessionManager.createOrGetSession(
      TEST_CONFIG.roomId,
      TEST_CONFIG.roomName,
      TEST_CONFIG.title
    );
    console.log(`✅ 会话创建成功: ${session.roomId}`);
    console.log(`   房间名: ${session.roomName}`);
    console.log(`   标题: ${session.title}`);
    console.log(`   状态: ${session.status}`);

    // 步骤2: 添加片段
    console.log('\n=== 步骤2: 添加片段 ===');
    for (let i = 0; i < TEST_CONFIG.segments.length; i++) {
      const segment = TEST_CONFIG.segments[i];
      sessionManager.addSegment(
        TEST_CONFIG.roomId,
        segment.videoPath,
        segment.xmlPath,
        segment.fileOpenTime,
        segment.fileCloseTime,
        new Date()
      );
      console.log(`✅ 片段 ${i + 1} 添加成功: ${path.basename(segment.videoPath)}`);
    }

    // 验证片段数量
    const updatedSession = sessionManager.getSession(TEST_CONFIG.roomId);
    console.log(`\n当前片段数: ${updatedSession.segments.length}`);

    // 步骤3: 检查是否需要合并
    console.log('\n=== 步骤3: 检查合并条件 ===');
    const shouldMerge = sessionManager.shouldMerge(TEST_CONFIG.roomId);
    console.log(`是否需要合并: ${shouldMerge ? '是' : '否'}`);

    if (!shouldMerge) {
      console.log('⚠️  单片段场景，跳过合并测试');
      process.exit(0);
    }

    // 步骤4: 获取合并配置
    console.log('\n=== 步骤4: 获取合并配置 ===');
    const mergeConfig = sessionManager.getMergeConfig();
    console.log(`启用合并: ${mergeConfig.enabled}`);
    console.log(`最大片段数: ${mergeConfig.maxSegments}`);
    console.log(`填充空白: ${mergeConfig.fillGaps}`);
    console.log(`备份原始文件: ${mergeConfig.backupOriginals}`);
    console.log(`复制封面: ${mergeConfig.copyCover}`);

    // 步骤5: 执行合并
    console.log('\n=== 步骤5: 执行合并 ===');
    sessionManager.markAsMerging(TEST_CONFIG.roomId);
    console.log(`✅ 会话状态已更新为: merging`);

    // 确定输出文件路径
    const firstSegment = updatedSession.segments[0];
    const outputDir = path.dirname(firstSegment.videoPath);
    const outputBaseName = path.basename(firstSegment.videoPath, path.extname(firstSegment.videoPath));
    const mergedVideoPath = path.join(outputDir, `${outputBaseName}_merged.flv`);
    const mergedXmlPath = path.join(outputDir, `${outputBaseName}_merged.xml`);

    console.log(`\n输出视频: ${path.basename(mergedVideoPath)}`);
    console.log(`输出XML:  ${path.basename(mergedXmlPath)}`);

    // 合并视频文件（先合并，再备份）
    console.log('\n--- 合并视频文件 ---');
    await fileMerger.mergeVideos(updatedSession.segments, mergedVideoPath, mergeConfig.fillGaps);
    console.log('✅ 视频合并完成');

    // 合并XML文件
    console.log('\n--- 合并XML文件 ---');
    await fileMerger.mergeXmlFiles(updatedSession.segments, mergedXmlPath);
    console.log('✅ XML合并完成');

    // 备份原始片段（合并成功后再备份）
    if (mergeConfig.backupOriginals) {
      console.log('\n--- 备份原始片段 ---');
      await fileMerger.backupSegments(updatedSession.segments, outputDir);
      console.log('✅ 备份完成');
    }

    // 复制封面图
    if (mergeConfig.copyCover) {
      console.log('\n--- 复制封面图 ---');
      await fileMerger.copyCover(updatedSession.segments, outputDir);
      console.log('✅ 封面图复制完成');
    }

    // 步骤6: 验证结果
    console.log('\n=== 步骤6: 验证结果 ===');

    const videoExists = fs.existsSync(mergedVideoPath);
    const xmlExists = fs.existsSync(mergedXmlPath);
    const bakDir = path.join(outputDir, 'bak');
    const bakExists = fs.existsSync(bakDir);

    console.log(`\n合并视频存在: ${videoExists ? '✓' : '✗'}`);
    console.log(`合并XML存在:  ${xmlExists ? '✓' : '✗'}`);
    console.log(`备份文件夹存在: ${bakExists ? '✓' : '✗'}`);

    if (videoExists) {
      const videoStats = fs.statSync(mergedVideoPath);
      console.log(`\n合并视频大小: ${(videoStats.size / 1024 / 1024).toFixed(2)} MB`);
    }

    if (xmlExists) {
      const xmlStats = fs.statSync(mergedXmlPath);
      console.log(`合并XML大小: ${(xmlStats.size / 1024).toFixed(2)} KB`);
    }

    // 步骤7: 标记会话为完成
    console.log('\n=== 步骤7: 标记会话状态 ===');
    sessionManager.markAsProcessing(TEST_CONFIG.roomId);
    console.log(`✅ 会话状态已更新为: processing`);

    // 最终总结
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                    测试完成                                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    if (videoExists && xmlExists) {
      console.log('\n✅ 所有测试通过！');
      console.log('\n生成的文件:');
      console.log(`  - ${mergedVideoPath}`);
      console.log(`  - ${mergedXmlPath}`);
      if (bakExists) {
        console.log(`  - ${bakDir}/ (备份文件夹)`);
      }
    } else {
      console.log('\n❌ 测试失败，部分文件未生成');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ 测试执行失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 运行测试
runTest().catch(error => {
  console.error('未捕获的错误:', error);
  process.exit(1);
});
