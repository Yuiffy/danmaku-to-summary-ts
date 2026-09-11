export {};
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { buildActorReviewPacket, applyActorReview, copyDigest } = require('./actor_review');
const { reviewPrecisionActors, finalizePrecisionActors, rebindUnchangedPrecisionCopy } = require('./precision_actor_review');
const { continuousPlan, labelExperimentDescription } = {
    ...require('../workflow-runtime').loadWorkflow('clipping/editPlan'),
    ...require('../workflow-runtime').loadWorkflow('clipping/experiment')
};
const people = { people: [
    { id: 'host', label: 'Host', names: ['Host'], preferredName: 'Host', sourceHost: true, presence: 'source_host' },
    { id: 'guest', label: 'Guest', names: ['Guest'], preferredName: 'Guest', sourceHost: false, presence: 'mentioned_only' }
] };

function fixture() {
    const segments = [{ start: 0, end: 10, text: 'Host recalled asking Guest about a book.' },
        { start: 40, end: 50, text: 'Host said the answer was helpful.' }].map(row => ({ ...row,
        speakerEvidence: { version: 1, status: 'row_supported', label: 'Host', observations: [{ ...row,
            label: 'Host', scope: 'row', row: { label: 'Host', accepted: true, score: .8, margin: .2 } }] } }));
    const evidence = buildSubtitleEvidence(segments);
    const copy = { title: 'Host asked Guest', coverText: 'Book\nQuestion', description: 'Host recalled asking Guest about a book.' };
    const claims = [{ fields: ['title', 'coverText', 'description'], action: 'asked', narrator: 'Host', actor: 'Host', target: 'Guest',
        sourceKind: 'recount', identityBasis: 'voice', speakerCueIds: ['G1'], cueIds: ['G1'] }];
    const review = { clipId: 'c1', decision: 'accept', copy, claims, evidenceDanmakuIds: [], reason: 'Source verified' };
    const danmaku = [{ time: 25, text: 'Audience comment inside the removed pause' }];
    const clip = applyActorReview(buildActorReviewPacket({ ...copy, start: 0, end: 60, grounding: { sourceKind: 'recount' } },
        'c1', evidence, danmaku, people), review);
    expect(clip.attributionReview.status).toBe('passed');
    const plan = continuousPlan('video', { start: 0, end: 60 });
    const factual = { ...copy, title: 'Host asked Guest about a book' };
    const artifact = { copy: { ...factual, description: labelExperimentDescription(factual.description, true, false) },
        window: { start: 0, end: 60, duration: 60 }, editPlan: plan, uploadReady: true };
    const context = { clip, evidence, parsed: { segments, participantContext: people }, danmaku,
        info: { roomId: 'room' }, config: { attribution: { evidenceEncoding: 'legacy' } }, rootConfig: {} };
    const response = { text: JSON.stringify({ reviews: [{ ...review, clipId: 'precision-final', copy: factual }] }),
        meta: { ledgerId: 'final-actor-call', model: 'fixture', attempts: [{ requestId: 'request-1' }] } };
    return { context, plan, artifact, response, review, factual };
}

test('a changed precision copy gets a new evidence-checked actor review bound to its final disclosure', async () => {
    const { context, plan, artifact, response } = fixture();
    const request = jest.fn(async prompt => { expect(prompt).toContain(artifact.copy.title); return response; });
    const result = await reviewPrecisionActors(artifact, plan, context, request);
    expect(result.passed).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.attributionReview).toMatchObject({ status: 'passed', phase: 'precision_final_copy',
        artifactCopyDigest: copyDigest(artifact.copy), initialCopyDigest: context.clip.attributionReview.copyDigest,
        reviewer: { ledgerId: 'final-actor-call' } });
    expect(result.attributionReview.previousReview).toEqual(context.clip.attributionReview);
    const metadata = { ...artifact, ...result };
    expect(finalizePrecisionActors(metadata, context.clip, context.evidence).uploadReady).toBe(true);
    expect(finalizePrecisionActors({ ...metadata, copy: { ...artifact.copy, title: 'Changed again' } }, context.clip, context.evidence).uploadReady).toBe(false);
    expect(finalizePrecisionActors({ ...metadata, editPlan: { ...plan, keep: [{ start: 0, end: 59 }] } }, context.clip, context.evidence).uploadReady).toBe(false);
    expect(finalizePrecisionActors(metadata, context.clip, { ...context.evidence, sourceSha256: 'new-source' }).uploadReady).toBe(false);
});

test.each(['wrong_actor', 'changed_copy', 'bad_citation', 'needs_review', 'timeout', 'malformed'])(
    '%s cannot reuse the old approval for new precision copy', async kind => {
        const { context, plan, artifact, response } = fixture();
        const review = JSON.parse(response.text).reviews[0];
        if (kind === 'wrong_actor') review.claims[0].narrator = 'Guest';
        if (kind === 'changed_copy') review.copy.title = 'Reviewer rewrote the title';
        if (kind === 'bad_citation') review.claims[0].cueIds = ['G999'];
        if (kind === 'needs_review') review.decision = 'needs_review';
        const request = jest.fn(async () => {
            if (kind === 'timeout') throw new Error('timeout');
            return { ...response, text: kind === 'malformed' ? '{broken' : JSON.stringify({ reviews: [review] }) };
        });
        const result = await reviewPrecisionActors(artifact, plan, context, request);
        expect(result.passed).toBe(false);
        expect(finalizePrecisionActors({ ...artifact, ...result }, context.clip, context.evidence).uploadReady).toBe(false);
        expect(artifact.copy.title).toBe('Host asked Guest about a book');
    });

test('removed audience evidence cannot support final copy, even when it is inside the original source window', async () => {
    const { context, plan, artifact, response } = fixture();
    const edited = { ...plan, keep: [{ start: 0, end: 20 }, { start: 30, end: 60 }],
        removed: [{ start: 20, end: 30, reason: 'silence', evidenceIds: ['audio-1'] }] };
    const review = JSON.parse(response.text).reviews[0];
    review.evidenceDanmakuIds = ['D1'];
    const updated = { ...artifact, copy: { ...artifact.copy, description: labelExperimentDescription(artifact.copy.description, true, true) } };
    const result = await reviewPrecisionActors(updated, edited, context, async () => ({ ...response, text: JSON.stringify({ reviews: [review] }) }));
    expect(result.issues).toContain('unseen_danmaku:D1');
    expect(result.passed).toBe(false);
});

test('stale initial approval is rejected before any new request', async () => {
    const { context, plan, artifact } = fixture();
    context.clip.title = 'Changed initial copy';
    const request = jest.fn();
    expect((await reviewPrecisionActors(artifact, plan, context, request)).passed).toBe(false);
    expect(request).not.toHaveBeenCalled();
});

test('unchanged copy can reuse only original claims whose speech and audience evidence all survive', () => {
    const { context, plan, artifact } = fixture();
    const baselineCopy = { title: context.clip.title, coverText: context.clip.coverText, description: context.clip.description };
    const edited = { ...plan, keep: [{ start: 0, end: 20 }, { start: 30, end: 60 }],
        removed: [{ start: 20, end: 30, reason: 'silence', evidenceIds: ['P1'] }] };
    const current = { ...artifact, editPlan: edited, copy: { ...baselineCopy,
        description: labelExperimentDescription(baselineCopy.description, true, true) } };
    const rebound = rebindUnchangedPrecisionCopy(current, edited, context, baselineCopy);
    expect(rebound.passed).toBe(true);
    expect(finalizePrecisionActors({ ...current, ...rebound }, context.clip, context.evidence).uploadReady).toBe(true);
    context.clip.grounding.danmakuIds = ['D1'];
    expect(rebindUnchangedPrecisionCopy(current, edited, context, baselineCopy).passed).toBe(false);
    context.clip.grounding.danmakuIds = [];
    current.copy.title = 'Changed claim';
    expect(rebindUnchangedPrecisionCopy(current, edited, context, baselineCopy).passed).toBe(false);
});
