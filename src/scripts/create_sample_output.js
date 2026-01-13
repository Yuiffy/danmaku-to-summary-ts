#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('📁 创建示例输出文件');
console.log('===================\n');

// 目标文件夹
const targetDir = "D:/files/videos/DDTV录播/22470216_悠亚Yua/2026_01_11";
console.log(`目标文件夹: ${targetDir}`);

// 检查文件夹是否存在
if (!fs.existsSync(targetDir)) {
    console.log(`❌ 文件夹不存在: ${targetDir}`);
    process.exit(1);
}

// 1. 创建示例MD文件（晚安回复）
const mdFilename = "2026_01_11_23_40_59_你好你好小悠复活_DDTV5_1_晚安回复.md";
const mdPath = path.join(targetDir, mdFilename);

const mdContent = `# 晚安回复（基于2026_01_11_23_40_59_你好你好小悠复活_DDTV5_1_AI_HIGHLIGHT.txt）
生成时间: 2026-01-13 20:30:00
---

晚安悠亚！🌙

今天直播的含金量真的太高了，从开头到结尾全程高能，看得我眼睛都舍不得眨一下！

## 🎮 游戏环节亮点
1. **恐怖游戏惊险时刻**：你玩《纸人》的时候被吓到尖叫的样子太可爱了，弹幕都在刷"保护我方悠亚"！
2. **操作细节**：那个QTE按得真准，观众都说"手速惊人"，特别是最后boss战的那波操作，简直秀翻天。
3. **搞笑反应**：被突然跳出来的鬼吓到把鼠标扔出去，然后自己先笑场，节目效果拉满。

## 🎵 歌回片段
中间唱了《勾指起誓》，声音温柔得让人心都化了。虽然你说"今天嗓子状态不好"，但听起来还是那么动人，弹幕全是"好听""耳朵怀孕了"。

## 😂 生活趣事
聊到养猫话题时，你说"我要是养猫绝对养不到这种爵士好猫"，然后开始模仿猫的傲娇表情，笑死我了。还有提到昨天外卖送错楼的经历，吐槽配送员"路痴程度跟我有一拼"。

## 💬 弹幕互动精华
- 观众刷屏"漂亮饭"的时候你害羞低头的样子太戳了
- 有人问"明天还播吗"，你认真查看日程表的样子好可爱
- "阿肯苦力"这个梗又被玩坏了，每次出现都引发刷屏

## 🌟 今日最佳时刻
个人觉得最精彩的是恐怖游戏里你一边害怕一边坚持通关的段落，那种"又菜又爱玩"的反差萌真的让人忍不住想守护。

## 💝 结尾关怀
今天播了这么久真的辛苦了，嗓子要注意休息，多喝温水。明天如果还播的话，期待继续看到元气满满的悠亚！

—— 永远支持你的饼干岁 🍪

---
*注：此回复基于AI_HIGHLIGHT.txt内容生成，仅包含直播中提及的信息。*`;

fs.writeFileSync(mdPath, mdContent, 'utf8');
console.log(`✅ 创建MD文件: ${mdFilename}`);
console.log(`   文件大小: ${(mdContent.length / 1024).toFixed(1)}KB`);

// 2. 创建示例图片说明文件（模拟漫画生成）
const comicFilename = "2026_01_11_23_40_59_你好你好小悠复活_DDTV5_1_COMIC_FACTORY.txt";
const comicPath = path.join(targetDir, comicFilename);

const comicContent = `AI漫画生成结果说明
====================

文件: 2026_01_11_23_40_59_你好你好小悠复活_DDTV5_1_AI_HIGHLIGHT.txt
房间ID: 2026
参考图片: 岁己小红帽立绘.png (默认图片)
生成时间: 2026-01-13 20:31:00

🎨 漫画内容概述：
基于直播内容生成的漫画包含以下场景：

1. **开场场景**：悠亚在直播间打招呼，背景有"你好你好小悠复活"标题
2. **恐怖游戏时刻**：悠亚被游戏吓到尖叫，表情夸张可爱
3. **歌回片段**：悠亚唱歌时的温柔特写，有音乐符号环绕
4. **养猫话题**：悠亚模仿猫咪的傲娇表情
5. **弹幕互动**：屏幕上飘过"漂亮饭""阿肯苦力"等经典弹幕
6. **结尾场景**：悠亚挥手告别，有"晚安"字样

📐 技术信息：
- 使用模型: jbilcke-hf/ai-comic-factory
- 风格: Japanese Manga
- 布局: 6格漫画
- 参考图片: 岁己小红帽立绘.png (默认参考图)

⚠️ 注意：
实际AI漫画生成需要调用Hugging Face API，当前为模拟输出。
如需真实漫画图片，请确保API配置正确且网络连接正常。`;

fs.writeFileSync(comicPath, comicContent, 'utf8');
console.log(`✅ 创建漫画说明文件: ${comicFilename}`);
console.log(`   文件大小: ${(comicContent.length / 1024).toFixed(1)}KB`);

// 3. 列出文件夹中的所有文件
console.log('\n📂 文件夹内容:');
const files = fs.readdirSync(targetDir);
files.forEach(file => {
    const filePath = path.join(targetDir, file);
    const stats = fs.statSync(filePath);
    const size = (stats.size / 1024).toFixed(1);
    const isNew = file === mdFilename || file === comicFilename ? '[NEW]' : '     ';
    
    let icon = '📄';
    if (file.includes('_AI_HIGHLIGHT.txt')) icon = '🤖';
    if (file.includes('_晚安回复.md')) icon = '📝';
    if (file.includes('_COMIC_FACTORY')) icon = '🎨';
    if (file.includes('.xml')) icon = '📊';
    if (file.includes('.srt')) icon = '📺';
    if (file.includes('.mp4')) icon = '🎥';
    if (file.includes('.jpg')) icon = '🖼️';
    
    console.log(`   ${icon} ${isNew} ${file} (${size}KB)`);
});

// 4. 命名规则说明
console.log('\n📋 文件命名规则:');
console.log('================');
console.log('基础格式: {房间ID}_{日期}_{时间}_{内容类型}.{扩展名}');
console.log('');
console.log('示例:');
console.log('   📊 2026_01_11_23_40_59_你好你好小悠复活_DDTV5_1.xml');
console.log('   📺 2026_01_11_23_40_59_你好你好小悠复活_DDTV5_fix.srt');
console.log('   🤖 2026_01_11_23_40_59_你好你好小悠复活_DDTV5_1_AI_HIGHLIGHT.txt');
console.log('   📝 2026_01_11_23_40_59_你好你好小悠复活_DDTV5_1_晚安回复.md');
console.log('   🎨 2026_01_11_23_40_59_你好你好小悠复活_DDTV5_1_COMIC_FACTORY.png');
console.log('');
console.log('规则说明:');
console.log('1. 房间ID: 从文件名开头提取的数字 (如: 2026)');
console.log('2. 日期时间: YYYY_MM_DD_HH_mm_ss 格式');
console.log('3. 内容类型: 标识文件用途的关键词');
console.log('4. 扩展名: 表示文件格式');

console.log('\n🎉 示例文件创建完成！');
console.log('现在文件夹中包含了AI生成的标准输出文件。');