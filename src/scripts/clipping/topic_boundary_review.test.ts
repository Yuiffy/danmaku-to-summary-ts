export {};
const { parseBoundaryReviews, boundaryReviewPrompt, boundaryReviewConfig } = require('./topic_boundary_review');
const clips = [{ candidateIndex: 7, end: 25 }, { candidateIndex: 11, end: 50 }];
const evidence = { byId: new Map([['G3', { id: 'G3', end: 34 }], ['G4', { id: 'G4', end: 50 }]]) };
const allowed = new Set(['G3']);
const approved = id => ({ candidateIndex: id, approved: true, issues: [], requiredEndCueId: '' });
const parse = rows => parseBoundaryReviews(JSON.stringify({ clips: rows }), clips, evidence, allowed);

test.each([
    [approved(7)], [approved(7), approved(7)], [approved(7), approved(99)],
    [{ ...approved(7), issues: ['仍然缺结尾'] }, approved(11)],
    [{ ...approved(7), approved: false }, approved(11)],
    [{ ...approved(7), approved: false, issues: ['缺结尾'], requiredEndCueId: 'G4' }, approved(11)],
    [approved(7), { ...approved(11), approved: false, issues: ['缺结尾'], requiredEndCueId: 'G3' }]
])('incomplete, contradictory or ungrounded reviews cannot approve selection: %j', (...rows) => {
    expect(() => parse(rows)).toThrow();
});

test('a grounded rejection remains valid review data, never an approval', () => {
    expect(parse([{ ...approved(7), approved: false, issues: ['下一组开头接上未完成的句子'], requiredEndCueId: 'G3' },
        approved(11)])[0]).toMatchObject({ approved: false, requiredEndCueId: 'G3' });
});

test('review packet separates retained closing words from context that is outside the video', () => {
    const evidence = { cues: [{ id: 'G1', start: 0, end: 25, text: '闻到味道也很' },
        { id: 'G3', start: 26, end: 34, text: '难很难抗拒吧' }] };
    const prompt = boundaryReviewPrompt([{ candidateIndex: 7, start: 0, end: 25, endCueId: 'G1' }], '字幕表', evidence);
    const packet = JSON.parse(prompt.split('\n')[1])[0];
    expect(packet.includedEnding.map(c => c.id)).toEqual(['G1']);
    expect(packet.excludedAfter.map(c => c.id)).toEqual(['G3']);
    expect(prompt).toContain('绝未进入视频');
});

test('enabled creative rooms use their existing QA protocol, model and usage ledger without changing selection config', () => {
    const config = { ai: { model: 'selection', stages: { detail: { model: 'detail' } } }, enhancements: {
        enabled: true, roomIds: ['1'], stageDefaults: { model: 'review', apiMode: 'responses', reasoningEffort: 'high', retry: { maxAttempts: 2 } },
        stages: { qa: { maxTokens: 12000 } }, budget: { mode: 'log_only', ledgerPath: 'shared-ledger' } } };
    const reviewed = boundaryReviewConfig(config, { roomId: '1' }, 'detail-1-boundary-review');
    expect(reviewed.ai.stages.detail).toMatchObject({ model: 'review', apiMode: 'responses', reasoningEffort: 'high', maxTokens: 12000 });
    expect(reviewed.ai.stageBudget).toEqual(config.enhancements.budget);
    expect(config.ai.stages.detail.model).toBe('detail');
    expect(boundaryReviewConfig(config, { roomId: '2' }, 'detail-1-boundary-review')).toBe(config);
});
