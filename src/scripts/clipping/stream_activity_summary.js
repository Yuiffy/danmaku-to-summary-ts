'use strict';
const fs = require('fs');
const path = require('path');
const asr = require('../asr/asr_backends');
const fullContext = require('../full_live_context');
const { fileDigest } = require('./source_snapshot');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { sha } = require('./stream_activity_plan');
const { TIMELINE_VERSION, timelineInstructions, evidenceFromContext, normalizeTimeline, sourceInputs } = require('./stream_activity_timeline');
async function summaryInputs({ options, source, transcript, info, directory, duration, audience }) {
    const base = path.join(path.dirname(source.mediaPath), path.basename(source.mediaPath, path.extname(source.mediaPath)));
    const highlightPath = `${base}_AI_HIGHLIGHT.txt`;
    const inputs = sourceInputs(transcript.path, source.xmlPath);
    const suppliedPath = options.fullLiveContextPath || `${base}_FULL_LIVE_CONTEXT.json`;
    let context = fs.existsSync(suppliedPath) ? require('../live_content_summary').loadFullContextPayload(highlightPath, suppliedPath) : null;
    const matches = context?.inputSources ? context.inputSources.srtSha256 === inputs.srtSha256
        && context.inputSources.xmlSha256 === inputs.xmlSha256 : transcript.mode === 'source_srt';
    if (!context?.evidence || !matches) {
        // Building the shared input is local work; it does not scan the video or call ASR/AI.
        const shared = fullContext.buildFullLiveSharedContext({ parsed: asr.parseSrt(transcript.path), danmaku: audience,
            config: { compactEvidence: true }, info, totalDuration: duration });
        context = fullContext.createFullLiveContextSidecar(shared, { inputSources: inputs });
        const contextPath = path.join(directory, 'temp', 'summary-source', `${sha(inputs)}.json`);
        fs.mkdirSync(path.dirname(contextPath), { recursive: true });
        writeJsonAtomic(contextPath, context);
        return { context, contextPath, inputs, highlightPath, summaryPath: options.summaryPath || path.join(directory, 'SUMMARY.json') };
    }
    return { context, contextPath: suppliedPath, inputs, highlightPath,
        summaryPath: options.summaryPath || suppliedPath.replace(/_FULL_LIVE_CONTEXT\.json$/iu, '_LIVE_CONTENT.json') };
}
async function getActivitySummary(args) {
    const input = await summaryInputs(args);
    const summary = require('../live_content_summary');
    const experiment = summary.getFullLiveContextExperiment(args.options.config, args.info.roomId) || {};
    const result = await (args.options.generateSummary || summary.generateLiveContentSummary)({
        highlightPath: input.highlightPath, fullLiveContextPath: input.contextPath, outputPath: input.summaryPath,
        roomId: args.info.roomId, config: args.options.config, includeActivityTimeline: true,
        srtPath: args.transcript.path, xmlPath: args.source.xmlPath,
        experiment: { ...experiment, enabled: true, tasks: ['summary'], maxAttempts: 1 }
    });
    let payload = result?.payload;
    if (result?.pending) {
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline && fs.existsSync(`${input.summaryPath}.lock`)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!fs.existsSync(`${input.summaryPath}.lock`) && fs.existsSync(input.summaryPath)) payload = JSON.parse(fs.readFileSync(input.summaryPath, 'utf8'));
    }
    if (payload?.status !== 'success' || payload.source?.sourceSha256 !== input.context.sourceSha256
        || payload.source?.activityTimelineVersion !== TIMELINE_VERSION
        || payload.source?.inputSources?.srtSha256 !== input.inputs.srtSha256
        || payload.source?.inputSources?.xmlSha256 !== input.inputs.xmlSha256) throw new Error('A matching completed summary activity timeline is not ready; no separate full-stream scan was started');
    const timeline = normalizeTimeline(payload.activityTimeline, input.context);
    return { ...input, timeline, payload, reused: result?.reused === true,
        rows: evidenceFromContext(input.context), sha256: fileDigest(input.summaryPath) };
}
module.exports = { TIMELINE_VERSION, timelineInstructions, evidenceFromContext, normalizeTimeline, sourceInputs, summaryInputs, getActivitySummary };
