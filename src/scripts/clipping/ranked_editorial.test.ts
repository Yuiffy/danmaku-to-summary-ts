export {};
const { buildCandidateCards, rankPrompt, parseRanking, rankThenEdit, packCandidateCards, unpackCandidateCards, detailResponseFormat } = require('./ranked_editorial');
const generator = require('../ai_text_generator');
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
