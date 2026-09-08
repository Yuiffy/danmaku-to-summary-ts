'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ai = require('./ai_text_generator');
const full = require('./full_live_context');
const live = require('./live_generation_context');
const summary = require('./live_content_summary');
const combined = require('./full_reply_summary');
const review = require('./reply_summary_review');
const loader = require('./config-loader');

const MODE = 'compact_full_reply_summary_reviewed_v1';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();

function pathsFor(highlightPath) {
    const base = path.join(path.dirname(highlightPath), path.basename(highlightPath).replace(/_AI_HIGHLIGHT\.txt$/iu, ''));
    return { artifact: `${base}_REPLY_SUMMARY.json`, reply: `${base}_\u665a\u5b89\u56de\u590d.md`,
        summary: summary.getLiveContentSummaryPath(highlightPath) };
}

function atomicJson(file, value) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function createArtifact(file, text) {
    if (fs.existsSync(file)) return false;
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temp, text, 'utf8');
        try { fs.linkSync(temp, file); return true; }
        catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function readState(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Unreadable reply-summary state: ${error.message}`); }
}

function pendingError(message) {
    return Object.assign(new Error(message), { code: 'REPLY_SUMMARY_PENDING', stopPostStreamGeneration: true });
}

function acquireLocks(files) {
    const owned = [];
    try {
        for (const file of files) {
            const fd = fs.openSync(`${file}.lock`, 'wx');
            try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: now() })); }
            finally { fs.closeSync(fd); }
            owned.push(`${file}.lock`);
        }
    } catch (error) {
        for (const file of owned) fs.unlinkSync(file);
        if (error.code === 'EEXIST') throw pendingError('Reply or summary is owned by another generation process');
        throw error;
    }
    return () => { for (const file of owned) if (fs.existsSync(file)) fs.unlinkSync(file); };
}

function outcomeUnknown(error, attempts) {
    return error.outcomeUnknown === true || attempts.some(a => a.outcomeUnknown === true || a.usageFinal === false
        || ['queued','in_progress'].includes(a.finishReason)
        || (a.requestStarted === true && a.status === 'failure' && (!a.httpStatus || (a.httpStatus >= 200 && a.httpStatus < 300)) && a.usageFinal !== true));
}

function materialize(state, files, highlightPath, fullPayload, reused = true) {
    if (state.outputSha256 !== sha(JSON.stringify(state.output))) throw new Error('Combined output integrity check failed');
    const metadata = { provider: state.provider, model: state.model, fallback: false, attempts: state.attempts,
        finishReason: 'completed', generationMode: MODE, sharedUsagePath: path.basename(files.artifact), sharedGenerationId: state.generationId };
    const replyText = ai.buildTextFrontMatter(highlightPath, metadata) + state.output.reply;
    const summaryPayload = {
        schemaVersion: summary.LIVE_CONTENT_SCHEMA_VERSION, status: 'success', roomId: state.roomId,
        source: { coverage: 'full_srt_and_merged_danmaku', sourceSha256: fullPayload.sourceSha256,
            sharedPrefixSha256: fullPayload.sharedPrefixSha256, fullLiveSharedPrefixVersion: fullPayload.fullLiveSharedPrefixVersion,
            promptVersion: summary.LIVE_CONTENT_PROMPT_VERSION, counts: fullPayload.counts },
        content: state.output.content, generatedAt: state.finishedAt,
        generation: { provider: state.provider, model: state.model, mode: MODE, attempts: [],
            sharedUsagePath: path.basename(files.artifact), usageIncludedInGoodnight: true,
            sharedGenerationId: state.generationId, semanticReview: state.semanticReview }
    };
    createArtifact(files.summary, JSON.stringify(summaryPayload, null, 2) + '\n');
    createArtifact(files.reply, replyText);
    console.log(`[REPLY_SUMMARY_READY] ${JSON.stringify({ roomId: state.roomId, mode: MODE, reused,
        goodnightTextPath: files.reply, liveContentSummaryPath: files.summary, usagePath: files.artifact })}`);
    return { handled: true, goodnightTextPath: files.reply, liveContentSummaryPath: files.summary, statePath: files.artifact };
}

async function tryGenerateCombinedReply(highlightPath, roomId, options = {}) {
    const config = options.config || loader.getConfig();
    const room = config.ai?.roomSettings?.[String(roomId)] || {};
    const experiment = room.fullLiveContextExperiment;
    if (config.ai?.text?.enabled === false || (config.ai?.text?.provider && config.ai.text.provider !== 'daiYu')
        || !experiment?.enabled || experiment.replySummary?.enabled !== true
        || !['goodnight','summary'].every(t => experiment.tasks?.includes(t))) return { handled: false };
    const files = pathsFor(highlightPath);
    let previous = readState(files.artifact);
    if (['in_progress','outcome_unknown'].includes(previous?.status)) {
        throw pendingError(`Combined request outcome is unresolved; inspect ${files.artifact} before resubmitting`);
    }
    if (fs.existsSync(files.reply) && fs.existsSync(files.summary)) return { handled: false, reason: 'existing-artifacts' };
    const payload = full.loadFullLiveContextSidecar(options.fullLiveContextPath || highlightPath);
    if (payload?.evidenceVersion !== 2 || !payload.evidence) return { handled: false, reason: 'indexed-full-source-unavailable' };
    if (payload.roomId && payload.roomId !== String(roomId)) throw new Error('Combined source belongs to another room');
    const context = live.loadLiveGenerationContext(highlightPath, roomId, config);
    const wordLimit = room.wordLimit ?? config.ai?.defaultWordLimit ?? 100;
    const model = experiment.model || 'gpt-5.6-luna';
    const fingerprint = sha(JSON.stringify({ mode: MODE, source: payload.sharedPrefixSha256, model, wordLimit,
        context: live.formatLiveGenerationContext(context), room: { anchorName: room.anchorName, fanName: room.fanName,
            customPrompts: room.customPrompts }, promptVersion: combined.PROMPT_VERSION, reviewVersion: review.REVIEW_VERSION }));
    const release = acquireLocks([files.artifact, files.reply, files.summary]);
    try {
        previous = readState(files.artifact);
        if (['in_progress','outcome_unknown'].includes(previous?.status)) throw pendingError('Combined generation is unresolved');
        if (previous?.status === 'success' && previous.fingerprint === fingerprint) return materialize(previous,files,highlightPath,payload);
        if (fs.existsSync(files.reply) || fs.existsSync(files.summary)) return { handled: false, reason: 'preserve-existing-artifacts' };
        if (previous?.status === 'failed' && previous.fingerprint === fingerprint) return { handled: false, reason: 'reuse-terminal-fallback' };
        const source = combined.evidenceContext(payload.evidence.speech,
            payload.evidence.audience.map(row => ({time:row.start,text:row.text})), roomId, config, payload.evidence);
        let state = { schemaVersion: 1, mode: MODE, status: 'in_progress', generationId: crypto.randomUUID(),
            roomId: String(roomId), provider: 'daiYu', model, fingerprint, ownerPid: process.pid,
            startedAt: now(), sourceSha256: payload.sourceSha256, sharedPrefixSha256: payload.sharedPrefixSha256,
            attempts: previous?.attempts || [], phases: [], wordLimit };
        atomicJson(files.artifact,state);
        const generate = options.generateText || ai.generateTextWithDaiYu;
        const requestOptions = { primaryModel: model, exactModel: true, strictEvaluation: true, apiMode: 'responses',
            reasoningEffort: 'high', wordLimit, maxTokens: 12000, timeoutMs: 300000, promptCacheRolloutPercent: 100 };
        const phase = async (name, prompt, extra) => {
            const startedAt = Date.now();
            state = { ...state, activePhase: name };
            atomicJson(files.artifact,state);
            try {
                const result = await generate(prompt,{...requestOptions,...extra});
                const attempts = (result.meta?.attempts || []).map(a=>({...a,phase:name}));
                state.attempts.push(...attempts);
                state.phases.push({name,status:'success',elapsedMs:Date.now()-startedAt,promptSha256:sha(prompt)});
                atomicJson(files.artifact,state);
                return result;
            } catch(error) {
                const attempts = (error.attempts || []).map(a=>({...a,phase:name}));
                state.attempts.push(...attempts);
                state.phases.push({name,status:'failure',elapsedMs:Date.now()-startedAt});
                error.combinedOutcomeUnknown = outcomeUnknown(error,attempts);
                throw error;
            }
        };
        try {
            const prompt = combined.buildCombinedPrompt({ fullPrefix: payload.sharedPrefix,
                highlight: fs.readFileSync(highlightPath,'utf8'), roomId, context, source });
            const reusableDraft = previous?.draft && previous.sourceSha256 === payload.sourceSha256
                && previous.phases?.some(p=>p.name==='reply-summary' && ['success','reused'].includes(p.status) && p.promptSha256===sha(prompt));
            const draft = reusableDraft ? {text:previous.draft} : await phase('reply-summary',prompt,{});
            if (reusableDraft) state.phases.push({name:'reply-summary',status:'reused',elapsedMs:0,promptSha256:sha(prompt)});
            state.draft = draft.text;
            const output = combined.validateCombinedResult(draft.text,source,roomId,wordLimit);
            const packet = review.buildReviewPacket(output,source);
            const checked = await phase('evidence-review',review.buildReviewPrompt(output,packet,source,context,wordLimit),
                {maxTokens:6000,timeoutMs:180000});
            const result = review.applyReview(checked.text,output,packet,source,roomId,wordLimit);
            state = {...state,status:'success',output:result.output,semanticReview:result.review,
                reviewSourceChars:packet.text.length,reviewSourceRows:packet.rowCount,finishedAt:now(),
                replyBodySha256:sha(result.output.reply),outputSha256:sha(JSON.stringify(result.output)),activePhase:null};
            atomicJson(files.artifact,state);
            return materialize(state,files,highlightPath,payload,false);
        } catch(error) {
            if (state.status === 'success') throw error;
            state = {...state,status:error.combinedOutcomeUnknown?'outcome_unknown':'failed',
                error:String(error.message),finishedAt:now(),activePhase:null};
            atomicJson(files.artifact,state);
            console.warn(`[REPLY_SUMMARY_FAILURE] ${JSON.stringify({roomId,state:state.status,reason:state.error,usagePath:files.artifact})}`);
            if(error.combinedOutcomeUnknown)throw pendingError('Combined provider outcome is unknown; no new AI task will be submitted');
            return {handled:false,reason:'terminal-combined-failure',statePath:files.artifact};
        }
    } finally { release(); }
}

module.exports = { MODE, pathsFor, tryGenerateCombinedReply, outcomeUnknown };
