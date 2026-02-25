/**
 * XML文件合并功能测试脚本
 *
 * 用途：测试FileMerger的XML合并功能
 * 使用方法：node src/scripts/test_xml_merge.js
 */

const path = require('path');
const fs = require('fs');

// 导入服务（需要先编译TypeScript）
let FileMerger;

try {
  // 尝试从编译后的JS文件导入
  const distPath = path.join(__dirname, '../../dist/services/webhook');
  FileMerger = require(path.join(distPath, 'FileMerger')).FileMerger;
} catch (error) {
  console.error('无法导入服务，请确保已运行 npm run build');
  console.error('或者使用 ts-node 运行此脚本');
  process.exit(1);
}

// 测试配置
const TEST_CONFIG = {
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
  console.log('║     XML文件合并功能测试                                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  // 验证测试文件
  if (!validateTestFiles()) {
    console.error('\n❌ 测试文件验证失败，请检查文件路径');
    process.exit(1);
  }

  console.log('\n✅ 所有测试文件存在');

  // 创建服务实例
  const fileMerger = new FileMerger();

  try {
    // 确定输出文件路径
    const firstSegment = TEST_CONFIG.segments[0];
    const outputDir = path.dirname(firstSegment.xmlPath);
    const outputBaseName = path.basename(firstSegment.xmlPath, path.extname(firstSegment.xmlPath));
    const mergedXmlPath = path.join(outputDir, `${outputBaseName}_merged.xml`);

    console.log(`\n输出XML: ${path.basename(mergedXmlPath)}`);

    // 合并XML文件
    console.log('\n=== 开始合并XML文件 ===');
    await fileMerger.mergeXmlFiles(TEST_CONFIG.segments, mergedXmlPath);
    console.log('✅ XML合并完成');

    // 验证结果
    console.log('\n=== 验证结果 ===');

    const xmlExists = fs.existsSync(mergedXmlPath);

    console.log(`\n合并XML存在: ${xmlExists ? '✓' : '✗'}`);

    if (xmlExists) {
      const xmlStats = fs.statSync(mergedXmlPath);
      console.log(`合并XML大小: ${(xmlStats.size / 1024).toFixed(2)} KB`);

      // 读取并显示前几行
      const content = fs.readFileSync(mergedXmlPath, 'utf8');
      const lines = content.split('\n');
      console.log(`\n合并XML总行数: ${lines.length}`);
      console.log('\n前10行内容:');
      lines.slice(0, 10).forEach((line, index) => {
        console.log(`  ${index + 1}: ${line}`);
      });

      // 统计弹幕数量
      const danmakuMatches = content.match(/<d\s+[^>]*>/g);
      const danmakuCount = danmakuMatches ? danmakuMatches.length : 0;
      console.log(`\n总弹幕数量: ${danmakuCount}`);

      // 统计原始XML中的弹幕数量
      let totalOriginalDanmakus = 0;
      for (const segment of TEST_CONFIG.segments) {
        const segmentContent = fs.readFileSync(segment.xmlPath, 'utf8');
        const segmentMatches = segmentContent.match(/<d\s+[^>]*>/g);
        totalOriginalDanmakus += segmentMatches ? segmentMatches.length : 0;
      }
      console.log(`原始XML总弹幕数量: ${totalOriginalDanmakus}`);

      if (danmakuCount === totalOriginalDanmakus) {
        console.log('✅ 弹幕数量匹配');
      } else {
        console.log(`❌ 弹幕数量不匹配: ${danmakuCount} vs ${totalOriginalDanmakus}`);
      }
    }

    // 最终总结
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                    测试完成                                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    if (xmlExists) {
      console.log('\n✅ 测试通过！');
      console.log('\n生成的文件:');
      console.log(`  - ${mergedXmlPath}`);
    } else {
      console.log('\n❌ 测试失败，文件未生成');
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
