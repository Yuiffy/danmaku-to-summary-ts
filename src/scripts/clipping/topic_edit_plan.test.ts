export {};
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { normalizePlan, withEndingHold, storyConstraints, assertDroppedRanges } = require('./topic_edit_plan');
const { normalizeAiClips } = require('./selection_result');
const { validateStoryPlan } = require('./creative_timeline');
const segments = [
    { start: 10, end: 15, text: '先给他看假虫' }, { start: 20, end: 25, text: '他说是装饰' },
    { start: 40, end: 45, text: '等一下找图' }, { start: 90, end: 95, text: '第二只其实也是塑料的' },
    { start: 130, end: 135, text: '以前也骗过观众，原来是另一个玩具' },
    { start: 142, end: 145, text: '接下来投票选电影' }
];
const evidence = buildSubtitleEvidence(segments, { groupSegments: false });
const bounds = { start: 10, end: 135, startCueId: 'G1', endCueId: 'G5' };
const raw = { ranges: [
    { startCueId: 'G1', endCueId: 'G2', action: 'keep', role: 'setup', reason: '第一例与回应' },
    { startCueId: 'G3', endCueId: 'G3', action: 'drop', role: 'context', reason: '无进展的找图等待' },
    { startCueId: 'G4', endCueId: 'G5', action: 'keep', role: 'closing', reason: '第二例与最终解释' }
], closingReason: '两例与回应都已讲完，下一组明确开始电影投票', continuation: 'next_topic', nextCueId: 'G6' };

test('selection preserves a later example and conclusion in the same chronological edit', () => {
    const clip = { candidateIndex: 7, ...bounds, topicEditPlan: raw, title: '假虫趣事', evidenceCueIds: ['G1', 'G4'], sourceKind: 'recount' };
    const result = normalizeAiClips([clip], [{ index: 7, start: 10, end: 25 }], 145,
        { requireTopicEditPlan: true }, '主播', evidence, [], new Set(evidence.byId.keys()));
    expect(result).toHaveLength(1);
    const padded = withEndingHold(result[0], segments, 145);
    expect(padded.end).toBe(138);
    const constraints = storyConstraints(padded.topicEditPlan, evidence, padded);
    const cues = segments.slice(0, 5).map((c, i) => ({ ...c, id: `C${i+1}`, start: c.start-10, end: c.end-10 }));
    const draft = { keep: [{ fromCue: 'C1', toCue: 'C2', role: 'setup', reason: 'first' },
        { fromCue: 'C4', toCue: 'C5', role: 'closing', reason: 'second and closure' }] };
    const timeline = validateStoryPlan(draft, cues, 128, constraints, { preserveContinuity: false }, 3);
    expect(timeline.keep.at(-1).end).toBe(128);
    expect(() => assertDroppedRanges(timeline, padded.topicEditPlan, padded)).not.toThrow();
    expect(() => validateStoryPlan({ keep: [draft.keep[0]] }, cues, 128, constraints, {}, 3)).toThrow('Retain');
    expect(() => assertDroppedRanges({ keep: [{ start: 0, end: 128 }] }, padded.topicEditPlan, padded)).toThrow('dropped');
});

test.each([
    { ...raw, continuation: 'needs_more' },
    { ...raw, nextCueId: 'G500' },
    { ...raw, ranges: raw.ranges.slice(0, 2) },
    { ...raw, ranges: [...raw.ranges].reverse() },
    { ...raw, ranges: [{ ...raw.ranges[0], endCueId: 'G3' }, ...raw.ranges.slice(1)] },
    { ...raw, closingReason: '' }
])('rejects unclosed, fabricated, incomplete or reordered topic plans', bad => {
    expect(() => normalizePlan(bad, bounds, evidence)).toThrow();
});

test('plan cannot cite unseen continuation, drop public-copy evidence or survive changed source', () => {
    expect(() => normalizePlan(raw, bounds, evidence, new Set(['G1','G2','G3','G4','G5']))).toThrow('continuation');
    const plan = normalizePlan(raw, bounds, evidence);
    expect(() => storyConstraints(plan, { ...evidence, sourceSha256: 'changed' }, bounds)).toThrow('Stale');
    const rejected = [];
    normalizeAiClips([{ ...bounds, candidateIndex: 7, topicEditPlan: raw, evidenceCueIds: ['G3'] }],
        [{ index: 7, start: 10, end: 135 }], 145, { requireTopicEditPlan: true }, '', evidence, [], null, null, rejected);
    expect(rejected[0].reason).toBe('public_copy_evidence_dropped');
});

test('overlapping descriptions of kept speech retain it once; contradictory deletion still fails', () => {
    const shared = { ...raw, ranges: [
        { ...raw.ranges[0], endCueId: 'G4' }, { ...raw.ranges[2], startCueId: 'G4' }
    ] };
    const result = normalizePlan(shared, bounds, evidence);
    expect(result.ranges.map(r => [r.startCueId, r.endCueId])).toEqual([['G1','G4'],['G5','G5']]);
    expect(() => normalizePlan({ ...shared, ranges: [shared.ranges[0], { ...shared.ranges[1], action: 'drop' }] }, bounds, evidence)).toThrow();
    expect(() => storyConstraints(result, evidence, bounds)).not.toThrow();
});

test('seven-second exchange gets breathing room without grabbing next utterance or exceeding recording', () => {
    const clip = { start: 10901.629, end: 10907.704 };
    expect(withEndingHold(clip, [{ start: 10912.12, end: 10921.854 }], 12000).end).toBe(10910.704);
    expect(withEndingHold({ start: 0, end: 7 }, [{ start: 8, end: 12 }], 20).end).toBe(7.92);
    expect(withEndingHold({ start: 0, end: 7 }, [], 8).end).toBe(8);
    expect(withEndingHold({ start: 0, end: 7 }, [{ start: 6, end: 12 }], 20).end).toBe(7);
    const padded = withEndingHold(clip, [], 12000);
    expect(withEndingHold(padded, [], 12000)).toEqual(padded);
});
