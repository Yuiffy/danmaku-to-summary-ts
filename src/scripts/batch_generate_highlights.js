const fs = require('fs');
const path = require('path');
const { processLiveData } = require('./do_fusion_summary');

// ====== 📂 目标目录配置 ======
const TARGET_DIRS = [
    'D:\\files\\videos\\DDTV录播\\25788785_岁己SUI\\',
    'E:\\EFiles\\Evideo\\DDTV录播-E\\25788785_岁己SUI'
];

async function scanAndProcess(dir) {
    console.log(`🔍 正在扫描目录: ${dir}`);
    if (!fs.existsSync(dir)) {
        console.warn(`⚠️ 目录不存在，跳过: ${dir}`);
        return;
    }

    const items = fs.readdirSync(dir);
    
    // 1. 先找出所有的 .srt 文件
    const srtFiles = items.filter(item => item.toLowerCase().endsWith('.srt'));
    
    for (const srtFile of srtFiles) {
        const srtPath = path.join(dir, srtFile);
        const baseDir = path.dirname(srtPath);
        const baseName = path.basename(srtPath).replace(/\.srt$/i, '').replace(/_fix$/, '');
        const highlightFile = path.join(baseDir, `${baseName}_AI_HIGHLIGHT.txt`);

        // 2. 检查总结是否已存在
        if (fs.existsSync(highlightFile)) {
            // console.log(`⏭️ 总结已存在，跳过: ${srtFile}`);
            continue;
        }

        console.log(`🚀 发现缺失总结的 SRT: ${srtFile}`);

        // 3. 寻找相关的弹幕文件 (XML)
        // 逻辑：找同名前缀的 XML
        const xmlFiles = items.filter(item => 
            item.toLowerCase().endsWith('.xml') && 
            item.toLowerCase().startsWith(baseName.toLowerCase())
        ).map(item => path.join(dir, item));

        // 4. 调用生成逻辑
        const processFiles = [srtPath, ...xmlFiles];
        try {
            await processLiveData(processFiles);
        } catch (err) {
            console.error(`❌ 处理时出错 ${srtFile}:`, err);
        }
    }

    // 5. 递归处理子目录
    for (const item of items) {
        const fullPath = path.join(dir, item);
        if (fs.statSync(fullPath).isDirectory()) {
            await scanAndProcess(fullPath);
        }
    }
}

async function main() {
    console.log('🌟 开始批量补生成 AI 总结...');
    for (const dir of TARGET_DIRS) {
        await scanAndProcess(dir);
    }
    console.log('✅ 所有任务处理完成！');
}

main();
