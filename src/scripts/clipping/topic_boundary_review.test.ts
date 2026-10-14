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
    expect(prompt).toContain('反问、设问、感叹式疑问和完整的调侃可以是收尾');
    expect(prompt).toContain('真正等待必要答复');
    expect(prompt).toContain('只有缺失指代确实改变人物、事件或主线理解');
});

test('review packet exposes the omitted setup separately from a retained last list item', () => {
    const evidence = { cues: [
        { id: 'G1', start: 0, end: 2, text: '上一个独立话题' },
        { id: 'G4', start: 2, end: 4, text: '你要做的事情有三件' },
        { id: 'G7', start: 4, end: 6, text: '第一件先准备' },
        { id: 'G8', start: 6, end: 8, text: '第二件写封信' },
        { id: 'G12', start: 8, end: 10, text: '第三件不要与他为敌' },
        { id: 'G15', start: 10, end: 12, text: '这话怎么这么耳熟' }
    ] };
    const prompt = boundaryReviewPrompt([{ candidateIndex: 7, start: 8, end: 12,
        startCueId: 'G12', endCueId: 'G15' }], '字幕表', evidence);
    const packet = JSON.parse(prompt.split('\n')[1])[0];
    expect(packet.excludedBefore.map(c => c.id)).toEqual(['G4', 'G7', 'G8']);
    expect(packet.includedOpening.map(c => c.id)).toEqual(['G12', 'G15']);
    expect(packet.excludedAfter).toEqual([]);
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
