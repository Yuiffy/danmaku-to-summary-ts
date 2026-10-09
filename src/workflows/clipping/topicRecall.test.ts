import { findAmbiguousTopicMatches, mergeTopicRecallMatches, topicRecallIdentityIssues,
    topicRecallSubtitleEditSupport } from './topicRecall';
import * as fs from 'fs';
import * as path from 'path';

const root = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../config/production.json'), 'utf8'));
const config = root.clipTopics;
const cues = (texts: string[]) => texts.map((text, index) => ({ start: index * 5, end: index * 5 + 4, text }));

describe('ambiguous topic recall preserves source words for semantic review', () => {
    test.each([
        ['我觉得好震惊然后呢就被随即吐槽', '就随即就说他就是必须要秒回的那种'],
        ['主播主播和自己好起来就会吃醋', '一起支持赛吉斯'],
        ['给小碎看送海獭', '给小碎看送海獭'],
        ['了算什么对随即展', '开畅酣畅淋漓的', '攻击直接化身穿与', '暴龙恶龙咆哮看看'],
        ['黄牌下一个什么随机', '我还不知道这个这个口屁其实是最急的口', '后面才照原来是最级的的屁病', '我去哇上的时候c机突然在我怀里了'],
        ['这一集就会消息息说你去万别理我', '看到了消息就要秒回']
    ])('recalls the audited missed conversation without rewriting it: %j', (...texts: string[]) => {
        const source = cues(texts);
        const snapshot = structuredClone(source);
        const matches = findAmbiguousTopicMatches(source, config);
        expect(matches.length).toBeGreaterThan(0);
        expect(matches.every(match => match.recall?.requiresSemanticConfirmation === true)).toBe(true);
        expect(matches.every(match => source[match.index] === match.segment)).toBe(true);
        expect(source).toEqual(snapshot);
        expect(matches.flatMap(match => match.recall!.hypotheses).every(hypothesis =>
            source.some(cue => cue.text.includes(hypothesis.form)))).toBe(true);
    });

    test.each(['随机抽取一个观众来攻击', '随机生成的攻击数值', '给小碎片画海獭图案',
        '海獭迈着小碎步', '海獭把小碎石踢开', '给海獭买小碎机', '小小碎主播来了',
        '把abc机放在怀里', '我自己给自己买了东西', '这一集剧情很好看'])('skips explicit protected phrases: %s', text => {
        expect(findAmbiguousTopicMatches(cues([text]), config)).toEqual([]);
    });

    test('marks a plausible ordinary adverb as a hypothesis, never an established mention', () => {
        const matches = findAmbiguousTopicMatches(cues(['暴龙随即展开攻击']), config);
        expect(matches).toHaveLength(1);
        expect(matches[0].segment.text).toBe('暴龙随即展开攻击');
        expect(matches[0].recall!.hypotheses[0].form).toBe('随即');
        expect(matches[0]).not.toHaveProperty('verdict');
    });

    test('does not use distant context, unrelated keywords, ignored rooms or a legacy/no-AI-review path', () => {
        const source = [{ start: 0, end: 2, text: '随即来了' }, { start: 200, end: 202, text: '必须秒回' }];
        expect(findAmbiguousTopicMatches(source, config)).toEqual([]);
        const local = cues(['被随即吐槽', '必须秒回']);
        expect(findAmbiguousTopicMatches(local, { ...config, keywords: ['另一个人'] })).toEqual([]);
        expect(findAmbiguousTopicMatches(local, config, { roomId: '25788785' })).toEqual([]);
        expect(findAmbiguousTopicMatches(local, { ...config, ambiguousRecall: { enabled: false } })).toEqual([]);
        expect(findAmbiguousTopicMatches(local, { ...config, review: { enabled: false } })).toEqual([]);
        expect(findAmbiguousTopicMatches(local, { ...config, review: { enabled: true, mode: 'shadow' } })).toEqual([]);
    });

    test('an explicit zero context window uses only overlapping speech', () => {
        const source = cues(['随即来了', '看消息必须秒回']);
        expect(findAmbiguousTopicMatches(source, config)).toHaveLength(1);
        expect(findAmbiguousTopicMatches(source, { ...config,
            ambiguousRecall: { ...config.ambiguousRecall, contextSeconds: 0 } })).toEqual([]);
    });

    test('keeps a literal hit unchanged when the same cue contains an ambiguous word', () => {
        const source = cues(['小岁说随机攻击', '我去哇上的时候c机突然在我怀里了']);
        const literal = { index: 0, segment: source[0], matchedKeywords: ['小岁'] };
        const matches = mergeTopicRecallMatches(source, [literal], config);
        expect(matches).toHaveLength(2);
        expect(matches[0]).toBe(literal);
        expect(matches[0].recall).toBeUndefined();
        expect(matches[1].recall?.kind).toBe('ambiguous_asr');
    });
});

describe('semantic confirmation and source-bound name patches', () => {
    const source = cues(['他这个人要求消息秒回', '我就被随即吐槽', '他说看到了消息就必须回', '我自己也会回复']);
    const match = findAmbiguousTopicMatches(source, config)[0];
    const subtitles = source.map((cue, index) => ({ ...cue, id: `G${index + 1}` }));
    const hit = { cueId: 'G2', verdict: 'mention', evidenceCueIds: ['G2', 'G3'], recall: match.recall };
    const input = { hits: [hit], target: { names: config.keywords } };
    const inside = new Set(subtitles.map(cue => cue.id));

    test('holds uncertainty or a self-supported name claim, including support outside the clip', () => {
        expect(topicRecallIdentityIssues([hit], subtitles, { start: 0, end: 19 })).toEqual([]);
        expect(topicRecallIdentityIssues([{ ...hit, verdict: 'uncertain' }], subtitles, { start: 0, end: 19 })).not.toEqual([]);
        expect(topicRecallIdentityIssues([{ ...hit, evidenceCueIds: ['G2'] }], subtitles, { start: 0, end: 19 })).not.toEqual([]);
        expect(topicRecallIdentityIssues([hit], subtitles, { start: 0, end: 9 })).not.toEqual([]);
        expect(topicRecallIdentityIssues([{ ...hit, verdict: 'false_match' }], subtitles, { start: 0, end: 19 })).toEqual([]);
    });

    test('only patches the confirmed occurrence with independent in-clip semantic evidence', () => {
        const edit = { original: '随即', replacement: '岁己', evidenceCueIds: ['G2', 'G3'] };
        expect(topicRecallSubtitleEditSupport(edit, subtitles[1], input, inside, [hit])).toBe(true);
        expect(topicRecallSubtitleEditSupport({ ...edit, evidenceCueIds: ['G2'] }, subtitles[1], input, inside, [hit])).toBe(false);
        expect(topicRecallSubtitleEditSupport(edit, subtitles[1], input, inside, [{ ...hit, verdict: 'uncertain' }])).toBe(false);
        expect(topicRecallSubtitleEditSupport(edit, { ...subtitles[3], text: '我随即回复消息' }, input, inside, [hit])).toBe(false);
        expect(topicRecallSubtitleEditSupport(edit, subtitles[1], input, new Set(['G2']), [hit])).toBe(false);
        expect(topicRecallSubtitleEditSupport({ ...edit, original: '别的词' }, subtitles[1], input, inside, [hit])).toBeNull();
    });
});
