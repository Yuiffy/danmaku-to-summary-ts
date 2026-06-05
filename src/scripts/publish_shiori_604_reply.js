#!/usr/bin/env node
/**
 * 手动发布栞栞 6/4 晚场晚安回复到 B站
 */
const path = require('path');
const fs = require('fs');

const RECORDING_DIR = 'D:\\files\\videos\\DDTV录播\\26966466_栞栞Shiori\\2026_06_04';
const BASE_NAME = '录制-26966466-20260604-201307-648-海獭大战小鸟！_merged';
const STREAMER_UID = '1609526545';

async function main() {
    // 1. Read reply text
    const replyPath = path.join(RECORDING_DIR, `${BASE_NAME}_晚安回复.md`);
    const raw = fs.readFileSync(replyPath, 'utf-8');
    const text = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
    console.log('晚安回复:', text.substring(0, 60) + '...');

    // 2. Find comic image
    const comicPath = path.join(RECORDING_DIR, `${BASE_NAME}_COMIC_FACTORY.png`);
    console.log('漫画图:', fs.existsSync(comicPath) ? comicPath : '不存在');

    // 3. Init API
    const { BilibiliAPIService } = require('./dist/services/bilibili/BilibiliAPIService.js');
    const { ConfigProvider } = require('./dist/core/config/ConfigProvider.js');
    await ConfigProvider.initialize();
    const api = new BilibiliAPIService();

    // 4. Get dynamics
    console.log('\n获取栞栞动态...');
    const dynamics = await api.getDynamics(STREAMER_UID);
    console.log(`找到 ${dynamics.length} 条动态`);
    dynamics.slice(0, 3).forEach((d, i) => {
        console.log(`  [${i}] ${d.id} [${d.type}] ${d.content.substring(0, 50)} (${d.publishTime.toISOString()})`);
    });

    if (dynamics.length === 0) {
        console.error('没有动态可回复');
        process.exit(1);
    }

    const target = dynamics[0];
    console.log(`\n目标动态: ${target.url}`);

    // 5. Publish
    console.log('发布评论...');
    const result = await api.publishComment({
        dynamicId: target.id,
        content: text,
        images: fs.existsSync(comicPath) ? [comicPath] : [],
    });

    console.log(`\n✅ 发布成功! replyId: ${result.replyId}`);
    console.log(`链接: https://www.bilibili.com/opus/${target.id}#reply${result.replyId}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
