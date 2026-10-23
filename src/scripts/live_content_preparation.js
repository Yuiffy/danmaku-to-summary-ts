'use strict';
const fs = require('fs');
const path = require('path');
const configLoader = require('./config-loader');
const liveContentSummary = require('./live_content_summary');
const fullLiveContext = require('./full_live_context');
const ownStreamClipper = require('./own_stream_clipper');
const asrBackends = require('./asr/asr_backends');
const { sourceInputs } = require('./clipping/stream_activity_timeline');

async function prepareFullLiveContextForExperiment(options = {}) {
    const { highlightPath, roomId, srtPath, xmlPath, mediaPath, context = {}, pendingPayload = null } = options;
    const config = options.config || configLoader.getConfig();
    const experiment = liveContentSummary.getFullLiveContextExperiment(config, roomId);
    if (!experiment) return null;
    const enabledTasks = Array.isArray(experiment.tasks) ? experiment.tasks.map(String) : [];
    if (!enabledTasks.length) return null;
    if (!srtPath || !fs.existsSync(srtPath)) throw new Error('全量输入实验缺少 SRT 文件');
    if (!xmlPath || !fs.existsSync(xmlPath)) throw new Error('全量输入实验缺少弹幕 XML 文件');
    const parsed = require('./asr/speaker_attribution').loadSrtWithSpeakerEvidence(srtPath, asrBackends.parseSrt, 'full_live_context');
    const danmaku = await ownStreamClipper.parseDanmakuXml(xmlPath);
    const clipConfig = { ...ownStreamClipper.getOwnStreamClipsConfig(config, roomId),
        ...((experiment.compactEvidence === true || experiment.replySummary?.enabled === true) ? { compactEvidence: true } : {}) };
    const emotionAnalysis = ownStreamClipper.loadEmotionAnalysisForSrt(srtPath);
    const info = ownStreamClipper.parseRecordingInfo(mediaPath || srtPath, { ...context, roomId: roomId ? String(roomId) : null });
    const sharedContext = fullLiveContext.buildFullLiveSharedContext({ parsed, danmaku, config: clipConfig, emotionAnalysis,
        info, totalDuration: Number(parsed.segments?.at(-1)?.end || 0) });
    const saved = fullLiveContext.saveFullLiveContextSidecar(highlightPath, sharedContext, { inputSources: sourceInputs(srtPath, xmlPath) });
    if (pendingPayload) {
        pendingPayload.fullLiveContextPath = saved.outputPath;
        pendingPayload.liveContentSummaryPath = liveContentSummary.getLiveContentSummaryPath(highlightPath);
    }
    console.log(`🧱 全量直播共享输入已保存: ${path.basename(saved.outputPath)}`);
    console.log(`   字幕=${saved.payload.counts.subtitleLines}, 弹幕=${saved.payload.counts.rawDanmaku}->${saved.payload.counts.mergedDanmaku}, prefixChars=${Array.from(saved.payload.sharedPrefix).length}`);
    console.log(`   sourceSha256=${saved.payload.sourceSha256}, sharedPrefixSha256=${saved.payload.sharedPrefixSha256}`);
    return { experiment, enabledTasks, outputPath: saved.outputPath, payload: saved.payload };
}
async function prepareCampaignContentSummary(options) {
    const { config, roomId, clipConfig } = options;
    const experiment = require('./workflow-runtime').loadWorkflow('clipping/ownCampaign').campaignSummaryExperiment(
        clipConfig, liveContentSummary.getFullLiveContextExperiment(config, roomId));
    if (!experiment) throw new Error('活动游戏判断缺少有效的活动配置');
    const base = path.join(path.dirname(options.mediaPath), path.parse(options.mediaPath).name);
    const summaryPath = options.liveContentSummaryPath || `${base}_LIVE_CONTENT.json`;
    const highlightPath = summaryPath.replace(/_LIVE_CONTENT\.json$/iu, '_AI_HIGHLIGHT.txt');
    const contextPath = options.fullLiveContextPath || fullLiveContext.getFullLiveContextPath(highlightPath);
    const inputs = sourceInputs(options.srtPath, options.xmlPath);
    let prepared;
    try {
        const existing = fullLiveContext.loadFullLiveContextSidecar(contextPath);
        if (String(existing?.roomId) === String(roomId) && existing?.inputSources?.srtSha256 === inputs.srtSha256
            && existing?.inputSources?.xmlSha256 === inputs.xmlSha256) prepared = { outputPath: contextPath };
    } catch { /* Invalid context is rebuilt from the current original text sources. */ }
    if (!prepared) prepared = await prepareFullLiveContextForExperiment({ ...options, highlightPath,
        config: { ...config, ai: { ...config.ai, roomSettings: { ...config.ai?.roomSettings,
            [roomId]: { ...config.ai?.roomSettings?.[roomId], fullLiveContextExperiment: experiment } } } } });
    if (!prepared) throw new Error('活动游戏全文证据准备失败');
    console.log('准备活动游戏判断摘要：复用当前完整字幕和弹幕，不重跑 ASR。');
    await liveContentSummary.generateLiveContentSummary({ ...options, highlightPath, outputPath: summaryPath,
        fullLiveContextPath: prepared.outputPath, experiment, includeActivityTimeline: false });
    return { fullLiveContextPath: prepared.outputPath, liveContentSummaryPath: summaryPath };
}

module.exports = { prepareFullLiveContextForExperiment, prepareCampaignContentSummary };
