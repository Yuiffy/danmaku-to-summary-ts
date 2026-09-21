'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { clipId } = require('./own_review_report');
const { sendWeChatMarkdown } = require('../wechat_work_markdown');

function completionMarkdown(results, metadata) {
    const selected = metadata.precisionDelivery.selected;
    const rows = selected.map(item => ({ item, result: results.find(row => (row.reviewIndex ?? row.window?.index) === item.index) }));
    const passed = rows.every(({ result }) => result?.creativeResult?.status === 'edited' && result?.qaResult?.status === 'passed');
    const lines = [passed ? '## 精切完成' : '## 精切处理结束', `直播: ${metadata.streamTitle || metadata.sourceFileName || '未知'}`];
    if (['not_sent', 'unknown'].includes(metadata.precisionDelivery.ordinaryNotification)) lines.push('此前普通清单通知未确认送达，普通成片和编号可在下方完整清单中查看。');
    for (const { item, result } of rows) {
        const id = result && clipId(result, metadata);
        lines.push('', `${id ? `ID${id}` : `候选${item.index}`} ${result?.copy?.title || item.title}`);
        if (result?.creativeResult?.status === 'edited' && result.qaResult?.status === 'passed') {
            const effects = result.creativePlan.effects;
            const counts = [['zoom', '运镜'], ['faceInset', '圆形特写'], ['focusInset', '原地放大'], ['sticker', '贴纸'], ['sound', '音效'], ['filter', '滤镜']]
                .map(([key, label]) => `${label}${effects.filter(row => row[key]).length}处`).join('、');
            lines.push(`已完成：${counts}；耗时 ${(result.creativeResult.elapsedMs / 60000).toFixed(1)} 分钟。`,
                result.uploadReady ? '状态：成片待审核。' : '状态：成片已生成，仍需复核。');
        } else lines.push(result?.output?.mediaPath && !result.output.mediaError ? '精切未通过或无合适效果，已保留普通版供审核。' : '精切制作失败，待处理。',
            `原因：${result?.creativeResult?.reason || result?.output?.mediaError || '渲染任务未返回成片'}`);
        if (result?.output?.mediaPath) lines.push(`视频：${result.output.mediaPath}`);
    }
    lines.push('', `完整清单：${metadata.reviewPath}`, '本次仅制作并登记审核编号，未自动投稿。');
    return lines.join('\n');
}

async function notifyPrecisionDelivery(results, metadata, rootConfig, buildList) {
    const webhook = rootConfig.wechatWork?.webhookUrl;
    if (rootConfig.ownStreamClips?.notify?.enabled === false || !webhook) return false;
    const phase = metadata.precisionDelivery.phase;
    const ordinary = phase === 'ordinary_ready';
    let content;
    if (ordinary) {
        const pending = metadata.precisionDelivery.selected.map(row => `正在把候选${row.index}《${row.title}》制作成精切，完成后另行通知。`).join('\n');
        content = `## 普通切片已完成\n${pending}\n\n${buildList(results, metadata)}`;
    } else content = completionMarkdown(results, metadata);
    const receiptPath = metadata.reviewPath.replace(/\.md$/i, `_DELIVERY_${phase}.json`);
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    let previous;
    if (fs.existsSync(receiptPath)) previous = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (previous?.status === 'sent' && previous.digest === digest) return true;
    if (previous?.status === 'sending' || previous?.status === 'unknown') {
        console.warn(`Precision notification outcome unresolved; local receipt: ${receiptPath}`); return false;
    }
    writeJsonAtomic(receiptPath, { status: 'sending', phase, digest, startedAt: new Date().toISOString() });
    try {
        const sent = await sendWeChatMarkdown(webhook, content, { timeout: 30000 });
        writeJsonAtomic(receiptPath, { status: sent ? 'sent' : 'disabled', phase, digest, completedAt: new Date().toISOString() });
        return sent;
    } catch (error) {
        // A timeout or partially sent split message must not be repeated automatically.
        writeJsonAtomic(receiptPath, { status: 'unknown', phase, digest, error: error.message });
        throw error;
    }
}

module.exports = { completionMarkdown, notifyPrecisionDelivery };
