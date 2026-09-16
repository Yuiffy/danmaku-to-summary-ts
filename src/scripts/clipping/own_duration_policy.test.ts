export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const own = require('../own_stream_clipper');
const generator = require('../ai_text_generator');
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { normalizeAiClips, reusableRecall, isRerankResponseValid } = require('./selection_result');
const { validSelectionResponse } = require('./selection_request');
const { rankThenEdit } = require('./ranked_editorial');

const rootConfig = { ai: { text: { provider: 'daiYu' } } };

test.each([20, 254.154, 600])('keeps a complete %s-second AI topic through recall, rerank, alignment and cached replay', async duration => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'own-duration-'));
    const parsed = { segments: [{ start: 10, end: 10 + duration, text: 'A complete topic, including the closing reaction.' }] };
    const clip = { startCueId: 'G1', endCueId: 'G1', evidenceCueIds: ['G1'], evidenceDanmakuIds: [], sourceKind: 'live_speech', score: 90 };
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (_prompt, options) => ({
        text: JSON.stringify({ clips: [options.requestPhase.startsWith('recall-')
            ? { ...clip, event: 'A complete topic' }
            : { candidateIndex: 1, title: 'A complete topic', description: 'The host explains a topic.', coverText: 'Full\nTopic', score: 90 }] }),
        meta: { model: 'fixture' }
    }));
    const config = own.getOwnStreamClipsConfig({ ownStreamClips: { ai: { rankThenEdit: { enabled: false } } } });
    const run = () => own.planClipsWithStagedAI([], parsed, [], { selectionCacheDirectory: directory }, 20 + duration, config, rootConfig);
    try {
        const first = await run();
        expect(first.clips).toHaveLength(1);
        expect(first.clips[0]).toMatchObject({ start: 10, end: 10 + duration,
            grounding: { status: 'linked', reusedRecall: true } });
        expect(own.alignClipToSubtitleBoundaries(first.clips[0], parsed.segments, config, 20 + duration).end).toBe(10 + duration);
        expect((await run()).clips).toEqual(first.clips);
        expect(generate).toHaveBeenCalledTimes(2);
        for (const [prompt] of generate.mock.calls) {
            expect(prompt).toContain('时长由内容完整性决定');
            expect(prompt).not.toContain('35-210');
            expect(prompt).not.toContain('最多允许5秒边界容差');
        }
    } finally { generate.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('ranked detail editing preserves both long and short selected topics under their original IDs', async () => {
    const parsed = { segments: [{ start: 10, end: 264.154, text: 'Complete long discussion.' },
        { start: 400, end: 420, text: 'Complete short exchange.' }] };
    const candidates = [{ index: 31, start: 10, end: 264.154 }, { index: 47, start: 400, end: 420 }];
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (_prompt, options) => ({
        text: JSON.stringify(options.requestPhase === 'global-rank'
            ? { selected: candidates.map(c => ({ candidateIndex: c.index, score: 90, reason: 'Complete topic' })), skipped: [] }
            : { clips: candidates.map((c, index) => ({ candidateIndex: c.index, startCueId: `G${index + 1}`, endCueId: `G${index + 1}`,
                evidenceCueIds: [`G${index + 1}`], evidenceDanmakuIds: [], sourceKind: 'live_speech', score: 90,
                title: 'A complete topic', description: 'The host explains a topic.', coverText: 'Full\nTopic', reason: 'Complete topic' })) }),
        meta: { model: 'fixture' }
    }));
    const diagnostics = { requests: [], errors: [] };
    try {
        const result = await rankThenEdit(candidates, parsed, [], {}, own.getOwnStreamClipsConfig({}), rootConfig,
            diagnostics, 'Host', own.refineCandidatesWithAI);
        expect(result.map(c => ({ candidateIndex: c.candidateIndex, start: c.start, end: c.end }))).toEqual(
            candidates.map(c => ({ candidateIndex: c.index, start: c.start, end: c.end })));
        expect(diagnostics['validation']).toMatchObject({ proposed: 2, accepted: 2, rejected: [] });
        expect(generate.mock.calls[0][0]).toContain('不按固定最短或最长秒数淘汰');
    } finally { generate.mockRestore(); }
});

test('full-context selection keeps complete topics but rejects reversed and out-of-source time ranges', async () => {
    const parsed = { segments: [{ start: 10, end: 264, text: 'Complete discussion.' }, { start: 400, end: 420, text: 'A short reaction.' }] };
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: JSON.stringify({ clips: [
        { startTime: '00:00:10', endTime: '00:04:24', title: 'Full discussion', score: 90 },
        { startTime: '00:06:40', endTime: '00:07:00', title: 'Short reaction', score: 80 },
        { startTime: '00:03:00', endTime: '00:02:00', title: 'Reversed' },
        { startTime: '00:09:30', endTime: '00:11:00', title: 'Outside recording' }
    ] }), meta: {} });
    try {
        const result = await own.planClipsWithAIFullContext(parsed, [], {}, 600, own.getOwnStreamClipsConfig({}), rootConfig);
        expect(result.map(c => [c.start, c.end])).toEqual([[10, 264], [400, 420]]);
        expect(generate.mock.calls[0][0]).toContain('时长由内容完整性决定');
        expect(generate.mock.calls[0][0]).not.toContain('35-210');
    } finally { generate.mockRestore(); }
});

test('removing editorial length limits keeps evidence, source range and invalid-window checks', () => {
    const evidence = buildSubtitleEvidence([{ start: 10, end: 610, text: 'A complete discussion.' }]);
    const clip = { candidateIndex: 1, startCueId: 'G1', endCueId: 'G1', title: 'Complete topic', evidenceCueIds: ['G1'], sourceKind: 'live_speech' };
    const candidate = { index: 1, start: 10, end: 610, startCueId: 'G1', endCueId: 'G1',
        grounding: { status: 'linked', sourceSha256: evidence.sourceSha256, subtitleIds: ['G1'], danmakuIds: [], sourceKind: 'live_speech' } };
    const config = own.getOwnStreamClipsConfig({});
    const response = value => ({ text: JSON.stringify({ clips: [value] }) });
    expect(reusableRecall(candidate, evidence, config)).not.toBeNull();
    expect(validSelectionResponse(response(clip), evidence, new Set(['1']), config, new Set(['G1']))).toBe(true);
    expect(isRerankResponseValid(response(clip), [candidate], 610, config, evidence, [], new Set(['G1']))).toBe(true);
    expect(isRerankResponseValid(response(clip), [candidate], 600, config, evidence, [], new Set(['G1']))).toBe(false);
    expect(validSelectionResponse(response({ ...clip, endCueId: 'G404' }), evidence, null, config)).toBe(false);
    expect(validSelectionResponse(response(clip), evidence, null, config, new Set())).toBe(false);
    expect(validSelectionResponse(response({ ...clip, candidateIndex: 99 }), evidence, new Set(['1']), config)).toBe(false);
    expect(reusableRecall({ ...candidate, grounding: { ...candidate.grounding, sourceSha256: 'stale' } }, evidence, config)).toBeNull();
    const rejected = [];
    expect(normalizeAiClips([{ candidateIndex: 1, startTime: '00:00:10', endTime: '00:00:10' }],
        [candidate], 610, config, 'Host', null, [], null, null, rejected)).toEqual([]);
    expect(rejected[0].reason).toBe('invalid_time_range');
});
