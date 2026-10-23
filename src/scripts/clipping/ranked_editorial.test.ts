export {};
const { buildCandidateCards, rankPrompt, parseRanking, rankThenEdit, packCandidateCards, unpackCandidateCards, detailResponseFormat, rankResponseFormat } = require('./ranked_editorial');
const generator = require('../ai_text_generator');
const fs = require('fs'), os = require('os'), path = require('path');
const parsed = { segments: Array.from({ length: 120 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, text: `Full source fact ${i}` })) };
const candidates = Array.from({ length: 6 }, (_, i) => ({ index: i + 1, start: i * 40, end: i * 40 + 38,
    recallScore: 80 - i, recallSources: i === 0 ? ['local_signals'] : ['model_chunked'], event: i ? `Event ${i}` : '' }));
test('global cards explicitly mark excerpts and give local-only candidates actual source text', () => {
    const packet = buildCandidateCards(candidates, parsed, [], { ai: { rankThenEdit: { cardChars: 300 } } });
    expect(packet.cards[0]).toMatchObject({ eventSummary: null, excerptsOnly: true, summaryAuthority: 'no_model_summary_read_excerpts' });
    expect(packet.cards[0].speechExcerpts.length).toBeGreaterThan(1);
    expect(unpackCandidateCards(packCandidateCards(packet.cards))).toEqual(packet.cards);
    expect(rankPrompt(packet.cards, {}, 6)).toContain('不写标题');
});

test('a short conversation retains the schedule answer even when recall only describes a name joke', () => {
    const source = { segments: Array.from({ length: 16 }, (_, i) => ({ start: i * 3, end: i * 3 + 1,
        text: i === 10 ? '我们约到下个月了，大家比较忙' : `原话${i}` })) };
    const card = buildCandidateCards([{ index: 1, start: 0, end: 46, event: '讨论游戏名称',
        recallSources: ['model_chunked'] }], source, [], { ai: { rankThenEdit: { cardChars: 300 } } }).cards[0];
    expect(card.speechExcerpts.map(row => row.text)).toEqual(source.segments.map(row => row.text));
    expect(card.speechExcerpts.every(row => row.partial === false)).toBe(true);
    expect(unpackCandidateCards(packCandidateCards([card]))).toEqual([card]);
});

test('complete short cards include a final cue with less than forty characters remaining; long cards stay bounded', () => {
    const source = { segments: [{ start: 0, end: 1, text: '甲'.repeat(275) },
        { start: 3, end: 4, text: '下个月一起玩' }, { start: 6, end: 7, text: '不属于片内' }] };
    const item = { index: 1, start: 0, end: 4 };
    const config = { ai: { rankThenEdit: { cardChars: 300 } } };
    const card = buildCandidateCards([item], source, [], config).cards[0];
    expect(card.speechExcerpts.map(row => row.text)).toEqual(source.segments.slice(0, 2).map(row => row.text));
    const longSource = { segments: source.segments.map(row => ({ ...row, text: row.text.repeat(4) })) };
    const longCard = buildCandidateCards([item], longSource, [], config).cards[0];
    expect(longCard.speechExcerpts.reduce((sum, row) => sum + row.text.length, 0)).toBeLessThanOrEqual(300);
    expect(longCard.speechExcerpts.every(row => row.time[1] <= 4)).toBe(true);
});
test.each([[{ candidateIndex: 999, score: 80, reason: 'invented' }], [{ candidateIndex: 1, score: 80, reason: 'one' },
    { candidateIndex: 1, score: 80, reason: 'duplicate' }]])('ranking rejects invented or duplicate selection IDs', selected => {
    expect(() => parseRanking(JSON.stringify({ selected }), candidates, 6)).toThrow();
});
test('native detail schema keeps global IDs and requires explicit source evidence', () => {
    const schema = detailResponseFormat([{ index: 41 }, { index: 47 }, { index: 31 }]).schema;
    expect(schema.properties.clips.items.properties.candidateIndex.enum).toEqual([41, 47, 31]);
    expect(schema.properties.clips.items.required).toEqual(expect.arrayContaining(['startCueId', 'endCueId', 'evidenceCueIds', 'sourceKind']));
    expect(schema.properties.clips.items.additionalProperties).toBe(false);
});
test('details run concurrently, receive full original evidence and return globally scored chronological clips', async () => {
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: JSON.stringify({ decisions:
        candidates.map(c => ({ candidateIndex: c.index, selected: true, score: 90 - c.index, reason: 'ranked' })) }), meta: {} });
    let active = 0, peak = 0;
    const refine = jest.fn(async (group, fullParsed, _danmaku, _info, _config, _root, diagnostics, _name, stage) => {
        active++; peak = Math.max(peak, active);
        expect(fullParsed).toBe(parsed); expect(stage.selectedOnly).toBe(true);
        expect(group.every(c => c.globalSelection?.reason === 'ranked')).toBe(true);
        await new Promise(resolve => setImmediate(resolve)); active--;
        diagnostics.validation = { rejected: [] };
        return group.map(c => ({ candidateIndex: c.index, start: c.start, end: c.end, score: 1 }));
    });
    try {
        const diagnostics = { requests: [], errors: [] };
        const result = await rankThenEdit(candidates, parsed, [], {}, { maxClips: 6, ai: { model: 'fixture', rankThenEdit: { detailBatchSize: 2, detailConcurrency: 2 } } },
            { ai: { text: { provider: 'daiYu' } } }, diagnostics, 'Host', refine);
        expect(peak).toBe(2); expect(result.map(c => c.candidateIndex)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(result[0].score).toBe(89); expect(diagnostics.detailBatches).toHaveLength(3);
    } finally { generate.mockRestore(); }
});

test('unselected local-only topics receive a short label in the existing ranking request without extra detail generation', async () => {
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: JSON.stringify({ decisions:
        candidates.map(c => ({ candidateIndex: c.index, selected: false, topic: `原话中的话题${c.index}`, score: 40, reason: '看点偏弱' })) }), meta: {} });
    const refine = jest.fn();
    try {
        const diagnostics = { requests: [], errors: [] };
        expect(await rankThenEdit(candidates, parsed, [], {}, { maxClips: 6, ai: { model: 'fixture', rankThenEdit: {} } },
            { ai: { text: { provider: 'daiYu' } } }, diagnostics, 'Host', refine)).toEqual([]);
        expect(generate).toHaveBeenCalledTimes(1);
        expect(refine).not.toHaveBeenCalled();
        expect(diagnostics.ranking.skipped[0]).toMatchObject({ candidateIndex: 1, title: '原话中的话题1', score: 40, reason: '看点偏弱' });
        const item = rankResponseFormat(candidates).schema.properties.decisions.items;
        expect(item.required).toContain('topic');
        expect(item.properties.topic.maxLength).toBe(24);
        expect(item.properties.reason.maxLength).toBe(36);
    } finally { generate.mockRestore(); }
});

const quotaCandidates = Array.from({ length: 100 }, (_, i) => ({ index: i + 1, start: i * 2, end: i * 2 + 2,
    recallSources: ['model_chunked'], event: `话题${i + 1}` }));
const quotaResponse = (selectedIds = quotaCandidates.slice(0, 58).map(row => row.index)) => ({ text: JSON.stringify({
    decisions: quotaCandidates.map(row => ({ candidateIndex: row.index, selected: selectedIds.includes(row.index),
        topic: row.event, score: 100 - row.index, reason: selectedIds.includes(row.index) ? '具体独立看点' : '相对优先级较低' }))
}), meta: { finishReason: 'completed' } });
const quotaConfig = { maxClips: 50, ai: { model: 'fixture', rerankMaxAttempts: 5,
    rankThenEdit: { detailBatchSize: 6, detailConcurrency: 2 } } };
const runQuotaRanking = (diagnostics, refine, info = {}) => rankThenEdit(quotaCandidates, parsed, [], info, quotaConfig,
    { ai: { text: { provider: 'daiYu' } } }, diagnostics, 'Host', refine);

test('58 selections receive one reusable quota correction and only the corrected 50 enter detail editing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rank-quota-'));
    const original = quotaResponse(), selectedIds = Array.from({ length: 50 }, (_, i) => i + 9);
    const corrected = quotaResponse(selectedIds);
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu')
        .mockResolvedValueOnce(original).mockResolvedValueOnce(corrected);
    const refine = jest.fn(async group => group.map(row => ({ candidateIndex: row.index, start: row.start, end: row.end })));
    const diagnostics = { requests: [], errors: [] };
    try {
        const result = await runQuotaRanking(diagnostics, refine, { selectionCacheDirectory: directory });
        expect(result.map(row => row.candidateIndex)).toEqual(selectedIds);
        expect(generate).toHaveBeenCalledTimes(2);
        const [correctionPrompt, options] = generate.mock.calls[1];
        expect(correctionPrompt).toContain('入选 58 个，超过最多 50 个');
        expect(correctionPrompt).toContain(original.text);
        expect(correctionPrompt).toContain('每个ID恰好一行');
        expect(options).toMatchObject({ requestPhase: 'global-rank-quota-correction', structuredOutputKey: 'decisions' });
        expect(diagnostics.ranking.quotaCorrection).toMatchObject({ status: 'corrected', selectedCount: 58,
            maxClips: 50, correctedSelectedCount: 50, originalResponse: original.text, correctedResponse: corrected.text });
        expect(diagnostics.ranking.selected).toHaveLength(50);
        expect(diagnostics.ranking.skipped).toHaveLength(50);
        expect([...diagnostics.ranking.selected, ...diagnostics.ranking.skipped].every(row => row.reason)).toBe(true);
        expect(fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(
            fs.readFileSync(path.join(directory, name), 'utf8'))).some(value => value.result?.text === original.text)).toBe(true);
        const replayDiagnostics = { requests: [], errors: [] };
        const replay = await runQuotaRanking(replayDiagnostics, refine, { selectionCacheDirectory: directory });
        expect(replay.map(row => row.candidateIndex)).toEqual(selectedIds);
        expect(generate).toHaveBeenCalledTimes(2);
        expect(replayDiagnostics.requests.filter(row => row.phase.startsWith('global-rank')))
            .toEqual([expect.objectContaining({ phase: 'global-rank', cacheHit: true }),
                expect.objectContaining({ phase: 'global-rank-quota-correction', cacheHit: true })]);
    } finally { generate.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a quota correction that still selects too many stops after two calls with concrete counts', async () => {
    const original = quotaResponse(), corrected = quotaResponse(quotaCandidates.slice(0, 51).map(row => row.index));
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu')
        .mockResolvedValueOnce(original).mockResolvedValueOnce(corrected);
    const refine = jest.fn(), diagnostics = { requests: [], errors: [] };
    try {
        await expect(runQuotaRanking(diagnostics, refine)).rejects.toMatchObject({ code: 'RANKED_SELECTION_LIMIT',
            message: 'Invalid ranked selection size: selected=51, maxClips=50', selectedCount: 51, maxClips: 50 });
        expect(generate).toHaveBeenCalledTimes(2);
        expect(refine).not.toHaveBeenCalled();
        expect(diagnostics.ranking.quotaCorrection).toMatchObject({ status: 'failed', originalResponse: original.text,
            correctedResponse: corrected.text, error: 'Invalid ranked selection size: selected=51, maxClips=50' });
    } finally { generate.mockRestore(); }
});

test.each(['unknown', 'missing', 'duplicate'])('an over-quota response with %s IDs fails before quota correction', async kind => {
    const malformed = quotaResponse(), data = JSON.parse(malformed.text);
    if (kind === 'unknown') data.decisions[0].candidateIndex = 999;
    if (kind === 'missing') data.decisions.pop();
    if (kind === 'duplicate') data.decisions[0].candidateIndex = 2;
    malformed.text = JSON.stringify(data);
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue(malformed);
    const refine = jest.fn(), diagnostics = { requests: [], errors: [] };
    try {
        await expect(runQuotaRanking(diagnostics, refine)).rejects.toThrow(kind === 'missing'
            ? 'Missing candidate decisions' : 'Invalid ranked candidate');
        expect(generate).toHaveBeenCalledTimes(1);
        expect(refine).not.toHaveBeenCalled();
        expect(diagnostics.ranking).toBeUndefined();
    } finally { generate.mockRestore(); }
});

test('a quota correction cannot hide missing decisions or trigger another correction', async () => {
    const malformed = quotaResponse(), data = JSON.parse(malformed.text);
    data.decisions.pop(); malformed.text = JSON.stringify(data);
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu')
        .mockResolvedValueOnce(quotaResponse()).mockResolvedValueOnce(malformed);
    const refine = jest.fn(), diagnostics = { requests: [], errors: [] };
    try {
        await expect(runQuotaRanking(diagnostics, refine)).rejects.toThrow('Missing candidate decisions');
        expect(generate).toHaveBeenCalledTimes(2);
        expect(refine).not.toHaveBeenCalled();
        expect(diagnostics.ranking.quotaCorrection.status).toBe('failed');
    } finally { generate.mockRestore(); }
});

test.each(['initial', 'correction'])('an unknown %s transport outcome is propagated without another request', async phase => {
    const failure = Object.assign(new Error('Request timed out; outcome unknown'), { outcomeUnknown: true });
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu');
    if (phase === 'correction') generate.mockResolvedValueOnce(quotaResponse());
    generate.mockRejectedValueOnce(failure);
    const refine = jest.fn(), diagnostics = { requests: [], errors: [] };
    try {
        await expect(runQuotaRanking(diagnostics, refine)).rejects.toBe(failure);
        expect(generate).toHaveBeenCalledTimes(phase === 'correction' ? 2 : 1);
        expect(refine).not.toHaveBeenCalled();
    } finally { generate.mockRestore(); }
});

test('an over-quota response marked outcome unknown is never resubmitted', async () => {
    const response = { ...quotaResponse(), meta: { outcomeUnknown: true } };
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue(response);
    const refine = jest.fn();
    try {
        await expect(runQuotaRanking({ requests: [], errors: [] }, refine)).rejects.toMatchObject({ code: 'RANKED_SELECTION_LIMIT' });
        expect(generate).toHaveBeenCalledTimes(1);
        expect(refine).not.toHaveBeenCalled();
    } finally { generate.mockRestore(); }
});
