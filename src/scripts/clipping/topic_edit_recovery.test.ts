export {};
const own = require('../own_stream_clipper');
const generator = require('../ai_text_generator');
const plan = (first, last, next, continuation = 'next_topic') => ({
    ranges: [{ startCueId: first, endCueId: last, action: 'keep', role: 'closing', reason: '完整事件及后续' }],
    closingReason: '读到后续换题', continuation, nextCueId: next });
const clip = (id, start, end, topicEditPlan) => ({ candidateIndex: id, startCueId: start, endCueId: end, topicEditPlan,
    evidenceCueIds: [start], evidenceDanmakuIds: [], title: '完整事件', coverText: '完整\n话题', description: '事情的经过', reason: '上下文完整', sourceKind: 'recount', score: 90 });

test('expands only unfinished topic, preserves successful short clip, and refuses shortening known continuation', async () => {
    const parsed = { segments: [{ start: 0, end: 10, text: '起因' }, { start: 150, end: 160, text: '第二个例子还未结束' },
        { start: 400, end: 410, text: '真正结尾' }, { start: 420, end: 430, text: '下一话题' },
        { start: 800, end: 807, text: '简短交流' }, { start: 820, end: 830, text: '无关下一句' }] };
    const good = clip(11, 'G5', 'G5', plan('G5', 'G5', 'G6'));
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu')
        .mockResolvedValueOnce({ text: JSON.stringify({ clips: [clip(7,'G1','G2',plan('G1','G2','','needs_more')),good] }), meta: {} })
        .mockResolvedValueOnce({ text: JSON.stringify({ clips: [{ candidateIndex: 11, approved: true, issues: [], requiredEndCueId: '' }] }), meta: {} })
        .mockResolvedValueOnce({ text: JSON.stringify({ clips: [clip(7,'G1','G1',plan('G1','G1','G2'))] }), meta: {} })
        .mockResolvedValueOnce({ text: JSON.stringify({ clips: [clip(7,'G1','G3',plan('G1','G3','G4'))] }), meta: {} })
        .mockResolvedValueOnce({ text: JSON.stringify({ clips: [{ candidateIndex: 7, approved: true, issues: [], requiredEndCueId: '' }] }), meta: {} });
    const diagnostics = { requests: [], errors: [] };
    try {
        const result = await own.refineCandidatesWithAI([{ index: 7, start: 0, end: 10 }, { index: 11, start: 800, end: 807 }],
            parsed, [], {}, own.getOwnStreamClipsConfig({}), { ai: { text: { provider: 'daiYu' } } }, diagnostics, '主播', { selectedOnly: true });
        expect(result.map(c => [c.candidateIndex, c.end])).toEqual([[7,410],[11,807]]);
        expect(generate).toHaveBeenCalledTimes(5);
        expect(generate.mock.calls[2][0]).toContain('本组只允许 candidateIndex=7；');
        expect(generate.mock.calls[2][0]).toContain('真正结尾');
        expect(generate.mock.calls[3][0]).toContain('topic_repair_lost_known_continuation');
    } finally { generate.mockRestore(); }
});

test('independent boundary review repairs a next group that begins with the unfinished closing sentence', async () => {
    const parsed = { segments: [
        { start: 0, end: 10, text: '夜跑却带着夜宵回家' },
        { start: 20, end: 25, text: '闻到那个味道了也很' },
        { start: 26, end: 34, text: '难很难抗拒吧。减肥药多少钱' },
        { start: 40, end: 50, text: '价格现在降了很多' }
    ] };
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (prompt, options) => {
        if (options.requestPhase.endsWith('-boundary-review')) {
            expect(prompt).toContain('难很难抗拒吧');
            const repaired = options.requestPhase.includes('topic-repair');
            return { text: JSON.stringify({ clips: [{ candidateIndex: 7, approved: repaired,
                issues: repaired ? [] : ['G3开头仍是G2的后半句，不能只看G3中的新话题'],
                requiredEndCueId: repaired ? '' : 'G3' }] }), meta: {} };
        }
        const repaired = options.requestPhase.includes('topic-repair');
        if (repaired) expect(prompt).toContain('topic_boundary_incomplete');
        return { text: JSON.stringify({ clips: [clip(7, 'G1', repaired ? 'G3' : 'G2',
            plan('G1', repaired ? 'G3' : 'G2', repaired ? 'G4' : 'G3'))] }), meta: {} };
    });
    try {
        const diagnostics = { requests: [], errors: [] };
        const result = await own.refineCandidatesWithAI([{ index: 7, start: 0, end: 25 }], parsed, [], {},
            own.getOwnStreamClipsConfig({}), { ai: { text: { provider: 'daiYu' } } }, diagnostics, '主播', { selectedOnly: true });
        expect(result.map(c => c.end)).toEqual([34]);
        expect(generate).toHaveBeenCalledTimes(4);
        expect(result[0].boundaryReview.approved).toBe(true);
    } finally { generate.mockRestore(); }
});

test('persistent boundary rejection stops after two repairs without returning the truncated draft', async () => {
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (_prompt, options) => ({
        text: JSON.stringify({ clips: options.requestPhase.endsWith('-boundary-review')
            ? [{ candidateIndex: 7, approved: false, issues: ['起因与必要指代仍不完整'], requiredEndCueId: '' }]
            : [clip(7, 'G1', 'G1', plan('G1', 'G1', 'G2'))] }), meta: {} }));
    try {
        const diagnostics: any = { requests: [], errors: [] };
        const result = await own.refineCandidatesWithAI([{ index: 7, start: 0, end: 10 }],
            { segments: [{ start: 0, end: 10, text: '缺少起因的回应' }, { start: 20, end: 30, text: '下一话题' }] },
            [], {}, own.getOwnStreamClipsConfig({}), { ai: { text: { provider: 'daiYu' } } }, diagnostics, '主播', { selectedOnly: true });
        expect(result).toEqual([]);
        expect(generate).toHaveBeenCalledTimes(6);
        expect(diagnostics.validation.rejected[0].reason).toBe('topic_boundary_incomplete');
    } finally { generate.mockRestore(); }
});
