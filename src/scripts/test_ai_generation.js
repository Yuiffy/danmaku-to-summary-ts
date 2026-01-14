#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const aiTextGenerator = require('./ai_text_generator');
const aiComicGenerator = require('./ai_comic_generator');

console.log('🤖 AI生成功能测试');
console.log('==================\n');

// 测试文件路径
const testDir = "D:/files/videos/DDTV录播/22470216_悠亚Yua/2026_01_11";
const highlightFile = "2026_01_11_23_40_59_你好你好小悠复活_DDTV5_1_AI_HIGHLIGHT.txt";
const highlightPath = path.join(testDir, highlightFile);

console.log('1. 检查测试文件...');
if (fs.existsSync(highlightPath)) {
    console.log(`✅ 找到AI_HIGHLIGHT文件: ${highlightFile}`);
    
    // 读取文件信息
    const stats = fs.statSync(highlightPath);
    const content = fs.readFileSync(highlightPath, 'utf8');
    console.log(`   文件大小: ${(stats.size / 1024).toFixed(1)}KB`);
    console.log(`   内容长度: ${content.length} 字符`);
    console.log(`   前100字符: ${content.substring(0, 100)}...`);
} else {
    console.log(`❌ 未找到AI_HIGHLIGHT文件: ${highlightPath}`);
    console.log('   正在列出目录内容...');
    try {
        const files = fs.readdirSync(testDir);
        console.log('   目录中的文件:');
        files.forEach(file => {
            console.log(`     - ${file}`);
        });
    } catch (error) {
        console.log(`   无法读取目录: ${error.message}`);
    }
    process.exit(1);
}

console.log('\n2. 测试AI文本生成配置...');
try {
    const config = aiTextGenerator.loadConfig();
    const isConfigured = aiTextGenerator.isGeminiConfigured();
    
    if (isConfigured) {
        console.log('✅ Gemini API配置正确');
        console.log(`   模型: ${config.aiServices.gemini.model}`);
        console.log(`   温度: ${config.aiServices.gemini.temperature}`);
    } else {
        console.log('❌ Gemini API未配置');
        console.log('   请检查config.secrets.json中的apiKey');
    }
} catch (error) {
    console.log(`❌ 配置检查失败: ${error.message}`);
}

console.log('\n3. 测试AI漫画生成配置...');
try {
    const config = aiComicGenerator.loadConfig();
    const isEnabled = aiComicGenerator.isComicGenerationEnabled();
    
    if (isEnabled) {
        console.log('✅ AI漫画生成功能已启用');
    } else {
        console.log('❌ AI漫画生成功能已禁用（不使用googleImage和huggingFace）');
    }
} catch (error) {
    console.log(`❌ 配置检查失败: ${error.message}`);
}

console.log('\n4. 测试房间配置...');
// 从文件名提取房间ID
const roomIdMatch = highlightFile.match(/^(\d+)_/);
const roomId = roomIdMatch ? roomIdMatch[1] : null;

if (roomId) {
    console.log(`✅ 从文件名提取房间ID: ${roomId}`);
    
    // 检查房间是否在配置中
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        if (config.roomSettings && config.roomSettings[roomId]) {
            console.log(`✅ 房间 ${roomId} 有特定配置`);
            const roomConfig = config.roomSettings[roomId];
            console.log(`   referenceImage: ${roomConfig.referenceImage || '未配置'}`);
            console.log(`   enableTextGeneration: ${roomConfig.enableTextGeneration !== false}`);
            console.log(`   enableComicGeneration: ${roomConfig.enableComicGeneration !== false}`);
        } else {
            console.log(`ℹ️  房间 ${roomId} 无特定配置，将使用默认设置`);
            console.log(`   默认图片: ${config.aiServices?.defaultReferenceImage || '未配置'}`);
        }
    }
} else {
    console.log('⚠️  无法从文件名提取房间ID');
}

console.log('\n5. 运行AI文本生成测试...');
console.log('   注意: 这将调用真实的Gemini API，可能会产生费用');
console.log('   按Ctrl+C取消，或等待5秒后继续...');

// 等待用户确认
setTimeout(async () => {
    console.log('\n开始AI文本生成...');
    
    try {
        const result = await aiTextGenerator.generateGoodnightReply(highlightPath);
        
        if (result) {
            console.log(`✅ AI文本生成成功!`);
            console.log(`   输出文件: ${result}`);
            
            // 显示生成的文件内容
            if (fs.existsSync(result)) {
                const content = fs.readFileSync(result, 'utf8');
                console.log(`\n📄 生成内容预览:`);
                console.log('---');
                const lines = content.split('\n').slice(0, 10); // 显示前10行
                lines.forEach(line => console.log(line));
                if (content.split('\n').length > 10) {
                    console.log('... (更多内容)');
                }
                console.log('---');
            }
        } else {
            console.log('❌ AI文本生成失败，无输出文件');
        }
    } catch (error) {
        console.log(`❌ AI文本生成失败: ${error.message}`);
    }
    
    console.log('\n6. AI漫画生成测试...');
    console.log('   注意: AI漫画生成功能已禁用（不使用googleImage和huggingFace）');

    console.log('\n📊 测试总结');
    console.log('===========');
    console.log('AI生成功能测试完成！');
    console.log('请检查输出文件确认生成结果。');
    
}, 5000);