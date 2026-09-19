export {};
const { reviewClipActors } = require('./actor_review_runner');
const { buildActorReviewPacket, applyActorReview } = require('./actor_review');
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { briefLines } = require('./review_brief');
const generator = require('../ai_text_generator');
const context = { people: [{ id: 'host', label: 'Host', names: ['Host'], preferredName: 'Host', sourceHost: true }] };
const evidence = buildSubtitleEvidence([{ start: 10, end: 15, text: 'Host told a story.',
    speakerEvidence: { status: 'row_supported', label: 'Host', observations: [] } }]);
const clip = { start: 10, end: 15, title: 'Host tells a story', description: 'Host told a story.', coverText: 'A story',
    grounding: { sourceKind: 'recount', issues: ['unsupported_quote:title:story'] } };
const good = () => ({ clipId: 'c1', decision: 'repair', copy: { title: clip.title, description: clip.description, coverText: clip.coverText },
    claims: [{ fields: ['title', 'description', 'coverText'], action: '讲故事', narrator: 'Host', actor: 'Host', target: null,
        sourceKind: 'recount', identityBasis: 'voice', speakerCueIds: ['G1'], cueIds: ['G1'] }], evidenceDanmakuIds: [] });
const config = { ai: { enabled: true, model: 'first', selectionCacheEnabled: false },
    attribution: { enabled: true, roomIds: ['1'], maxRequests: 2, repairModel: 'repair', repairReasoningEffort: 'high' } };

test('a model-requested human review gets one grounded repair with auditable history and explicit repair routing', async () => {
    const spy = jest.spyOn(generator, 'generateTextWithDaiYu')
        .mockResolvedValueOnce({ text: JSON.stringify({ reviews: [{ clipId: 'c1', decision: 'needs_review', reason: 'Need to check source' }] }) })
        .mockResolvedValueOnce({ text: JSON.stringify({ reviews: [good()] }) });
    try {
        const diagnostics: any = {};
        const [result] = await reviewClipActors([clip], { participantContext: context }, [], evidence, { roomId: '1' },
            config, { ai: { text: { provider: 'daiYu' } } }, diagnostics);
        expect(result.attributionReview.status).toBe('passed');
        expect(result.attributionReview.history.map(row => row.review.decision)).toEqual(['needs_review', 'repair']);
        expect(diagnostics.attribution.automaticallyRepaired).toBe(1);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy.mock.calls[1][1]).toMatchObject({ primaryModel: 'repair', reasoningEffort: 'high', strictEvaluation: true });
        expect(spy.mock.calls[1][0]).toContain('allowedActionCueIds');
        expect(spy.mock.calls[1][0]).toContain('voiceCitations');
    } finally { spy.mockRestore(); }
});

test('failed repair never approves unsupported claims and produces a short question with real timestamps', async () => {
    const bad = good(); bad.claims[0].speakerCueIds = ['G999'];
    const spy = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: JSON.stringify({ reviews: [bad] }) });
    try {
        const [result] = await reviewClipActors([clip], { participantContext: context }, [], evidence, { roomId: '1' },
            config, { ai: { text: { provider: 'daiYu' } } }, {});
        expect(result.attributionReview.status).toBe('needs_review');
        expect(result.title).toBe(clip.title);
        const lines = briefLines({ ...result, window: clip }).join('\n');
        expect(lines).toContain('片内0:00（录播0:10）');
        expect(lines).toContain('讲故事');
        expect(lines).not.toContain('G999');
        expect(lines).not.toContain('missing_speaker_citation');
    } finally { spy.mockRestore(); }
});

test('questions cannot fabricate source locations and never grant approval', () => {
    const packet = buildActorReviewPacket(clip, 'c1', evidence, [], context);
    const result = applyActorReview(packet, { clipId: 'c1', decision: 'needs_review', humanChecks: [
        { question: 'G1这是主播还是回放？', cueIds: ['G1'], suggestion: '核对声音' },
        { question: '另一个问题', cueIds: ['G999'] }
    ] });
    expect(result.publicCopyPending).toBe(true);
    expect(result.attributionReview.humanChecks).toHaveLength(1);
    expect(result.attributionReview.humanChecks[0].question).not.toContain('G1');
    expect(result.attributionReview.humanChecks[0].evidence).toEqual([{ id: 'G1', start: 10, end: 15, text: 'Host told a story.' }]);
});

test('structured responses constrain sparse action, speaker and question citations to each clip', () => {
    const { actorReviewResponseFormat } = require('./actor_review_schema');
    const a = { id: 'c1', cueIds: new Set(['G1', 'G7']), danmakuIds: new Set(['D4']) };
    const b = { id: 'c2', cueIds: new Set(['G20']), danmakuIds: new Set() };
    const format = actorReviewResponseFormat([a, b]);
    expect(format.strict).toBe(true);
    const [one, two] = format.schema.properties.reviews.items.anyOf;
    for (const field of ['cueIds', 'speakerCueIds']) {
        expect(one.properties.claims.items.properties[field].items.enum).toEqual(['G1', 'G7']);
        expect(two.properties.claims.items.properties[field].items.enum).toEqual(['G20']);
    }
    expect(one.properties.humanChecks.items.properties.cueIds.items.enum).toEqual(['G1', 'G7']);
    expect(two.properties.evidenceDanmakuIds.maxItems).toBe(0);
    expect(one.properties.clipId.enum).toEqual(['c1']);
});
