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
    return Boolean(actual && !result.meta?.fallback && actual.model === settings.primaryModel
        && actual.apiModeUsed === 'responses' && actual.reasoningEffortSent === settings.reasoningEffort
        && (!actual.responseModel || actual.responseModel === settings.primaryModel)
        && (!actual.reasoningEffortReturned || actual.reasoningEffortReturned === settings.reasoningEffort));
}

async function prepareTopicGroup(group, evidence, config, rootConfig, source, diagnostics, options = {}) {
    const verified = loadVerifiedTopicFacts(source.srtPath, group, config.review.verifiedFactsPath);
    const input = buildPreflightInput(group, evidence, config, { ...source,
        verifiedFacts: [...(source.verifiedFacts || []), ...verified.verifiedFacts],
        verifiedEdits: [...(source.verifiedEdits || []), ...verified.verifiedEdits] }, options.danmaku || [], options.checks || []);
    const settings = preflightRequestOptions(config);
    const strategy = config.review.strategy || 'single';
    const record = { groupId: input.groupId, strategy, model: settings.primaryModel,
        reasoningEffort: settings.reasoningEffort, sourceSha256: evidence.sourceSha256, responses: [], errors: [] };
    diagnostics.preflightGroups ||= [];
    diagnostics.preflightGroups.push(record);
    const request = async (phase, lockedClip, hits, auditPlan) => {
        const requestSettings = phase === 'audit' ? { ...settings,
            primaryModel: config.review.auditModel || settings.primaryModel,
            reasoningEffort: config.review.auditReasoningEffort || settings.reasoningEffort } : settings;
        const prepared = lockedClip ? new Map(lockedClip.subtitleSegments.map(segment => [segment.index, segment])) : null;
        const cues = prepared ? evidence.cues.map(cue => {
            const item = prepared.get(cue.items[0].index);
            return item ? { ...cue, text: item.text, items: [item] } : cue;
        }) : evidence.cues;
        const phaseEvidence = prepared ? { ...evidence, cues, byId: new Map(cues.map(cue => [cue.id, cue])) } : evidence;
        const phaseInput = prepared ? { ...input, subtitles: input.subtitles.map(row => ({ ...row, text: phaseEvidence.byId.get(row.id).text })),
            rejectedSubtitleEdits: (lockedClip.rejectedSubtitleEdits || []).map(edit => ({ cueId: edit.cueId,
                original: edit.original, validationError: edit.validationError })) } : input;
        const prompt = phase === 'audit' ? buildQualityAuditPrompt(auditPlan, input)
            : phase === 'single' && (strategy === 'audited' || config.review.qualityRules === true)
                ? buildQualityDraftPrompt(phaseInput) : buildPreflightPrompt(phaseInput, phase, lockedClip ? {
            id: lockedClip.id, startCueId: lockedClip.startCueId, endCueId: lockedClip.endCueId,
            hitIds: lockedClip.hitIds, keywordDecisions: hits.map(hit => ({ id: hit.id, cueId: hit.cueId, verdict: hit.verdict }))
        } : null);
        if (prompt.length > (config.review.maxEvidenceChars || 80000)) throw new Error('Preflight source exceeds request budget');
        if (rootConfig.ai?.text?.enabled === false) throw new Error('Preflight requires AI text to be enabled');
        if (!['daiYu', 'tuZi'].includes(rootConfig.ai?.text?.provider)) throw new Error('Preflight requires a Responses-capable provider');
        const normalize = text => phase === 'audit' ? applyQualityAudit(text, auditPlan, input, evidence, config)
            : normalizePreflightResponse(text, phaseInput, phaseEvidence, config, {
            phase, ...(lockedClip ? { lockedClip, lockedHits: hits } : {})
        });
        const result = await requestSelectionText(prompt, requestSettings, config, rootConfig, source,
            `topic_preflight_${phase}_v3`, diagnostics, result => {
                try { normalize(result.text); return requestMatches(result, requestSettings); } catch { return false; }
            });
        record.responses.push({ phase, clipId: lockedClip?.id || null, text: result.text,
            cacheKey: result.meta?.selectionCache?.key || null, model: result.meta?.model || requestSettings.primaryModel });
        if (!requestMatches(result, requestSettings)) {
            throw new Error('Preflight model, protocol or reasoning setting changed');
        }
        const normalized = normalize(result.text);
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
    return plan.clips.map((clip, index) => ({ start: clip.start, end: clip.end, sliceIndex: index + 1,
        aiTitle: clip.copy?.title || null, aiDescription: clip.copy?.description || null, aiCoverText: clip.copy?.coverText || null,
        aiModel: config.review.model || config.aiModel, subtitleSegments: clip.subtitleSegments,
        editorial: { status: clip.status === 'ready' ? 'planned' : 'pending_preflight', event: clip.event,
            reason: clip.reason, score: clip.score, sourceKind: clip.sourceKind, extensionReason: clip.extensionReason,
            copyStatus: clip.copy ? 'prepared' : 'unavailable', copyGrounding: clip.grounding || null,
            copyWindow: { start: clip.start, end: clip.end }, sourceBurstIndices: group.bursts.filter(burst =>
                burst.matchSegments.some(hit => hit.end > clip.start && hit.start < clip.end)).map(burst => burst.index) },
        preflight: { version: 1, mode: 'preflight', strategy: plan.record.strategy, status: clip.status,
            sourceSha256: plan.sourceSha256, model: plan.record.model, reasoningEffort: plan.record.reasoningEffort,
            keyword: { status: clip.hits?.some(hit => hit.verdict === 'mention') ? 'confirmed' : 'needs_review', hits: clip.hits },
            quality: { status: clip.status === 'ready' ? 'pass' : 'needs_review', issues: clip.issues },
            qualityAudit: clip.qualityAudit || null,
            subtitleEdits: clip.subtitleEdits, rejectedSubtitleEdits: clip.rejectedSubtitleEdits || [], warnings: clip.warnings, applied: false,
            window: { start: clip.start, end: clip.end }, reason: clip.reason } }));
}

module.exports = { isPreflightEnabled, preflightRequestOptions, prepareTopicGroup, preflightSelections, sourceFileHash, persistPreflightPlan, requestMatches };
