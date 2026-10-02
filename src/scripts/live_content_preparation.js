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
    const clipConfig = { ...ownStreamClipper.getOwnStreamClipsConfig(config),
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
module.exports = { prepareFullLiveContextForExperiment };
