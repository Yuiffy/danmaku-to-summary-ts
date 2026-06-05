#!/usr/bin/env node
/**
 * 批量补发 5 个受影响录播的晚安回复 + 漫画
 * 由于 mediaResult is not defined bug，这些录播只有 highlight 没有 AI 生成内容
 *
 * 流程：
 *   1. 从 _AI_HIGHLIGHT.txt 生成 _晚安回复.md
 *   2. 从 _AI_HIGHLIGHT.txt 生成 _COMIC_FACTORY.png
 *   3. 获取主播最新动态，发布评论（文本+图片）
 *   4. 发送企业微信留档
 */

const path = require('path');
const fs = require('fs');

// 项目根目录
const PROJECT_ROOT = 'D:\\workspace\\myrepo\\danmaku-to-summary-ts';
process.chdir(PROJECT_ROOT);

// 导入项目模块（使用 src/scripts 下的模块）
const aiTextGenerator = require('./ai_text_generator');
const aiComicGenerator = require('./ai_comic_generator');

// 受影响的录播列表
const RECORDINGS = [
    {
        roomId: '23222837',
        baseName: '录制-23222837-20260605-092819-231-早安小龙！',
        dir: 'D:\\files\\videos\\DDTV录播\\23222837_礼墨Sumi\\2026_06_05',
        anchorName: '礼墨Sumi',
    },
    {
        roomId: '31368705',
        baseName: '录制-31368705-20260605-080419-975-早安一会儿',
        dir: 'D:\\files\\videos\\DDTV录播\\31368705_米汀Nagisa\\2026_06_05',
        anchorName: '米汀Nagisa',
    },
    {
        roomId: '1741667419',
        baseName: '录制-1741667419-20260605-090409-782-早茶第六十二天。',
        dir: 'D:\\files\\videos\\DDTV录播\\1741667419_十六萤Izayoi\\2026_06_05',
        anchorName: '十六萤Izayoi',
    },
    {
        roomId: '1986461465',
        baseName: '录制-1986461465-20260605-101049-571-早餐后健身环~',
        dir: 'D:\\files\\videos\\DDTV录播\\1986461465_克罗雅Kloa\\2026_06_05',
        anchorName: '克罗雅Kloa',
    },
    {
        roomId: '25971921',
        baseName: '录制-25971921-20260605-104313-293-【歌杂】恶龙早播！_merged',
        dir: 'D:\\files\\videos\\DDTV录播\\25971921_伊索尔Sol\\2026_06_05',
        anchorName: '伊索尔Sol',
    },
];

async function main() {
    console.log('='.repeat(60));
    console.log('  批量补发晚安回复 + 漫画 (2026-06-05 早场 bug 受影响)');
    console.log('='.repeat(60));

    // 加载 BilibiliAPIService 和 WeChatWorkNotifier
    const { BilibiliAPIService } = require(path.join(PROJECT_ROOT, 'dist/services/bilibili/BilibiliAPIService.js'));
    const { ConfigProvider } = require(path.join(PROJECT_ROOT, 'dist/core/config/ConfigProvider.js'));
    const { WeChatWorkNotifier } = require(path.join(PROJECT_ROOT, 'dist/services/notification/WeChatWorkNotifier.js'));

    await ConfigProvider.initialize();
    const api = new BilibiliAPIService();

    // 加载企微 webhook URL
    const secretRaw = fs.readFileSync(path.join(PROJECT_ROOT, 'config/secret.json'), 'utf-8');
    const secretConfig = JSON.parse(secretRaw.replace(/^\uFEFF/, ''));
    const webhookUrl = secretConfig.wechatWork?.webhookUrl;
    const notifier = webhookUrl ? new WeChatWorkNotifier(webhookUrl) : null;
    if (!notifier) {
        console.warn('⚠️  未配置企微 webhook，将跳过企微通知');
    }

    const results = [];

    for (let i = 0; i < RECORDINGS.length; i++) {
        const rec = RECORDINGS[i];
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[${i + 1}/${RECORDINGS.length}] ${rec.anchorName} (房间 ${rec.roomId})`);
        console.log(`    ${rec.baseName}`);
        console.log('='.repeat(60));

        const highlightPath = path.join(rec.dir, `${rec.baseName}_AI_HIGHLIGHT.txt`);
        const goodnightPath = path.join(rec.dir, `${rec.baseName}_晚安回复.md`);
        const comicPath = path.join(rec.dir, `${rec.baseName}_COMIC_FACTORY.png`);

        // 验证 highlight 文件
        if (!fs.existsSync(highlightPath)) {
            console.error(`❌ HIGHLIGHT 文件不存在: ${highlightPath}`);
            results.push({ ...rec, success: false, error: 'HIGHLIGHT 文件不存在' });
            continue;
        }

        // Step 1: 生成晚安回复
        let goodnightResult = null;
        if (fs.existsSync(goodnightPath)) {
            console.log(`ℹ️  晚安回复已存在，跳过: ${path.basename(goodnightPath)}`);
            goodnightResult = goodnightPath;
        } else {
            console.log('📝 Step 1: 生成晚安回复...');
            try {
                goodnightResult = await aiTextGenerator.generateGoodnightReply(highlightPath, rec.roomId);
                if (goodnightResult) {
                    console.log(`✅ 晚安回复生成成功: ${path.basename(goodnightResult)}`);
                } else {
                    console.error('❌ 晚安回复生成失败');
                }
            } catch (err) {
                console.error(`❌ 晚安回复生成异常: ${err.message}`);
                console.error(err.stack);
            }
        }

        // Step 2: 生成漫画
        let comicResult = null;
        if (fs.existsSync(comicPath)) {
            console.log(`ℹ️  漫画已存在，跳过: ${path.basename(comicPath)}`);
            comicResult = comicPath;
        } else {
            console.log('🎨 Step 2: 生成漫画...');
            try {
                comicResult = await aiComicGenerator.generateComicFromHighlight(highlightPath, rec.roomId, {
                    tuziRetryMaxAttempts: 2,
                    tuziBypassCooldown: false,
                });
                if (comicResult) {
                    console.log(`✅ 漫画生成成功: ${path.basename(comicResult)}`);
                } else {
                    console.warn('⚠️  漫画生成失败（非致命，继续发布文本）');
                }
            } catch (err) {
                console.warn(`⚠️  漫画生成异常: ${err.message}`);
            }
        }

        // Step 3: 读取晚安回复文本（去掉 frontmatter）
        if (!goodnightResult || !fs.existsSync(goodnightResult)) {
            console.error('❌ 没有晚安回复文件，跳过发布');
            results.push({ ...rec, success: false, error: '晚安回复生成失败' });
            continue;
        }

        const rawText = fs.readFileSync(goodnightResult, 'utf-8');
        const replyText = rawText.replace(/^---[\s\S]*?---\s*/, '').trim();
        console.log(`📝 晚安回复内容预览: ${replyText.substring(0, 80)}...`);

        // Step 4: 获取主播 UID 并查找最新动态
        console.log('🔍 Step 3: 获取主播 UID 和最新动态...');
        let uid;
        try {
            uid = await api.getUidByRoomId(rec.roomId);
        } catch (err) {
            console.error(`❌ 获取 UID 失败: ${err.message}`);
            results.push({ ...rec, success: false, error: `获取 UID 失败: ${err.message}` });
            continue;
        }

        if (!uid) {
            console.error(`❌ 无法解析房间 ${rec.roomId} 的 UID`);
            results.push({ ...rec, success: false, error: 'UID 解析为空' });
            continue;
        }
        console.log(`   UID: ${uid}`);

        let dynamics;
        try {
            dynamics = await api.getDynamics(uid);
        } catch (err) {
            console.error(`❌ 获取动态失败: ${err.message}`);
            results.push({ ...rec, success: false, error: `获取动态失败: ${err.message}` });
            continue;
        }

        if (!dynamics || dynamics.length === 0) {
            console.error(`❌ ${rec.anchorName} 没有动态可回复`);
            results.push({ ...rec, success: false, error: '没有动态' });
            continue;
        }

        const targetDynamic = dynamics[0];
        console.log(`   最新动态: ${targetDynamic.id} (${targetDynamic.publishTime.toISOString()})`);
        console.log(`   内容预览: ${targetDynamic.content.substring(0, 60)}...`);

        // Step 5: 发布评论
        console.log('📤 Step 4: 发布评论到动态...');
        let publishResult;
        try {
            publishResult = await api.publishComment({
                dynamicId: targetDynamic.id,
                content: replyText,
                images: comicResult && fs.existsSync(comicResult) ? [comicResult] : [],
            });
        } catch (err) {
            console.error(`❌ 发布评论失败: ${err.message}`);
            results.push({ ...rec, success: false, error: `发布失败: ${err.message}` });

            // 企微通知失败
            if (notifier) {
                await notifier.notifyReplyFailure(
                    targetDynamic.id,
                    err.message,
                    rec.anchorName,
                    replyText,
                    null,
                    comicResult,
                    null,
                    null
                );
            }
            continue;
        }

        console.log(`✅ 发布成功! replyId: ${publishResult.replyId}`);
        const replyUrl = `https://www.bilibili.com/opus/${targetDynamic.id}#reply${publishResult.replyId}`;
        console.log(`   链接: ${replyUrl}`);

        // Step 6: 企微留档
        if (notifier) {
            console.log('📧 Step 5: 发送企微留档...');
            try {
                await notifier.notifyReplySuccess(
                    targetDynamic.id,
                    publishResult.replyId,
                    rec.anchorName,
                    replyText,
                    publishResult.imageUrl || null,
                    comicResult || null,
                    null,
                    null
                );
                console.log('✅ 企微通知已发送');
            } catch (err) {
                console.warn(`⚠️  企微通知发送失败: ${err.message}`);
            }
        }

        results.push({
            ...rec,
            success: true,
            dynamicId: targetDynamic.id,
            replyId: publishResult.replyId,
            replyUrl,
            hasComic: !!comicResult,
        });

        // 等待一会再处理下一个，避免API频率限制
        if (i < RECORDINGS.length - 1) {
            console.log('⏳ 等待 10 秒后处理下一个...');
            await new Promise(r => setTimeout(r, 10000));
        }
    }

    // 汇总
    console.log(`\n${'='.repeat(60)}`);
    console.log('  📊 批量补发结果汇总');
    console.log('='.repeat(60));
    const success = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    console.log(`  ✅ 成功: ${success.length}`);
    console.log(`  ❌ 失败: ${failed.length}`);
    for (const r of results) {
        if (r.success) {
            console.log(`  ✅ ${r.anchorName} (${r.roomId}) -> ${r.replyUrl} ${r.hasComic ? '📷' : '📝'}`);
        } else {
            console.log(`  ❌ ${r.anchorName} (${r.roomId}) -> ${r.error}`);
        }
    }

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    console.error(err.stack);
    process.exit(1);
});
