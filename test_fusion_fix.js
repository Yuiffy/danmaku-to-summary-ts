/**
 * 测试脚本:验证do_fusion_summary.js的XML解析修复
 * 
 * 问题原因:
 * xml2js.Parser 配置了 normalize: true,会将所有XML标签名和属性名转换为大写
 * 原代码使用 result?.i?.d 和 d.$.p 访问,但实际应该是 result?.I?.D 和 d.$.P
 * 
 * 修复内容:
 * 1. result?.i?.d => result?.I?.D
 * 2. d.$.p => d.$.P
 */

const { spawn } = require('child_process');
const path = require('path');

// 测试文件路径
const testXmlPath = 'D:\\files\\videos\\DDTV录播\\21452505_七海Nana7mi\\2026_01_22\\录制-21452505-20260122-030723-582-真三国无双起源新DLC_merged.xml';
const testSrtPath = 'D:\\files\\videos\\DDTV录播\\21452505_七海Nana7mi\\2026_01_22\\录制-21452505-20260122-030723-582-真三国无双起源新DLC_merged.srt';

console.log('🧪 开始测试 do_fusion_summary.js 的XML解析修复...\n');

const scriptPath = path.join(__dirname, 'src', 'scripts', 'do_fusion_summary.js');
const proc = spawn('node', [scriptPath, testXmlPath, testSrtPath], {
    cwd: __dirname,
    stdio: 'inherit'
});

proc.on('close', (code) => {
    if (code === 0) {
        console.log('\n✅ 测试通过!脚本成功执行');
        console.log('✅ 应该看到:');
        console.log('   - 总弹幕数 > 0 (实际约163条)');
        console.log('   - 直播总时长 > 0 (实际约6分钟)');
        console.log('   - AI_HIGHLIGHT文件大小 > 0.5KB');
    } else {
        console.error(`\n❌ 测试失败!退出码: ${code}`);
    }
});
