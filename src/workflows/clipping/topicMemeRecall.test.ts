import { findTopicMemeMatches, topicMemeIdentityIssues, topicMemeAudienceContext } from './topicMemeRecall';
import { mergeTopicRecallMatches, topicRecallIdentityIssues, topicRecallSubtitleEditSupport } from './topicRecall';
import { planTopicAudio, topicAudioSettings, gateTopicAudioHits } from './topicAudio';

const config = { keywords: ['岁己', '小岁', 'SUI'], ignoredRoomIds: ['25788785'],
    review: { enabled: true, mode: 'preflight' }, memeRecall: { enabled: true, contextSeconds: 60,
        rules: [{ id: 'sui-pig-title', keyword: '岁己', targetNames: ['岁己', '小岁', 'SUI'],
            forms: ['陪你这个猪', '配你这个猪'] }] } };
const source = [
    { start: 4632.25, end: 4634.329, text: '那我今天是不是今天要配你这个猪' },
    { start: 4635.609, end: 4637.39, text: '今天周二也来配你这个猪' },
    { start: 4637.43, end: 4638.97, text: '今天周五要配你这个猪' },
    { start: 4639.05, end: 4641.029, text: '今天周六要配这个猪猪死' },
    { start: 4655.38, end: 4657.765, text: '我看最近瑞娅前辈好像在用这个猪' }
];
const subtitles = source.map((cue, index) => ({ ...cue, id: `G${index + 1}` }));
const match = findTopicMemeMatches(source, config)[0];
const hit = { cueId: 'G1', verdict: 'mention', evidenceCueIds: ['G1'], evidenceDanmakuIds: ['D1'], recall: match.recall };
const bounds = { start: 4632.25, end: 4641.029 };
const audience = [{ id: 'D1', time: 4679.286, text: '岁己前辈先用的' }];

test('recalls the original unnamed August 7 phrase without changing subtitle words or asserting identity', () => {
    const original = structuredClone(source);
    const result = mergeTopicRecallMatches(source, [], config, { roomId: '1741667419' });
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ index: 0, segment: source[0], matchedKeywords: ['岁己'],
        recall: { kind: 'meme_reference', requiresSemanticConfirmation: true,
            meme: { phrase: '配你这个猪', cues: [source[0]] } } });
    expect(result.every(row => !row.segment.text.includes('岁己') && !('verdict' in row))).toBe(true);
    expect(source).toEqual(original);
});

test('joins punctuation and at most three adjacent source rows, retaining each original cue', () => {
    const rows = [{ start: 0, end: 2, text: '今天陪你' }, { start: 2.2, end: 4, text: '，这个' },
        { start: 4.2, end: 5, text: '猪过周一' }];
    const matches = findTopicMemeMatches(rows, config);
    expect(matches).toHaveLength(1);
    expect(matches[0].recall.meme.cues).toEqual(rows);
    expect(findTopicMemeMatches([rows[0], { ...rows[1], start: 10, end: 12 }, rows[2]], config)).toEqual([]);
    expect(findTopicMemeMatches([rows[0], rows[1], { ...rows[2], end: 18 }], config)).toEqual([]);
    expect(findTopicMemeMatches([{ start: 0, end: 1, text: '陪' }, { start: 1, end: 2, text: '你' },
        { start: 2, end: 3, text: '这个' }, { start: 3, end: 4, text: '猪' }], config)).toEqual([]);
});

test.each(['搞了个大笑', '搞了个大宵', '煮死你这个猪', '谢谢陪你这位观众', '陪你这个小猪'])('does not broaden to generic wording: %s', text => {
    expect(findTopicMemeMatches([{ start: 0, end: 4, text }], config)).toEqual([]);
});

test('honors target configuration, room restrictions and the existing preflight requirement', () => {
    expect(findTopicMemeMatches(source, { ...config, memeRecall: { enabled: false } })).toEqual([]);
    expect(findTopicMemeMatches(source, { ...config, review: { enabled: true, mode: 'shadow' } })).toEqual([]);
    expect(findTopicMemeMatches(source, { ...config, review: { enabled: false, mode: 'preflight' } })).toEqual([]);
    expect(findTopicMemeMatches(source, { ...config, keywords: ['另一个人'] })).toEqual([]);
    expect(findTopicMemeMatches(source, config, { roomId: '25788785' })).toEqual([]);
    const restricted = { ...config, memeRecall: { ...config.memeRecall,
        rules: [{ ...config.memeRecall.rules[0], roomIds: ['1741667419'] }] } };
    expect(findTopicMemeMatches(source, restricted, { roomId: 'another-room' })).toEqual([]);
    expect(findTopicMemeMatches(source, restricted, { roomId: '1741667419' })).toHaveLength(3);
});

test('keeps a literal name anchor unchanged when its cue also contains a meme', () => {
    const rows = [{ start: 0, end: 4, text: '岁己的陪你这个猪过周一' }];
    const literal = { index: 0, segment: rows[0], matchedKeywords: ['岁己'] };
    expect(mergeTopicRecallMatches(rows, [literal], config)).toEqual([literal]);
    expect(mergeTopicRecallMatches(rows, [literal], config)[0]).toBe(literal);
});

test('nearby explicit audience attribution can resolve the retained phrase without fabricating a spoken name', () => {
    expect(topicRecallIdentityIssues([hit], subtitles, bounds, audience)).toEqual([]);
    expect(topicMemeIdentityIssues([hit], subtitles, bounds, [{ ...audience[0], text: '小岁的梗' }])).toEqual([]);
    expect(topicMemeIdentityIssues([hit], subtitles, bounds, [{ ...audience[0], text: 'SUI先用的' }])).toEqual([]);
    expect(audience[0].time).toBeGreaterThan(bounds.end); // Context is separate from retained speech/copy evidence.
});

test.each([
    [], [{ ...audience[0], text: '哈哈哈哈' }], [{ ...audience[0], text: '岁己' }],
    [{ ...audience[0], text: '瑞娅前辈先用的' }], [{ ...audience[0], text: 'SUICA先用的' }],
    [{ ...audience[0], time: 4800 }], [{ ...audience[0], id: 'D2' }]
].map(rows => [rows]))('a model mention label, repeated phrases or unlinked audience evidence cannot establish the target: %j', rows => {
    expect(topicMemeIdentityIssues([hit], subtitles, bounds, rows)).not.toEqual([]);
});

test('only cited in-clip speech explicitly linking the target can substitute for audience attribution', () => {
    const linked = [...subtitles, { id: 'G6', start: 4642, end: 4645, text: '这是岁己的标题梗' }];
    const window = { start: bounds.start, end: 4645 };
    const assessed = { ...hit, evidenceCueIds: ['G1', 'G6'], evidenceDanmakuIds: [] };
    expect(topicMemeIdentityIssues([assessed], linked, window)).toEqual([]);
    expect(topicMemeIdentityIssues([assessed], linked, bounds)).not.toEqual([]);
    expect(topicMemeIdentityIssues([hit], linked, window)).not.toEqual([]);
});

test('uncertain association, missing phrase cues and a partial cross-cue cut remain on hold', () => {
    expect(topicMemeIdentityIssues([{ ...hit, verdict: 'uncertain' }], subtitles, bounds, audience)[0]).toContain('尚未确认');
    expect(topicMemeIdentityIssues([hit], subtitles, { ...bounds, start: 4633 }, audience)[0]).toContain('未完整');
    const rows = [{ start: 10, end: 12, text: '陪你这个' }, { start: 12, end: 14, text: '猪过周五' }];
    const joined = findTopicMemeMatches(rows, config)[0];
    const refs = rows.map((cue, index) => ({ ...cue, id: `G${index + 1}` }));
    const assessed = { ...hit, recall: joined.recall };
    expect(topicMemeIdentityIssues([assessed], refs, { start: 10, end: 14 }, [{ ...audience[0], time: 20 }])[0]).toContain('未完整');
    expect(topicMemeIdentityIssues([{ ...assessed, evidenceCueIds: ['G1', 'G2'] }], refs,
        { start: 10, end: 14 }, [{ ...audience[0], time: 20 }])).toEqual([]);
});

test('meme phrases and their parts cannot be corrected into a person name', () => {
    for (const original of ['配你这个猪', '猪', '配']) for (const replacement of ['岁己', '岁己前辈']) expect(topicRecallSubtitleEditSupport({ original,
        replacement, evidenceCueIds: ['G1'] }, subtitles[0], { hits: [hit], target: { names: config.keywords } },
        new Set(['G1']), [hit])).toBe(false);
});

test('final review keeps only the exact bounded audience citations needed to recheck a meme', () => {
    expect(topicMemeAudienceContext([hit], audience)).toEqual(audience);
    expect(topicMemeAudienceContext([hit], [...audience, { ...audience[0], id: 'D2' }])).toEqual(audience);
    expect(topicMemeAudienceContext([hit], [{ ...audience[0], time: 4800 }])).toEqual([]);
    expect(topicMemeAudienceContext([{ ...hit, evidenceDanmakuIds: [] }], audience)).toEqual([]);
});

test('name-hinted audio work is skipped for an unspoken name while existing ambiguous-name checks still run', () => {
    const meme = { ...hit, id: 'K1', start: source[0].start, end: source[0].end };
    const settings = topicAudioSettings({ enabled: true });
    const budget = { windows: 0, audioSeconds: 0, elapsedMs: 0 };
    expect(planTopicAudio({ hits: [meme], subtitles }, settings, budget)).toEqual({ windows: [], skipped: [] });
    expect(budget.windows).toBe(0);
    expect(gateTopicAudioHits([meme], { windows: [], skipped: [] })[0].verdict).toBe('mention');
    const name = { ...meme, id: 'K2', recall: { kind: 'ambiguous_asr', requiresSemanticConfirmation: true } };
    expect(gateTopicAudioHits([name], { windows: [], skipped: [] })[0].verdict).toBe('uncertain');
});
