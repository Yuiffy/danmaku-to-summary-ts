export {};
const { selectPublication, resolvePolicy } = require('./publication_policy');
const { originalClips, run } = require('./publication_cli');
const fs = require('fs'), os = require('os'), path = require('path');
const clips = [78, 94, 85, 92, 85, 600].map((score, index) => ({ start: index * 40, end: index * 40 + 20,
    duration: 20, title: `Story ${index + 1}`, candidateIndex: index + 10, score,
    selectionSource: index === 5 ? 'danmaku_heat' : 'model_global_rerank' }));
const config = { mode: 'curated', maxStandalone: 2 };
test('applies an absolute floor and relative budget without confusing heat with editorial scores', () => {
    const result = selectPublication(clips, config, '25788785');
    expect(result.clips.map(clip => clip.title)).toEqual(['Story 2', 'Story 4']);
    expect(result.report.decisions.map(row => row.reason)).toEqual(['below_score', 'standout', 'batch_budget', 'standout', 'batch_budget', 'unscored']);
    expect(result.report.deferred.map(clip => clip.candidateIndex)).toEqual([10, 12, 14, 15]);
    expect(clips.every(clip => !clip.publication)).toBe(true);
});
test('standout clips overflow a soft budget and remain independent even when long', () => {
    const result = selectPublication(clips.map(clip => ({ ...clip, end: clip.start + 1200 })), { ...config, maxStandalone: 1 }, '25788785');
    expect(result.clips).toHaveLength(2); expect(result.report.protectedOverflow).toBe(1);
});
test('score mode has no count budget; ties in curated mode have stable chronological order', () => {
    expect(selectPublication(clips, { ...config, mode: 'score' }, '25788785').clips).toHaveLength(4);
    expect(selectPublication(clips, { ...config, maxStandalone: 3 }, '25788785').clips.map(clip => clip.title)).toEqual(['Story 2', 'Story 3', 'Story 4']);
});
test('missing scores, numeric strings and local fallback scores are deferred, not coerced to model scores', () => {
    const input = [{ score: null }, { score: '95' }, { score: NaN }, { score: 101 }, { score: 95, selectionSource: 'recall_pool_fallback' }]
        .map(row => ({ ...clips[1], ...row }));
    const result = selectPublication(input, config, '25788785');
    expect(result.clips).toEqual([]); expect(result.report.decisions.every(row => row.reason === 'unscored')).toBe(true);
});
test.each(['all', 'shadow'])('rollback/observation mode %s keeps original candidates including unscored ones', mode => {
    const result = selectPublication(clips, { ...config, mode }, '25788785');
    expect(result.clips).toHaveLength(clips.length);
    const restored = originalClips({ clips: result.clips, publication: result.report });
    if (mode === 'shadow') expect(restored).toEqual(clips);
});
test('missing configuration and other rooms retain legacy behavior', () => {
    expect(selectPublication(clips, {}, '25788785').clips).toEqual(clips);
    expect(selectPublication(clips, config, '22470216').clips).toEqual(clips);
});
test('global rank score wins over a more generous detail score and empty selections are valid', () => {
    const result = selectPublication([{ ...clips[1], score: 99, globalSelection: { score: 74 } }], config, '25788785');
    expect(result.clips).toEqual([]);
    expect(result.report.decisions[0]).toMatchObject({ score: 74, reason: 'below_score' });
    expect(selectPublication([], config, '25788785').report.inputCount).toBe(0);
});
test('chunked selection compares its original model score, not the ranking offset', () => {
    const input = [{ ...clips[0], score: 176, modelScore: 76, selectionSource: 'model_chunked' },
        { ...clips[1], score: 182, modelScore: 82, selectionSource: 'model_chunked' }];
    const result = selectPublication(input, config, '25788785');
    expect(result.report.decisions.map(row => row.score)).toEqual([76, 82]);
    expect(result.clips.map(clip => clip.title)).toEqual(['Story 2']);
});
test.each([{ mode: 'typo' }, { minScore: NaN }, { minScore: 95, standoutScore: 90 }, { maxStandalone: 0 }, { roomIds: [] }])('rejects invalid settings %j', raw => {
    expect(() => resolvePolicy(raw, '25788785')).toThrow();
});
test('preview and explicit restoration preserve candidates and never modify the source plan', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-cli-'));
    const planFile = path.join(directory, 'PLAN.json'), output = path.join(directory, 'preview.json');
    try {
        fs.writeFileSync(planFile, JSON.stringify({ roomId: '25788785', source: {}, clips }));
        const before = fs.readFileSync(planFile, 'utf8');
        const preview = await run({ command: 'preview', plan: planFile, output, 'max-standalone': '2' }, { rootConfig: {} });
        expect(preview.publication.recommendedCount).toBe(2);
        const restored = await run({ command: 'restore', plan: output, indices: '1,5', output: path.join(directory, 'restored.json') });
        expect(restored.clips).toEqual([clips[0], clips[4]]);
        const repeat = await run({ command: 'preview', plan: output, output: path.join(directory, 'repeat.json') }, { rootConfig: {} });
        expect(repeat.publication.inputCount).toBe(clips.length);
        const restoredPreview = await run({ command: 'preview', plan: path.join(directory, 'restored.json'),
            output: path.join(directory, 'restored-preview.json') }, { rootConfig: {} });
        expect(restoredPreview.publication.inputCount).toBe(2);
        expect(fs.readFileSync(planFile, 'utf8')).toBe(before);
        await expect(run({ command: 'preview', plan: planFile, output }, { rootConfig: {} })).rejects.toThrow('already exists');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
