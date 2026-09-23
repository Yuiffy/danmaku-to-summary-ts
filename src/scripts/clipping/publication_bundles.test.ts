export {};
const { selectPublication } = require('./publication_policy');
const { bundleCards, validateGroups, compilationPlan, proposeBundles } = require('./publication_bundles');
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const parsed = { segments: Array.from({ length: 6 }, (_, i) => ({ start: i * 40, end: i * 40 + 10, text: `A complete related event ${i}` })) };
const evidence = buildSubtitleEvidence(parsed.segments);
const clips = parsed.segments.map((cue, index) => ({ ...cue, score: [95, 89, 79, 78, 77, 76][index], title: cue.text,
    selectionSource: 'model_global_rerank', grounding: { sourceSha256: evidence.sourceSha256, status: 'linked', issues: [] } }));
const selection = selectPublication(clips, { mode: 'curated', maxStandalone: 1, bundles: { enabled: true } }, '25788785');
const packet = bundleCards(selection.report, parsed);
const group = { memberIndices: [3, 4], title: 'One event develops', relation: 'A question and its later answer',
    payoff: 'The later answer reverses the earlier expectation', combinedScore: 86,
    evidence: [3, 4].map(index => ({ index, cueIds: [packet.cards.find(card => card.index === index).speech[0].id] })) };
test('bundle pool excludes strong standalone clips, ungrounded copy, and subtitle drift', () => {
    expect(packet.cards.map(card => card.index)).toEqual([2, 3, 4, 5, 6]);
    const report = structuredClone(selection.report);
    report.deferred[0].score = 91;
    report.deferred[1].publicCopyPending = true;
    report.deferred[2].grounding.sourceSha256 = 'stale';
    expect(bundleCards(report, parsed).cards.map(card => card.index)).toEqual([5, 6]);
});
test('valid relationship proposal exports complete chronological windows to the shared compiler', () => {
    const groups = validateGroups({ clips: [group] }, packet, selection.report);
    const plan = { source: { mediaPath: 'source.flv', srtPath: 'source.srt' }, publication: selection.report };
    const exported = compilationPlan(plan, groups[0], parsed);
    expect(exported.clips.map(clip => [clip.start, clip.end])).toEqual([[80, 90], [120, 130]]);
    expect(exported.summary.totalPlannedDuration).toBe(20);
    expect(exported.publicationBundle.status).toBe('needs_review');
    expect(() => compilationPlan(plan, groups[0], { segments: parsed.segments.map(cue => ({ ...cue, text: 'changed' })) })).toThrow();
});
test.each([
    { memberIndices: [1, 3] }, { memberIndices: [3, 3] }, { memberIndices: [3, 999] },
    { combinedScore: 80 }, { combinedScore: null }, { evidence: [{ index: 3, cueIds: ['invented'] }] }, { relation: '' }
])('rejects protected/duplicate/invented members or unsupported gains: %j', patch => {
    expect(() => validateGroups({ clips: [{ ...group, ...patch }] }, packet, selection.report)).toThrow();
});
test('rejects cross-group reuse, excess total length and overlapping source intervals', () => {
    expect(() => validateGroups({ clips: [group, group] }, packet, selection.report)).toThrow();
    const long = structuredClone(packet); long.cards.find(row => row.index === 3).end = 500;
    expect(() => validateGroups({ clips: [group] }, long, selection.report)).toThrow();
    const overlap = structuredClone(packet); overlap.cards.find(row => row.index === 3).end = 125;
    expect(() => validateGroups({ clips: [group] }, overlap, selection.report)).toThrow();
});
test('bundle generator errors keep the selected singles and report unavailability', async () => {
    const generator = require('../ai_text_generator');
    const mock = jest.spyOn(generator, 'generateTextWithDaiYu').mockRejectedValue(new Error('provider unavailable'));
    try {
        const result = await proposeBundles(selection.report, parsed, {}, { ai: {} }, { ai: { text: { provider: 'daiYu' } } });
        expect(result).toMatchObject({ status: 'unavailable', proposals: [], error: 'provider unavailable' });
        expect(selection.clips.map(clip => clip.score)).toEqual([95]);
    } finally { mock.mockRestore(); }
});
test('disabled AI does not make a suggestion request', async () => {
    expect(await proposeBundles(selection.report, parsed, {}, { ai: { enabled: false } }, {}))
        .toEqual({ status: 'ai_disabled', proposals: [] });
});
