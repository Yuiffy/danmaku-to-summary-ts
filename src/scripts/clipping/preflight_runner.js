'use strict';

const { requestSelectionText } = require('./selection_request');
const { buildPreflightInput, buildPreflightPrompt } = require('./preflight_evidence');
const { normalizePreflightResponse } = require('./preflight_plan');
const { buildFallbackAiClipSelection } = require('./topic_selection');
const fs = require('fs');
const crypto = require('crypto');
const { loadVerifiedTopicFacts } = require('./preflight_facts');
const { buildQualityDraftPrompt, buildQualityAuditPrompt, applyQualityAudit } = require('./preflight_quality');
const { DEFAULT_CLIP_TOPICS_CONFIG } = require('./topic_config');

function sourceFileHash(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function persistPreflightPlan(file, source, sourceHash, groups, candidates, diagnostics, selectedCandidates = candidates) {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, strategy: 'preflight_v1', status: 'prepared_before_render',
            source, sourceSrtSha256: sourceHash, groups, candidates: candidates.map(clip => ({
                window: clip.window, editorial: clip.editorial, preflight: clip.preflight, selected: selectedCandidates.includes(clip) })),
            requests: diagnostics.requests, failures: diagnostics.failures }, null, 2), 'utf8');
        fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch { /* already renamed */ } }
}

function isPreflightEnabled(config) {
    return config.review?.enabled === true && config.review.mode === 'preflight';
}

function preflightRequestOptions(config) {
    return { primaryModel: config.review.model || config.aiModel, exactModel: true,
        reasoningEffort: config.review.reasoningEffort || 'max', apiMode: 'responses', strictResponses: true,
        allowProviderFallback: false, fallbackModelsEnabled: false, transientMaxAttempts: 1,
        daiYuTransientMaxAttempts: config.review.transientMaxAttempts ?? DEFAULT_CLIP_TOPICS_CONFIG.review.transientMaxAttempts,
        timeoutMs: config.review.timeoutMs || DEFAULT_CLIP_TOPICS_CONFIG.review.timeoutMs,
        maxTokens: config.review.maxOutputTokens || 24000, wordLimit: 2500 };
}

function requestMatches(result, settings) {
    const actual = result.meta?.attempts?.at(-1);
    // Providers may resolve the requested model alias to a newer model. Keep the
    // returned name in request diagnostics, without rejecting that response.
    return Boolean(actual && !result.meta?.fallback && actual.model === settings.primaryModel
        && actual.apiModeUsed === 'responses' && actual.reasoningEffortSent === settings.reasoningEffort
        && (!actual.reasoningEffortReturned || actual.reasoningEffortReturned === settings.reasoningEffort));
}

async function prepareTopicGroup(group, evidence, config, rootConfig, source, diagnostics, options = {}) {
    const buildInput = context => {
        const verified = loadVerifiedTopicFacts(source.srtPath, context, config.review.verifiedFactsPath);
        return buildPreflightInput(context, evidence, config, { ...source,
            verifiedFacts: [...(source.verifiedFacts || []), ...verified.verifiedFacts],
            verifiedEdits: [...(source.verifiedEdits || []), ...verified.verifiedEdits] }, options.danmaku || [], options.checks || []);
    };
    const strategy = config.review.strategy || 'single';
    const maxEvidenceChars = config.review.maxEvidenceChars || 80000;
    let contextBudget;
    if (options.retainedContext) {
        const recovery = require('../workflow-runtime').loadWorkflow('clipping/topicRecovery');
        const requested = { start: group.start, end: group.end };
        const candidates = recovery.preflightRecoveryContextCandidates?.(group, options.retainedContext, config) || [group];
        for (const context of candidates) {
            const contextInput = buildInput(context);
            const initialPrompt = strategy !== 'staged' && (strategy === 'audited' || config.review.qualityRules === true)
                ? buildQualityDraftPrompt(contextInput) : buildPreflightPrompt(contextInput, strategy === 'staged' ? 'plan' : 'single');
            const packed = recovery.compactPreflightPrompt(initialPrompt, maxEvidenceChars);
            if (packed.length > maxEvidenceChars) continue;
            contextBudget = { requested, retained: options.retainedContext,
                supplied: { start: context.start, end: context.end }, promptChars: packed.length };
            Object.assign(group, context);
            break;
        }
    }
    let input = buildInput(group);
    if (config.review.audioChecks?.enabled === true && input.hits.some(hit => hit.recall?.requiresSemanticConfirmation)) {
        const { getAsrConfig, resolvePythonCommand } = require('../asr/asr_backends');
        const backend = getAsrConfig(rootConfig).fun_asr_nano;
        const audio = require('../workflow-runtime').loadWorkflow('clipping/topicRecovery');
        input.audioChecks = audio.prepareTopicAudio ? await audio.prepareTopicAudio(input, config, source, diagnostics, {
            python: resolvePythonCommand(backend), pathMap: backend.python_path_map,
            scriptPath: require('path').resolve(__dirname, '../python/topic_audio_checks.py'),
            model: backend.model, vadModel: backend.vad_model || 'fsmn-vad', device: backend.device,
            resource_guard: { ...backend.resource_guard, torch_num_threads: 2 }, gpu_throttle: backend.gpu_throttle,
            ffmpeg: rootConfig.ffmpegPath || 'ffmpeg', ffmpegThreads: rootConfig.ownStreamClips?.clipFfmpegThreads || 2
        }, options.topicAudioIO) : { windows: [], skipped: input.hits.map(hit => ({ hitIds: [hit.id],
            status: 'unavailable', reason: 'audio_workflow_not_active' })) };
    }
    const settings = preflightRequestOptions(config);
    const record = { groupId: input.groupId, strategy, model: settings.primaryModel,
        reasoningEffort: settings.reasoningEffort, sourceSha256: evidence.sourceSha256, responses: [], errors: [],
        ...(contextBudget ? { contextBudget } : {}),
        ...(input.audioChecks ? { audioChecks: input.audioChecks } : {}) };
    diagnostics.preflightGroups ||= [];
    diagnostics.preflightGroups.push(record);
    const request = async (phase, lockedClip, hits, auditPlan) => {
        if (options.retainedContext && !contextBudget) throw new Error('Preflight source exceeds request budget');
        const requestSettings = phase === 'audit' ? { ...settings,
            primaryModel: config.review.auditModel || settings.primaryModel,
            reasoningEffort: config.review.auditReasoningEffort || settings.reasoningEffort } : settings;
        const prepared = lockedClip ? new Map(lockedClip.subtitleSegments.map(segment => [segment.index, segment])) : null;
        const cues = prepared ? evidence.cues.map(cue => {
            const item = prepared.get(cue.items[0].index);
            return item ? { ...cue, text: item.text, items: [item] } : cue;
        }) : evidence.cues;
        const phaseEvidence = prepared ? { ...evidence, cues, byId: new Map(cues.map(cue => [cue.id, cue])) } : evidence;
        let phaseInput = prepared ? { ...input, subtitles: input.subtitles.map(row => ({ ...row, text: phaseEvidence.byId.get(row.id).text })),
            rejectedSubtitleEdits: (lockedClip.rejectedSubtitleEdits || []).map(edit => ({ cueId: edit.cueId,
                original: edit.original, validationError: edit.validationError })) } : input;
        const buildPrompt = contextInput => phase === 'audit' ? buildQualityAuditPrompt(auditPlan, contextInput)
            : phase === 'single' && (strategy === 'audited' || config.review.qualityRules === true)
                ? buildQualityDraftPrompt(contextInput) : buildPreflightPrompt(contextInput, phase, lockedClip ? {
            id: lockedClip.id, startCueId: lockedClip.startCueId, endCueId: lockedClip.endCueId,
            hitIds: lockedClip.hitIds, keywordDecisions: hits.map(hit => ({ id: hit.id, cueId: hit.cueId, verdict: hit.verdict }))
        } : null);
        let prompt = buildPrompt(phaseInput);
        if (prompt.length > maxEvidenceChars) {
            prompt = require('../workflow-runtime').loadWorkflow('clipping/topicRecovery').compactPreflightPrompt(prompt, maxEvidenceChars);
        }
        if (prompt.length > maxEvidenceChars) throw new Error('Preflight source exceeds request budget');
        if (rootConfig.ai?.text?.enabled === false) throw new Error('Preflight requires AI text to be enabled');
        if (!['daiYu', 'tuZi'].includes(rootConfig.ai?.text?.provider)) throw new Error('Preflight requires a Responses-capable provider');
        const normalize = text => phase === 'audit' ? applyQualityAudit(text, auditPlan, input, evidence, config)
            : normalizePreflightResponse(text, phaseInput, phaseEvidence, config, {
            phase, ...(lockedClip ? { lockedClip, lockedHits: hits } : {})
        });
        const result = await requestSelectionText(prompt, requestSettings, config, rootConfig, source,
            `topic_preflight_${phase}_v4`, diagnostics, result => {
                try { normalize(result.text); return requestMatches(result, requestSettings); } catch { return false; }
            });
        record.responses.push({ phase, clipId: lockedClip?.id || null, text: result.text,
            cacheKey: result.meta?.selectionCache?.key || null, model: result.meta?.model || requestSettings.primaryModel });
        if (!requestMatches(result, requestSettings)) {
            throw new Error('Preflight model, protocol or reasoning setting changed');
        }
        let normalized;
        let boundaryError;
        try {
            normalized = normalize(result.text);
            if (phase === 'single' || phase === 'plan') {
                // Preserve valid semantic decisions if boundary repair later fails.
                plan = normalized;
                const issues = require('../workflow-runtime').loadWorkflow('clipping/topicRecovery').boundaryIssues(normalized);
                if (issues.length) boundaryError = new Error(`Preflight boundary review failed: ${issues.join('; ')}`);
            }
        } catch (error) { boundaryError = error; }
        if (boundaryError) {
            if (phase !== 'single' && phase !== 'plan') throw boundaryError;
            if (options.boundaryRepair === false) throw boundaryError;
            const recovery = require('../workflow-runtime').loadWorkflow('clipping/topicRecovery');
            if (!recovery.isBoundaryFailure(boundaryError.message)) throw boundaryError;
            record.errors.push({ phase, error: boundaryError.message, recovery: 'boundary_repair' });
            normalized = await recovery.repairTopicResponse(prompt, result.text, boundaryError.message, {
                expand: recovery.preflightContextCandidates ? (previous, reason) => {
                    const contexts = recovery.preflightContextCandidates(group, phaseEvidence, previous, config, options.recallMatches);
                    for (const context of contexts) {
                        const contextInput = buildInput(context);
                        if (input.audioChecks) contextInput.audioChecks = input.audioChecks;
                        const contextPrompt = buildPrompt(contextInput);
                        const repairPrompt = recovery.compactPreflightPrompt(
                            recovery.boundaryRepairPrompt(contextPrompt, previous, reason), maxEvidenceChars);
                        if (repairPrompt.length > maxEvidenceChars) continue;
                        const originalIds = new Set(group.cues.map(cue => cue.id));
                        record.contextRecovery ||= [];
                        record.contextRecovery.push({ from: { start: group.start, end: group.end },
                            to: { start: context.start, end: context.end }, reason, promptChars: repairPrompt.length,
                            addedCueIds: context.cues.filter(cue => !originalIds.has(cue.id)).map(cue => cue.id),
                            addedAnchorCount: context.matchSegments.length - group.matchSegments.length });
                        // The caller uses this same group for anchor metadata and post-speech padding.
                        Object.assign(group, context);
                        input = contextInput;
                        phaseInput = contextInput;
                        return contextPrompt;
                    }
                    if (contexts.length) record.errors.push({ phase, recovery: 'context_expansion',
                        error: 'Preflight additional context exceeds request budget' });
                    return undefined;
                } : undefined,
                request: repairPrompt => {
                    repairPrompt = recovery.compactPreflightPrompt(repairPrompt, maxEvidenceChars);
                    if (repairPrompt.length > maxEvidenceChars) {
                        throw new Error('Preflight boundary repair exceeds request budget');
                    }
                    return requestSelectionText(repairPrompt, requestSettings, config, rootConfig, source,
                        `topic_preflight_${phase}_boundary_repair_v2`, diagnostics, candidate => {
                            try { normalize(candidate.text); return requestMatches(candidate, requestSettings); } catch { return false; }
                        });
                }, normalize: text => {
                    const preparedPlan = normalize(text);
                    plan = preparedPlan;
                    return preparedPlan;
                }, issues: recovery.boundaryIssues, matches: candidate => requestMatches(candidate, requestSettings),
                record: candidate => record.responses.push({ phase: `${phase}_boundary_repair`, clipId: null,
                    text: candidate.text, cacheKey: candidate.meta?.selectionCache?.key || null,
                    model: candidate.meta?.model || requestSettings.primaryModel })
            });
        }
        if (phase === 'audit') {
            normalized.qualityAudit.model = requestSettings.primaryModel;
            normalized.clips.forEach(clip => { clip.qualityAudit.model = requestSettings.primaryModel; });
        }
        return normalized;
    };
    let plan;
    try {
        plan = await request(strategy === 'staged' ? 'plan' : 'single');
        if (strategy === 'staged') {
            for (let index = 0; index < plan.clips.length; index += 1) {
                const clip = plan.clips[index];
                try {
                    plan.clips[index] = { ...(await request('finish', clip, plan.hits)).clips[0],
                        subtitleEdits: clip.subtitleEdits, rejectedSubtitleEdits: clip.rejectedSubtitleEdits };
                }
                catch (error) {
                    clip.status = 'needs_review';
                    clip.issues.push(`Finalization failed: ${error.message}`);
                    record.errors.push({ clipId: clip.id, error: error.message });
                }
            }
        }
        if (strategy === 'audited') plan = await request('audit', null, null, plan);
        if (plan.qualityAudit?.missedEvent) diagnostics.failures.push({ stage: 'preflight', severity: 'warning',
            window: { start: group.start, end: group.end }, error: 'Quality audit found a potentially missed event; inspect the saved plan' });
        if (plan.hits.some(hit => hit.recall?.requiresSemanticConfirmation)) {
            const recall = require('../workflow-runtime').loadWorkflow('clipping/topicRecovery');
            plan = recall.holdUnresolvedTopicRecall?.(plan, group.bursts.flatMap(burst => buildFallbackAiClipSelection(burst))) || plan;
        }
        Object.assign(record, { status: 'prepared', hits: plan.hits,
            qualityAudit: plan.qualityAudit || null,
            clips: plan.clips.map(({ subtitleSegments, raw, ...clip }) => clip) });
        return { ...plan, input, record };
    } catch (error) {
        record.status = 'unavailable';
        record.errors.push({ error: error.message });
        diagnostics.failures.push({ stage: 'preflight', severity: 'warning',
            window: { start: group.start, end: group.end }, error: error.message });
        if (plan) {
            plan.clips = plan.clips.map(clip => ({ ...clip, status: 'needs_review',
                issues: [...clip.issues, `Quality review unavailable: ${error.message}`] }));
            record.hits = plan.hits;
            record.clips = plan.clips.map(({ subtitleSegments, raw, ...clip }) => clip);
            return { ...plan, input, record };
        }
        return { version: 1, groupId: input.groupId, sourceSha256: evidence.sourceSha256, hits: [], input, record,
            clips: group.bursts.flatMap(burst => buildFallbackAiClipSelection(burst)).map((clip, index) => ({
                ...clip, id: `${group.index}-${index + 1}`, status: 'needs_review',
                event: '', reason: error.message, score: 0, sourceKind: 'uncertain',
                issues: [error.message], warnings: [], subtitleEdits: [], subtitleSegments: [], copy: null, hits: []
            })) };
    }
}

function preflightSelections(plan, group, config) {
    const ending = require('./preflight_boundaries').endingWorkflow();
    return plan.clips.map((original, index) => {
        const clip = ending?.withPreflightEndingHold(original, group.cues || [], group.end, config.maxClipSeconds, plan.clips[index + 1]?.start) || original;
        return { start: clip.start, end: clip.end, sliceIndex: index + 1,
        aiTitle: clip.copy?.title || null, aiDescription: clip.copy?.description || null, aiCoverText: clip.copy?.coverText || null,
        aiModel: config.review.model || config.aiModel, subtitleSegments: clip.subtitleSegments,
        editorial: { status: clip.status === 'ready' ? 'planned' : 'pending_preflight', event: clip.event,
            reason: clip.reason, score: clip.score, sourceKind: clip.sourceKind, extensionReason: clip.extensionReason,
            copyStatus: clip.copy ? 'prepared' : 'unavailable', copyGrounding: clip.grounding || null,
            copyWindow: { start: clip.start, end: clip.end }, sourceBurstIndices: group.bursts.filter(burst =>
                burst.matchSegments.some(hit => hit.end > clip.start && hit.start < clip.end)).map(burst => burst.index) },
        preflight: { version: 1, mode: 'preflight', strategy: plan.record.strategy, status: clip.status,
            ...(plan.record.audioChecks ? { audioChecks: plan.record.audioChecks } : {}),
            sourceSha256: plan.sourceSha256, model: plan.record.model, reasoningEffort: plan.record.reasoningEffort,
            keyword: { status: clip.hits?.some(hit => hit.verdict === 'mention') ? 'confirmed' : 'needs_review', hits: clip.hits },
            quality: { status: clip.status === 'ready' ? 'pass' : 'needs_review', issues: clip.issues },
            qualityAudit: clip.qualityAudit || null,
            boundaryReview: clip.boundaryReview || null,
            ...(plan.record.contextRecovery ? { contextRecovery: plan.record.contextRecovery } : {}),
            ...(clip.endingHold ? { endingHold: clip.endingHold } : {}),
            subtitleEdits: clip.subtitleEdits, rejectedSubtitleEdits: clip.rejectedSubtitleEdits || [], warnings: clip.warnings, applied: false,
            window: { start: clip.start, end: clip.end }, reason: clip.reason } };
    });
}

module.exports = { isPreflightEnabled, preflightRequestOptions, prepareTopicGroup, preflightSelections, sourceFileHash, persistPreflightPlan, requestMatches };
