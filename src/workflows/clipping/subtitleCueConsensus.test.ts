import { consensusCueEdit } from './subtitleCueConsensus';

const check = (original: string, first: string, second = first, names: string[] = []) => consensusCueEdit(
    { index: 0, id: 'A1', start: 1, end: 20, original }, { id: 'A1', start: 1, end: 20,
        decodes: [first, second].map((text, index) => ({ text, model: String(index), prompted: false, hotwords: [], useItn: false })) }, names);

test('full cue anchors repeated names and retains fillers omitted by an ASR model', () => {
    expect(check('哎信爵活没活着呀啊信爵死了', '嗯浩克活着星爵活着哎星爵活没活着呀星爵死了星爵死球了嗯',
        '嗯浩克活着星爵活着哎星爵活没活着呀我星爵死了星爵死球了嗯'))
        .toMatchObject({ from: '哎信爵活没活着呀啊信爵死了', to: '哎星爵活没活着呀啊星爵死了' });
    expect(check('嗯嗯嗯嗯好客活着新爵活着', '嗯浩克活着星爵活着哎星爵活没活着呀'))
        .toMatchObject({ to: '嗯嗯嗯嗯浩克活着星爵活着' });
    expect(check('哎信爵活没活着呀啊信爵死了', '诶星爵活没活着呀星爵死了星爵死球了',
        '唉星爵活没活着呀啊星爵死了星爵死囚了')).toMatchObject({ to: '哎星爵活没活着呀啊星爵死了' });
});

test('partial character consensus keeps a disputed ending unchanged', () => {
    expect(check('星绝死囚了', '活着哎星爵活没活着呀星爵死了星爵死球了嗯蚁人活着呀',
        '活着哎星爵活没活着呀啊星爵死了星爵死囚了嗯蚁人活着呀'))
        .toMatchObject({ to: '星爵死囚了' });
    expect(check('好客活着新爵活着', '嗯浩克活着星爵活着哎星爵活没活着呀')).toMatchObject({ to: '浩克活着星爵活着' });
});

test('ambiguous spans, weak matches, meaning-bearing edits and protected names are not rewritten', () => {
    expect(check('星绝死囚了', '星爵死球了星爵死球了')).toBeNull();
    expect(check('完全不是这个话题', '这个人昨天在别的地方')).toBeNull();
    expect(check('他今天没去学校', '她今天去去学校')).toBeNull();
    expect(check('岁吉今天在直播', '岁己今天在直播', undefined, ['岁己'])).toBeNull();
    expect(check('星绝死囚了', '星爵死球了', '星绝死囚了')).toBeNull();
});
