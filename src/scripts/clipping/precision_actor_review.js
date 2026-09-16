'use strict';
const crypto = require('crypto');
const { loadWorkflow } = require('../workflow-runtime');
const { buildParticipantContext } = require('./participant_context');
const { copyDigest, buildActorReviewPacket, actorReviewPrompt, parseActorReviews,
    validateActorReview, applyActorReview } = require('./actor_review');

const keepDigest = plan => crypto.createHash('sha256').update(JSON.stringify(plan.keep)).digest('hex');

function factualCopy(artifact, plan) {
    const { labelExperimentDescription } = loadWorkflow('clipping/experiment');
    const disclosure = labelExperimentDescription('', true, plan.removed.length > 0).trimEnd();
    const description = String(artifact.copy.description || '');
    if (!description.startsWith(`${disclosure}\n`)) throw new Error('Precision disclosure does not match the edit plan');
    return { title: artifact.copy.title, coverText: artifact.copy.coverText,
        description: description.slice(disclosure.length + 1) };
}

async function reviewPrecisionActors(artifact, plan, context, request) {
    const { clip, evidence, parsed, danmaku, info, config, rootConfig } = context;
    const { experimentEligibility } = loadWorkflow('clipping/experiment');
    const previous = clip.attributionReview;
    const base = { version: 1, phase: 'precision_final_copy', status: 'needs_review',
        sourceSha256: evidence.sourceSha256, start: clip.start, end: clip.end,
        initialCopyDigest: previous?.copyDigest || null, previousReview: previous,
        keepDigest: keepDigest(plan), artifactCopyDigest: null };
    try {
        if (!clip.attributionRequired || experimentEligibility(clip, evidence.sourceSha256)) throw new Error('Initial actor review is not current');
        if (plan.sourceWindow.start !== clip.start || plan.sourceWindow.end !== clip.end) throw new Error('Source window changed before final actor review');
        const copy = factualCopy(artifact, plan);
        const people = parsed.participantContext || buildParticipantContext(rootConfig, info, parsed, danmaku, {}, config.attribution);
        const packet = buildActorReviewPacket({ ...clip, ...copy }, 'precision-final', evidence, danmaku, people, config.attribution);
        const retained = cue => plan.keep.some(span => cue.start >= span.start - .001 && cue.end <= span.end + .001);
        packet.cueIds = new Set([...packet.cueIds].filter(id => retained(evidence.byId.get(id))));
        packet.data.inRangeCueIds = [...packet.cueIds];
        packet.data.audience = packet.data.audience.filter(row => plan.keep.some(span => row.time >= span.start && row.time < span.end));
        packet.danmakuIds = new Set(packet.data.audience.map(row => row.id));
        packet.data.editPlan = plan;
        if (previous.dialogueEvidence) {
            packet.dialogueEvidence = { ...previous.dialogueEvidence, turns: (previous.dialogueEvidence.turns || [])
                .filter(turn => turn.cueIds?.every(id => packet.cueIds.has(id))) };
            packet.data.dialogueEvidence = packet.dialogueEvidence;
        }
        packet.digest = crypto.createHash('sha256').update(JSON.stringify({ source: evidence.sourceSha256,
            data: packet.data, people: people?.people || [] })).digest('hex');
        const prompt = actorReviewPrompt([packet], people, config.attribution) + '\n'
            + 'Final-copy verification only: do not rewrite copy. Return accept with the exact supplied copy and verified claims, or needs_review. '
            + 'The video may contain only editPlan.keep. Only inRangeCueIds and supplied audience IDs are retained evidence; other speech is context only. '
            + 'The producer disclosure is excluded from this factual copy and is bound separately by the program.';
        const response = await request(prompt);
        const [review] = parseActorReviews(response, [packet]);
        const issues = validateActorReview(review, packet);
        if (copyDigest(review.copy || {}) !== copyDigest(copy)) issues.push('final_actor_review_changed_copy');
        const last = response.meta?.attempts?.at(-1) || {};
        const record = { ...base, proposedCopy: review.copy, decision: review.decision, claims: review.claims,
            issues, reason: review.reason || '', packetDigest: packet.digest,
            ...(packet.dialogueEvidence ? { dialogueEvidence: packet.dialogueEvidence } : {}),
            ...(packet.entityContext ? { entityContext: packet.entityContext } : {}),
            reviewer: { model: response.meta?.model || last.model || null, requestId: last.requestId || null,
                responseId: last.responseId || null, ledgerId: response.meta?.ledgerId || null,
                provider: last.provider || null, reasoningEffort: last.reasoningEffortSent || null } };
        if (issues.length) return { passed: false, issues, attributionReview: record };
        const accepted = applyActorReview(packet, review, issues);
        return { passed: true, issues: [], grounding: accepted.grounding,
            attributionReview: { ...record, status: 'passed', copyDigest: copyDigest(copy), artifactCopyDigest: copyDigest(artifact.copy) } };
    } catch (error) {
        const issues = [`precision_actor_review_failed:${error.message}`];
        return { passed: false, issues, attributionReview: { ...base, issues, reason: error.message } };
    }
}

function finalizePrecisionActors(metadata, clip, evidence) {
    const { experimentEligibility } = loadWorkflow('clipping/experiment');
    const review = metadata.attributionReview || {};
    let valid = false;
    try {
        valid = !experimentEligibility(clip, evidence.sourceSha256) && review.version === 1
            && review.phase === 'precision_final_copy' && review.status === 'passed' && !review.issues?.length
            && review.initialCopyDigest === clip.attributionReview.copyDigest
            && review.sourceSha256 === evidence.sourceSha256 && review.start === clip.start && review.end === clip.end
            && metadata.window.start === clip.start && metadata.window.end === clip.end
            && review.keepDigest === keepDigest(metadata.editPlan)
            && review.copyDigest === copyDigest(factualCopy(metadata, metadata.editPlan))
            && review.artifactCopyDigest === copyDigest(metadata.copy);
    } catch { /* A missing or stale final review cannot fall back to the earlier approval. */ }
    return { ...metadata, attributionRequired: true, publicCopyPending: Boolean(metadata.publicCopyPending || !valid),
        uploadReady: Boolean(metadata.uploadReady && valid),
        attributionReview: { ...review, status: valid ? 'passed' : 'needs_review',
            ...(!valid ? { artifactCopyDigest: null, invalidated: 'precision_final_actor_review_missing_or_changed' } : {}) } };
}

function rebindUnchangedPrecisionCopy(artifact, plan, context, baselineCopy) {
    const { clip, evidence, danmaku } = context;
    const previous = clip.attributionReview;
    try {
        if (loadWorkflow('clipping/experiment').experimentEligibility(clip, evidence.sourceSha256)) throw new Error('Initial review is stale');
        if (plan.sourceWindow.start !== clip.start || plan.sourceWindow.end !== clip.end) throw new Error('Source window changed');
        const copy = factualCopy(artifact, plan);
        if (copyDigest(copy) !== copyDigest(baselineCopy)) throw new Error('Factual copy changed');
        if (!previous.claims?.length) throw new Error('No original verified claims');
        const ids = new Set(previous.claims.flatMap(claim => [...(claim.cueIds || []), ...(claim.speakerCueIds || [])]));
        for (const id of clip.grounding?.danmakuIds || []) ids.add(id);
        for (const id of ids) {
            const cue = evidence.byId.get(id);
            const audience = /^D[1-9]\d*$/u.test(id) ? danmaku[Number(id.slice(1)) - 1] : null;
            if (cue ? !plan.keep.some(span => cue.start >= span.start - .001 && cue.end <= span.end + .001)
                : !audience || !plan.keep.some(span => audience.time >= span.start && audience.time < span.end)) throw new Error(`Reviewed citation was removed: ${id}`);
        }
        return { passed: true, issues: [], grounding: clip.grounding,
            attributionReview: { ...previous, phase: 'precision_final_copy', previousReview: previous,
                initialCopyDigest: previous.copyDigest, copyDigest: copyDigest(copy), artifactCopyDigest: copyDigest(artifact.copy),
                keepDigest: keepDigest(plan), reason: '原文案未改，原审核引用全部保留；仅重新绑定剪辑后的成片',
                reviewer: { method: 'unchanged_copy_retained_citations', sourceReview: previous.reviewer || null } } };
    } catch (error) { return { passed: false, issues: [error.message], attributionReview: { status: 'needs_review', reason: error.message } }; }
}
module.exports = { reviewPrecisionActors, finalizePrecisionActors, rebindUnchangedPrecisionCopy };
