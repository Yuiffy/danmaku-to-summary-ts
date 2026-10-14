import { competitionGuardEnabled, normalizeCompetitionContext, competitionHitGate, competitionEditBlocked } from './topicCompetition';

const input = () => ({ target: { names: ['小岁', '岁己'] }, subtitles: [
    { id: 'G1', start: 0, end: 10, text: '今天看EDGM比赛' },
    { id: 'G2', start: 10, end: 20, text: '小岁把赵云拉住了', rawRef: 'R1' },
    { id: 'G3', start: 20, end: 35, text: '小岁这次被盾山吓哭了' },
    { id: 'G4', start: 40, end: 55, text: '不看了，聊聊岁己送海獭' }
], audience: [{ id: 'D1', time: 15, text: 'EDGM的小碎打得好' }],
    originalAsrSpans: [{ id: 'R1', rawText: '小碎把赵云拉住了' }],
    competitionGuard: { frames: [{ id: 'F1', time: 15, sha256: 'fixture' }] } });
const refs = { evidenceCueIds: ['G1'], evidenceDanmakuIds: [], evidenceFrameIds: [] };
const player = () => ({ name: '小碎', visibleText: '上海EDGM·小碎', confusableKeywords: ['小岁'],
    evidenceCueIds: [], evidenceDanmakuIds: [], evidenceFrameIds: ['F1'] });
const assessment = () => ({ status: 'spectating', intervals: [{ startCueId: 'G1', endCueId: 'G3', reason: '正在观赛，名单有小碎',
    ...refs, players: [player()] }] });
const hits = () => [
    { start: 10, end: 20, keywords: ['小岁'], verdict: 'mention', reason: '原模型认为是目标' },
    { start: 20, end: 35, keywords: ['小岁'], verdict: 'uncertain', reason: '歧义召回' },
    { start: 40, end: 55, keywords: ['岁己'], verdict: 'mention', reason: '普通聊天' }
];

test('admission uses the source room, so mentioning 十六萤 in another room cannot enable it', () => {
    expect(competitionGuardEnabled({ roomId: '1741667419' })).toBe(true);
    expect(competitionGuardEnabled({ roomId: '25788785' })).toBe(false);
    expect(competitionGuardEnabled({})).toBe(false);
});

test('roster evidence suppresses repeated corrected hits only in the evidenced watching interval', () => {
    const source = input(), context = normalizeCompetitionContext(assessment(), source);
    const result = competitionHitGate(hits(), context, source);
    expect(result.map(hit => hit.verdict)).toEqual(['false_match', 'false_match', 'mention']);
    expect(result[0].reason).toContain('小碎');
    expect(result[2]).toEqual(hits()[2]);
    expect(competitionEditBlocked({ original: '小碎', replacement: '小岁' }, source.subtitles[1], context, source)).toBe(true);
    expect(competitionEditBlocked({ original: '小碎', replacement: '小岁' }, source.subtitles[3], context, source)).toBe(false);
});

test.each(['raw', 'audience'])('a literal roster name may come from %s text without visual input', kind => {
    const source = input(); source.competitionGuard.frames = [];
    const raw = assessment(); raw.intervals[0].players[0] = { ...player(), visibleText: '', evidenceFrameIds: [],
        evidenceCueIds: kind === 'raw' ? ['G2'] : [], evidenceDanmakuIds: kind === 'audience' ? ['D1'] : [] };
    expect(normalizeCompetitionContext(raw, source).intervals[0].players[0].name).toBe('小碎');
});

test('ordinary games/chat and uncertain activity do not suppress keywords; mixed keywords retain their other target', () => {
    for (const status of ['other', 'uncertain']) {
        const source = input(), context = normalizeCompetitionContext({ status, intervals: [] }, source);
        expect(competitionHitGate(hits(), context, source)).toEqual(hits());
    }
    const source = input(), context = normalizeCompetitionContext(assessment(), source);
    expect(competitionHitGate([{ ...hits()[0], keywords: ['小岁', '岁己'] }], context, source)[0])
        .toMatchObject({ verdict: 'mention', keywords: ['岁己'] });
});

test.each(['missing', 'unknown_frame', 'outside_interval', 'invented_name', 'unknown_keyword', 'audience_activity', 'not_spectating'])(
    'invalid suppression evidence is rejected: %s', kind => {
        const raw = assessment(), source = input();
        if (kind === 'unknown_frame') raw.intervals[0].players[0].evidenceFrameIds = ['F99'];
        if (kind === 'outside_interval') source.competitionGuard.frames[0].time = 45;
        if (kind === 'invented_name') raw.intervals[0].players[0] = { ...player(), visibleText: '', evidenceFrameIds: [], evidenceCueIds: ['G1'] };
        if (kind === 'unknown_keyword') raw.intervals[0].players[0].confusableKeywords = ['别的目标'];
        if (kind === 'audience_activity') Object.assign(raw.intervals[0], { evidenceCueIds: [], evidenceDanmakuIds: ['D1'] });
        if (kind === 'not_spectating') raw.status = 'other';
        expect(() => normalizeCompetitionContext(kind === 'missing' ? undefined : raw, source)).toThrow();
    });
