'use strict';
const { attributionEnabled, buildParticipantContext } = require('./participant_context');
const { requestSelectionText } = require('./selection_request');
const { dialoguePrompt, parseDialogueEvidence } = require('./dialogue_evidence');
const { attributionRisk, buildActorReviewPacket, actorReviewPrompt, parseActorReviews,
    validateActorReview, applyActorReview } = require('./actor_review');

async function reviewClipActors(clips, parsed, danmaku, evidence, info, config, rootConfig, diagnostics) {
    if (!attributionEnabled(config, info.roomId)) return clips;
    const settings = config.attribution;
    const maxChars = Math.max(1024, Number(settings.maxBatchChars ?? 36000));
    const batchSize = Math.max(1, Math.min(8, Number(settings.batchSize ?? 4)));
    const maxRequests = Math.max(0, Number(settings.maxRequests ?? 12));
    const deadline = Date.now() + Math.max(0, Number(settings.maxElapsedMs ?? 1200000));
    const result = [...clips];
    const packets = [];
    const context = parsed.participantContext || buildParticipantContext(rootConfig, info, parsed, danmaku, {}, settings);
    const promptFor = packets => actorReviewPrompt(packets, context, settings);
    clips.forEach((clip, index) => {
        const risks = attributionRisk(clip, evidence, context);
        if (!risks.length) return;
        const packet = buildActorReviewPacket(clip, `c${index + 1}`, evidence, danmaku, context, settings);
        packets.push({ ...packet, index, risks });
    });
    diagnostics.attribution = { totalClips: clips.length, highRiskClips: packets.length, passed: 0, pending: 0, requests: 0, maxRequests, events: [] };
    const recordEvent = (phase, current, details) => diagnostics.attribution.events.push({
        phase, clipIds: current.map(packet => packet.id), ...details
    });
    const store = (packet, review, issues) => {
        const updated = applyActorReview(packet, review, issues);
        updated.attributionReview.risks = packet.risks;
        result[packet.index] = updated;
        diagnostics.attribution[updated.attributionReview.status === 'passed' ? 'passed' : 'pending']++;
    };
    const processBatch = async current => {
        if (!current.length) return;
        if (Date.now() >= deadline) {
            recordEvent('actor-review', current, { status: 'unavailable', reason: 'time_budget_exhausted' });
            current.forEach(packet => store(packet, null, ['actor_review_time_budget_exhausted']));
            return;
        }
        if (diagnostics.attribution.requests >= maxRequests || !config.ai?.enabled || rootConfig.ai?.text?.enabled === false) {
            recordEvent('actor-review', current, { status: 'unavailable', reason: diagnostics.attribution.requests >= maxRequests ? 'request_budget_exhausted' : 'ai_disabled' });
            current.forEach(packet => store(packet, null, ['actor_review_unavailable']));
            return;
        }
        const requestOptions = {
            primaryModel: settings.model || config.ai.model,
            reasoningEffort: settings.reasoningEffort || rootConfig.ai?.text?.daiYu?.thinking?.reasoningEffort || 'high',
            timeoutMs: Number(settings.timeoutMs ?? 600000), wordLimit: current.length * 700,
            maxTokens: Number(settings.maxTokens ?? 12000), strictEvaluation: true
        };
        const valid = packets => value => {
            try { return parseActorReviews(value, packets).every(review => !validateActorReview(review,
                packets.find(packet => packet.id === review.clipId)).length); } catch { return false; }
        };
        try {
            const firstPrompt = promptFor(current);
            const phase = `actor-review-${++diagnostics.attribution.requests}`;
            const response = await requestSelectionText(firstPrompt, requestOptions,
                config, rootConfig, info, phase, diagnostics, valid(current));
            const reviews = new Map(parseActorReviews(response, current).map(review => [review.clipId, review]));
            const responses = new Map(current.map(packet => [packet.id, response]));
            if (settings.dialogueEnabled === true && settings.repairAttempts !== 0 && Date.now() < deadline
                && diagnostics.attribution.requests + 1 < maxRequests) {
                const needsDialogue = current.filter(packet => {
                    const review = reviews.get(packet.id);
                    const issues = validateActorReview(review, packet);
                    const genericPerson = /(?:连麦对象|嘉宾|对方|有人|\b(?:someone|guest)\b)/iu.test(
                        [review.copy?.title, review.copy?.description].join('\n'));
                    const multipleContext = packet.risks.some(reason => /(?:multiple|copy_voice_conflict|other_person_in_context|conversational_context)/u.test(reason))
                        || context?.people?.some(person => !person.sourceHost && ['planned', 'voice_matched'].includes(person.presence));
                    return multipleContext && (review.decision === 'needs_review'
                        || issues.some(issue => /(?:speaker|narrator|actor|question_action)/u.test(issue))
                        || (!issues.length && genericPerson && review.claims?.some(claim => !claim.narrator || !claim.actor || !claim.target)));
                });
                if (needsDialogue.length) {
                    const prompt = dialoguePrompt(needsDialogue, context);
                    if (prompt.length <= maxChars) {
                        try {
                            const independent = await requestSelectionText(prompt, requestOptions, config, rootConfig, info,
                                `dialogue-evidence-${++diagnostics.attribution.requests}`, diagnostics, value => {
                                    try { parseDialogueEvidence(value, needsDialogue, context); return true; } catch { return false; }
                                });
                            parseDialogueEvidence(independent, needsDialogue, context).forEach(dialogue => {
                                const packet = needsDialogue.find(packet => packet.id === dialogue.clipId);
                                const last = independent.meta?.attempts?.at(-1) || {};
                                packet.dialogueEvidence = { ...dialogue, reviewer: { model: independent.meta?.model || last.model || null,
                                    requestId: last.requestId || null, responseId: last.responseId || null } };
                                packet.data.dialogueEvidence = packet.dialogueEvidence;
                            });
                        } catch (error) {
                            diagnostics.attribution.dialogueError = error.message;
                            recordEvent('dialogue-evidence', needsDialogue, { status: 'failed', error: error.message });
                        }
                    }
                }
            }
            const repair = settings.repairAttempts === 0 ? [] : current.filter(packet => {
                const review = reviews.get(packet.id);
                return (review.decision !== 'needs_review' && validateActorReview(review, packet).length > 0)
                    || packet.dialogueEvidence?.turns.some(turn => turn.supported);
            });
            if (repair.length && Date.now() < deadline && diagnostics.attribution.requests < maxRequests) {
                const repairPrompt = promptFor(repair) + '\n只修订以下明确校验问题，不改变原事件，仍无法核验就needs_review：\n'
                    + JSON.stringify(repair.map(packet => ({ clipId: packet.id, previous: reviews.get(packet.id),
                        issues: validateActorReview(reviews.get(packet.id), packet),
                        newDialogueEvidence: Boolean(packet.dialogueEvidence) })));
                if (repairPrompt.length <= maxChars) {
                    try {
                        const repaired = await requestSelectionText(repairPrompt, requestOptions, config, rootConfig, info,
                            `actor-review-${++diagnostics.attribution.requests}-repair`, diagnostics, valid(repair));
                        parseActorReviews(repaired, repair).forEach(review => { reviews.set(review.clipId, review); responses.set(review.clipId, repaired); });
                    } catch (error) {
                        diagnostics.attribution.repairError = error.message;
                        recordEvent('actor-review-repair', repair, { status: 'failed', error: error.message });
                    }
                }
            }
            current.forEach(packet => {
                store(packet, reviews.get(packet.id));
                const used = responses.get(packet.id);
                const last = used.meta?.attempts?.at(-1) || {};
                result[packet.index].attributionReview.reviewer = { model: used.meta?.model || last.model || null,
                    provider: last.provider || null, requestId: last.requestId || null, responseId: last.responseId || null,
                    reasoningEffort: last.reasoningEffortSent || null, cacheHit: used.meta?.selectionCache?.hit === true };
            });
        } catch (error) {
            recordEvent('actor-review', current, { status: 'failed', error: error.message });
            current.forEach(packet => store(packet, null, [`actor_review_failed:${error.message}`]));
        }
    };
    const batches = [];
    let batch = [];
    for (const packet of packets) {
        if (promptFor([packet]).length > maxChars) {
            recordEvent('actor-review', [packet], { status: 'unavailable', reason: 'evidence_exceeds_budget' });
            store(packet, null, ['actor_evidence_exceeds_budget']);
            continue;
        }
        if (batch.length && (batch.length >= batchSize || promptFor([...batch, packet]).length > maxChars)) {
            batches.push(batch);
            batch = [];
        }
        batch.push(packet);
    }
    if (batch.length) batches.push(batch);
    let next = 0;
    const concurrency = Math.max(1, Math.min(3, Math.floor(Number(settings.concurrency) || 2)));
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
        while (next < batches.length) await processBatch(batches[next++]);
    }));
    return result;
}

module.exports = { reviewClipActors };
