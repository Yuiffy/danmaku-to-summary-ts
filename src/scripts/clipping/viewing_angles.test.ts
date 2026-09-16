export {};
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { normalizeViewingAngles, anglesForWindow, contextualComments, quoteEchoes } = require('./viewing_angles');
const { buildCandidateCards, packCandidateCards, unpackCandidateCards, parseRanking, rankPrompt, rankResponseFormat } = require('./ranked_editorial');
const { buildRecallCandidatePool } = require('./own_selection');
const { buildRerankEvidence } = require('./rerank_evidence');
const { normalizeAiClips } = require('./selection_result');
const parsed = { segments: [{ start: 10, end: 15, text: '这里有小壶' },
    { start: 20, end: 25, text: '妈妈来了快跑' }, { start: 30, end: 35, text: '他们为什么不反抗啊好可怜' },
    { start: 60, end: 65, text: '我怎么召唤你呢' }] };
const evidence = buildSubtitleEvidence(parsed.segments);
const danmaku = [{ time: 21, text: '妈妈来了' }, { time: 23, text: '壶妈妈' }, { time: 32, text: '一边说可怜一边砍' },
    { time: 61, text: '那是你的帮手' }];
const angle = { label: '语音与台词', hook: '把突然出现的敌人叫妈妈', evidenceCueIds: ['G2'], evidenceDanmakuIds: ['D1'] };
const candidate = () => ({ index: 1, candidateIndex: 'chunk-1-1', start: 10, end: 35, event: '可怜敌人却继续砍', modelScore: 91,
    viewingAngles: normalizeViewingAngles([angle], { start: 10, end: 35 }, evidence, danmaku).angles });

test('optional labels allow new interests, but invented or off-window anchors never enter cards', () => {
    expect(normalizeViewingAngles([{ ...angle, label: '自定义的小兴趣' }], candidate(), evidence, danmaku).angles[0].label).toBe('自定义的小兴趣');
    for (const invalid of [{ ...angle, evidenceCueIds: ['G99'] }, { ...angle, evidenceCueIds: ['G4'] },
        { ...angle, evidenceDanmakuIds: ['D4'] }, { ...angle, evidenceCueIds: [] }]) {
        const result = normalizeViewingAngles([invalid], candidate(), evidence, danmaku);
        expect(result.angles).toEqual([]); expect(result.issues).toHaveLength(1);
    }
    expect(normalizeViewingAngles([angle], candidate(), evidence, danmaku, { cueIds: new Set(['G1']) }).angles).toEqual([]);
    expect(anglesForWindow({ viewingAngles: [{ ...candidate().viewingAngles[0], sourceSha256: 'stale' }] }, candidate(), evidence, danmaku)).toEqual([]);
});

test('ranking carries the secondary line and contextual audience originals even when the summary has another focus', () => {
    const card = buildCandidateCards([candidate()], parsed, danmaku, { ai: { rankThenEdit: { cardChars: 300 } } }).cards[0];
    expect(card.speechExcerpts.some(row => row.text === '妈妈来了快跑')).toBe(true);
    expect(card.contextComments).toContainEqual({ id: 'D2', time: 23, text: '壶妈妈', authority: 'audience_context_hint' });
    expect(card.contextComments.every(row => row.time <= 35)).toBe(true);
    expect(card.viewingAngles[0].authority).toBe('unverified_editorial_hint');
    expect(card.quoteEchoes).toContainEqual(expect.objectContaining({ cueId: 'G2', quote: '妈妈来了', audienceId: 'D1' }));
    expect(unpackCandidateCards(packCandidateCards([card]))).toEqual([card]);
    const oldPacket = packCandidateCards([card]); oldPacket.version = 1; oldPacket.rows[0] = oldPacket.rows[0].slice(0, 9);
    expect(unpackCandidateCards(oldPacket)[0].speechExcerpts).toEqual(card.speechExcerpts);
});

test('context comments remain local and preserve source IDs despite sorting and duplicate reactions', () => {
    const rows = [{ time: 4, text: '妈妈来了' }, ...danmaku, { time: 22, text: '哈哈哈哈' }, { time: 24, text: '妈妈来了' }];
    const chosen = contextualComments(rows, { start: 10, end: 35 }, evidence.cues);
    expect(chosen.find(row => row.text === '妈妈来了').id).toBe('D2');
    expect(chosen.filter(row => row.text === '妈妈来了')).toHaveLength(1);
    expect(chosen.some(row => row.text.includes('哈哈'))).toBe(false);
});

test('pool merge retains distinct hooks with original anchors and explains cap losses without assigning tag quotas', () => {
    const first = candidate();
    const second = { ...first, candidateIndex: 'chunk-2-1', index: undefined, modelScore: 90,
        viewingAngles: normalizeViewingAngles([{ ...angle, label: '反差', hook: '一边可怜一边砍', evidenceCueIds: ['G3'], evidenceDanmakuIds: ['D3'] }], first, evidence, danmaku).angles };
    const other = { start: 60, end: 65, index: 9, score: 20 };
    const diagnostics = {};
    const pool = buildRecallCandidatePool([other], [first, second], { ai: { maxCandidateLines: 1 } }, diagnostics);
    // A high local percentile can win; tags do not override the selected policy.
    expect(pool).toHaveLength(1);
    expect(diagnostics['recallPool'].candidates.filter(row => row.disposition === 'candidate_pool_limit')).toHaveLength(2);
    const merged = buildRecallCandidatePool([], [first, second], { ai: { maxCandidateLines: 10 } });
    expect(merged).toHaveLength(1);
    expect(merged[0].viewingAngles.map(row => row.label)).toEqual(['语音与台词', '反差']);
});

test('detail receives anchored hooks; narrowing the final clip removes annotations outside its actual content', () => {
    const base = { ...candidate(), globalSelection: { reason: '寻找伙伴并求助，不能改成捡道具' } };
    const packet = buildRerankEvidence([base], parsed, danmaku, {});
    expect(packet.records[0].focus).toEqual({ reason: base.globalSelection.reason, authority: 'unverified_global_selection' });
    expect(packet.records[0].va[0].evidenceCueIds).toEqual(['G2']);
    expect(packet.danmakuIds.has('D1')).toBe(true);
    const output = normalizeAiClips([{ candidateIndex: 1, startCueId: 'G3', endCueId: 'G3', title: '可怜',
        description: '可怜', coverText: '可怜敌人\n为什么不动', evidenceCueIds: ['G3'], sourceKind: 'live_speech' }],
    [base], 65, {}, 'Host', evidence, danmaku);
    expect(output[0].viewingAngles).toEqual([]);
    expect(output[0].quoteEchoes).toEqual([]);
    expect(output[0].base.viewingAngles).toHaveLength(1);
    const preserved = normalizeAiClips([{ candidateIndex: 1, startCueId: 'G1', endCueId: 'G3', title: '觉得可怜还要砍',
        description: '敌人不反抗', coverText: '觉得可怜\n先下手为强', evidenceCueIds: ['G3'], sourceKind: 'live_speech' }],
        [base], 65, {}, 'Host', evidence, danmaku);
    expect(preserved[0].quoteEchoes[0].quote).toBe('妈妈来了');
});

test('new rankings account for every candidate with a concrete disposition; old parser remains readable', () => {
    const pool = [{ index: 1 }, { index: 2 }], selected = [{ candidateIndex: 1, score: 90, reason: 'distinct line' }];
    expect(parseRanking(JSON.stringify({ selected, skipped: [{ candidateIndex: 2, reason: 'same incident and same line' }] }), pool, 1, true)).toEqual(selected);
    for (const skipped of [undefined, [], [{ candidateIndex: 1, reason: 'duplicate' }], [{ candidateIndex: 9, reason: 'invented' }], [{ candidateIndex: 2, reason: '' }]]) {
        expect(() => parseRanking(JSON.stringify({ selected, skipped }), pool, 1, true)).toThrow();
    }
    expect(parseRanking(JSON.stringify({ selected }), pool, 1)).toEqual(selected);
    const decisions = [{ ...selected[0], selected: true }, { candidateIndex: 2, selected: false, score: 60, reason: 'same incident' }];
    expect(parseRanking(JSON.stringify({ decisions }), pool, 1, true)).toEqual(selected);
    expect(() => parseRanking(JSON.stringify({ decisions: [...decisions, decisions[0]] }), pool, 2, true)).toThrow();
    expect(() => parseRanking(JSON.stringify({ decisions: decisions.slice(0, 1) }), pool, 2, true)).toThrow();
    expect(() => parseRanking(JSON.stringify({ decisions: decisions.map(row => ({ ...row, selected: true })) }), pool, 1, true)).toThrow();
    expect(rankResponseFormat(pool).schema.properties.decisions).toMatchObject({ minItems: 2, maxItems: 2 });
});

test('quote overlaps generalize without topic keywords and never imply voice quality or audience consensus', () => {
    const cues = [{ id: 'G1', start: 30, end: 40, text: '舰长驾到大家快跑' }];
    const rows = [{ time: 35, text: '舰长驾到' }, { time: 200, text: '舰长驾到' }, { time: 36, text: '[哈哈哈哈]' }];
    expect(quoteEchoes(rows, { start: 0, end: 60 }, cues)).toEqual([{
        cueId: 'G1', quote: '舰长驾到', sourceText: cues[0].text, start: 30, end: 40,
        audienceId: 'D1', audienceTime: 35, authority: 'literal_overlap_not_attribution'
    }]);
    const prompt = rankPrompt([], {}, 50, { priorityCategories: ['低热度的角色互动'] });
    expect(prompt).toContain('低热度的角色互动');
    expect(prompt).toContain('不设固定名额');
    expect(prompt).toContain('只读字幕不能声称已听过音频或看过画面');
    const longCue = { ...cues[0], text: '前文'.repeat(2000) + '舰长驾到' + '后文'.repeat(2000) };
    const longEcho = quoteEchoes(rows, { start: 0, end: 60 }, [longCue])[0];
    expect(longEcho.sourceTextPartial).toBe(true);
    expect(longEcho.sourceText).toContain('舰长驾到');
    expect(longEcho.sourceText.length).toBeLessThanOrEqual(222);
    expect(longEcho.start).toBe(30); // Cue times are not word-level alignment.
});
