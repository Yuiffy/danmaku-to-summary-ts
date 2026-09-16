'use strict';
const { getTopicClipAiModel } = require('./topic_config');

async function verifyClipWithAI(window, keywords, config = {}) {
    const aiEnabled = config.ai?.text?.enabled !== false;
    const verifyEnabled = config.clipTopics?.aiVerify !== false; // default true
    if (!aiEnabled || !verifyEnabled) {
        return { verified: true, reason: 'AI验证未启用,默认通过' };
    }

    // Collect all segment texts in the window
    const sampleText = window.matchSegments
        ? window.matchSegments.map(m => m.text).join('\n')
        : '';

    // Also get broader context from all segments in the window
    const fullText = (window.allSegmentTexts || []).join('\n');

    if (!sampleText && !fullText) {
        return { verified: false, reason: '无字幕内容' };
    }

    const keywordList = (keywords || []).join('、') || '岁己';

    const prompt = [
        '你是一个直播字幕审核助手。以下是一段直播字幕片段,其中 ASR(语音识别)在部分句子里检测到了关键词。',
        '但 ASR 常常在以下情况产生误识别:',
        '- 主播在唱歌或哼旋律时,歌词被误识别为包含关键词',
        '- 日文/英文歌词被错误识别为中文并凑巧包含关键词',
        '- 语速快或含糊时的发音被错误识别',
        '- 感谢观众礼物时的乱码碰巧包含关键词',
        '',
        `关键词: ${keywordList}`,
        '请判断:这段字幕是否真的在**提到或谈论**关键词所指的虚拟主播?',
        '',
        '判断标准:',
        '- 主播明确说出该主播的名字(如"给你们看岁己"、"岁己今天直播了吗")→ 是',
        '- 主播在唱歌,歌词碰巧被识别为包含关键词 → 否',
        '- 上下文完全不涉及该主播,只是发音相似 → 否',
        '- 游戏道具"粉碎机"被音素纠正写成"粉岁己/粉粉岁己"(采石场/升级/石头/研磨等语境) → 否',
        '- 感谢礼物时的乱码碰巧包含关键词 → 否',
        '',
        '请只回复 JSON:{"verified": true/false, "reason": "一句话解释"}',
        '不要输出其他内容。',
        '',
        '命中关键词的句子:',
        sampleText || '(无)',
        '',
        '完整上下文:',
        (fullText || sampleText).slice(0, 500)
    ].join('\n');

    try {
        const provider = config.ai?.text?.provider || 'gemini';
        // Use the existing AI infrastructure
        const { generateTextWithTuZi, generateTextWithGemini, generateTextWithDaiYu } = require('../ai_text_generator');
        const result = provider === 'tuZi'
            ? await generateTextWithTuZi(prompt, {
                wordLimit: 100,
                primaryModel: getTopicClipAiModel(config)
            })
            : provider === 'daiYu'
            ? await generateTextWithDaiYu(prompt, {
                wordLimit: 100,
                primaryModel: getTopicClipAiModel(config)
            })
            : await generateTextWithGemini(prompt, { wordLimit: 100 });

        const text = (result.text || '').trim();
        // Parse JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                verified: !!parsed.verified,
                reason: parsed.reason || '',
                model: result.meta?.model || getTopicClipAiModel(config)
            };
        }
        // If can't parse, be conservative and keep the clip
        return {
            verified: true,
            reason: 'AI响应解析失败,保留切片',
            model: result.meta?.model || getTopicClipAiModel(config)
        };
    } catch (error) {
        console.warn(`⚠️  AI验证失败,保留切片: ${error.message}`);
        return { verified: true, reason: `AI调用失败: ${error.message}`, model: getTopicClipAiModel(config) };
    }
}

module.exports = { verifyClipWithAI };

