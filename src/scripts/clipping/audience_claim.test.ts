export {};
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { buildActorReviewPacket, validateActorReview, applyActorReview } = require('./actor_review');
const evidence = buildSubtitleEvidence([{ start: 0, end: 10, text: 'Host told a story.',
    speakerEvidence: { status: 'row_supported', label: 'Host', observations: [] } }]);
const context = { people: [{ id: 'host', label: 'Host', preferredName: 'Host', names: ['Host'], sourceHost: true }] };
const packet = buildActorReviewPacket({ start: 0, end: 10, title: 'Host讲故事', grounding: { sourceKind: 'live_speech' } },
    'c1', evidence, [{ time: 5, text: '太有趣了' }, { time: 20, text: '片外弹幕' }], context);
const good = () => ({ clipId: 'c1', decision: 'repair',
    copy: { title: 'Host讲故事，观众说“太有趣了”', description: 'Host讲故事，有观众说太有趣了。', coverText: '观众感叹\n太有趣了' },
    claims: [{ fields: ['title', 'description'], action: '讲故事', narrator: 'Host', actor: 'Host', target: null,
        sourceKind: 'live_speech', identityBasis: 'voice', cueIds: ['G1'], speakerCueIds: ['G1'], evidenceDanmakuIds: [] },
    { fields: ['title', 'description', 'coverText'], action: '观众说太有趣了', narrator: null, actor: null, target: null,
        sourceKind: 'audience', identityBasis: 'explicit_text', cueIds: [], speakerCueIds: [], evidenceDanmakuIds: ['D1'] }],
    evidenceDanmakuIds: ['D1'] });

test('a mixed speech/comment clip uses separate sources without requiring an unrelated speech citation', () => {
    const review = good();
    expect(validateActorReview(review, packet)).toEqual([]);
    const result = applyActorReview(packet, review);
    expect(result.attributionReview.status).toBe('passed');
    expect(result.grounding.subtitleIds).toEqual(['G1']);
    expect(result.grounding.danmakuIds).toEqual(['D1']);
});

test('audience IDs cannot be used as speech, speaker identity, or evidence outside the window', () => {
    let review = good(); review.claims[0].cueIds = ['D1'];
    expect(validateActorReview(review, packet)).toContain('invalid_action_citation:1');
    review = good(); review.claims[1].narrator = 'Host'; review.claims[1].identityBasis = 'voice';
    expect(validateActorReview(review, packet)).toContain('audience_claim_as_speech:2');
    review = good(); review.claims[1].evidenceDanmakuIds = ['D2']; review.evidenceDanmakuIds = ['D2'];
    expect(validateActorReview(review, packet)).toContain('invalid_audience_claim_citation:2');
    review = good(); review.evidenceDanmakuIds = [];
    expect(validateActorReview(review, packet)).toContain('invalid_audience_claim_citation:2');
});

test('an audience quote needs a visible audience label in every public field that uses it', () => {
    const review = good(); review.copy.coverText = '我的故事\n太有趣了';
    expect(validateActorReview(review, packet)).toContain('audience_claim_not_labelled:coverText:2');
    expect(applyActorReview(packet, review).publicCopyPending).toBe(true);
});
