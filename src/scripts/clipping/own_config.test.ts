export {};
const { getOwnStreamClipsConfig } = require('./own_config');
const { selectPublication } = require('./publication_policy');

const now = Date.parse('2026-10-24T12:00:00+08:00');
const root = { ownStreamClips: { enabled: true, roomIds: ['regular'], maxClips: 50,
    enhancements: { enabled: true, roomIds: ['regular'], workflow: 'creative', creative: { style: 'compact' } },
    selectionPolicy: { excludedCategories: ['global restriction'], roomOverrides: { event: { excludedCategories: ['room restriction'] } } },
    campaigns: [{ id: 'fuya', requiredGames: ['芙娅之魂'], enabled: true, roomIds: ['event'], startsAt: '2026-10-22T00:00:00+08:00', endsAt: '2026-11-06T00:00:00+08:00',
        settings: { maxClips: 2, ai: { fallbackToLocalRules: false },
            enhancements: { selectionMode: 'all_eligible' },
            publicationPolicy: { mode: 'curated', minScore: 88, maxStandalone: 2, standoutScore: 100 },
            selectionPolicy: { excludedCategories: ['unrelated game/chat/song'], priorityCategories: ['clear independent hook'] } } }] } };

test('campaign settings apply only to the matching room and preserve nested production settings and exclusions', () => {
    const event = getOwnStreamClipsConfig(root, 'event', '2026-10-24 12:00:00', now);
    expect(event).toMatchObject({ enabled: true, maxClips: 2, ai: { fallbackToLocalRules: false },
        enhancements: { workflow: 'creative', creative: { style: 'compact' }, selectionMode: 'all_eligible' } });
    expect(event.roomIds).toContain('event');
    expect(event.campaignContentGate).toEqual({ id: 'fuya', requiredGames: ['芙娅之魂'] });
    expect(getOwnStreamClipsConfig(root, 'regular', undefined, now).campaignContentGate).toBeUndefined();
    expect(event.enhancements.roomIds).toContain('event');
    expect(event.selectionPolicy.excludedCategories).toEqual(['global restriction', 'unrelated game/chat/song', 'room restriction']);
    expect(getOwnStreamClipsConfig(root, 'regular', undefined, now)).toMatchObject({ maxClips: 50 });
    expect(root.ownStreamClips.roomIds).toEqual(['regular']);
});

test.each([
    ['2026-10-21 23:59:59', now], [null, now],
    ['2026-10-24 12:00:00', Date.parse('2026-11-06T00:00:00+08:00')],
    ['2026-10-24 12:00:00', Date.parse('2026-10-21T00:00:00+08:00')]
])('campaign rejects old/unknown sources and stops at its exclusive deadline (%s)', (source, time) => {
    expect(getOwnStreamClipsConfig(root, 'event', source, time).enabled).toBe(false);
});

test('campaign publication uses model scores and keeps low scores and heat-only candidates out of production', () => {
    const policy = getOwnStreamClipsConfig(root, 'event', undefined, now).publicationPolicy;
    const clips = [91, 87].map((score, i) => ({ start: i * 60, end: i * 60 + 30, score, selectionSource: 'model_global_rerank' }));
    clips.push({ start: 120, end: 150, score: 100, selectionSource: 'danmaku_heat' });
    expect(selectPublication(clips, policy, 'event').clips.map((clip: any) => clip.score)).toEqual([91]);
});
test('reviewed game aliases stay scoped to their campaign rooms', () => {
    const settings = JSON.parse(JSON.stringify(root));
    settings.ownStreamClips.campaigns[0].gameAliases = { '普雅之魂': '芙娅之魂' };
    expect(getOwnStreamClipsConfig(settings, 'event', undefined, now).campaignContentGate.gameAliases)
        .toEqual({ '普雅之魂': '芙娅之魂' });
    expect(getOwnStreamClipsConfig(settings, 'regular', undefined, now).campaignContentGate).toBeUndefined();
});

test('campaign publication requires its separate explicit room policy and never widens daily authorization', () => {
    const config = JSON.parse(JSON.stringify(root));
    config.ownStreamClips.automaticPublication = { mode: 'auto', roomIds: ['regular'], policyVersion: 'own-stream-v1' };
    expect(getOwnStreamClipsConfig(config, 'event', undefined, now).automaticPublication.roomIds).toEqual(['regular']);
    config.ownStreamClips.campaigns[0].settings.automaticPublication = {
        mode: 'auto', roomIds: ['event'], policyVersion: 'own-stream-v1', activatedAt: '2026-10-23T09:00:00Z', authorizationNote: 'explicit campaign authority'
    };
    expect(getOwnStreamClipsConfig(config, 'event', undefined, now).automaticPublication.roomIds).toEqual(['event']);
    expect(getOwnStreamClipsConfig(config, 'regular', undefined, now).automaticPublication.roomIds).toEqual(['regular']);
    expect(getOwnStreamClipsConfig(config, 'event', undefined, Date.parse('2026-11-07T00:00:00Z')).automaticPublication.roomIds).toEqual(['regular']);
});

test('human plan replay can restore an in-period deferred candidate after expiry without admitting out-of-period sources', () => {
    const after = Date.parse('2026-11-07T00:00:00+08:00');
    expect(getOwnStreamClipsConfig(root, 'event', '2026-10-24 12:00:00', after, true).enabled).toBe(true);
    expect(getOwnStreamClipsConfig(root, 'event', '2026-11-07 12:00:00', after, true).enabled).toBe(false);
    const { report } = selectPublication([{ start: 0, end: 30, score: 70, selectionSource: 'model_global_rerank', title: 'Worth human review' }],
        getOwnStreamClipsConfig(root, 'event', undefined, now).publicationPolicy, 'event');
    expect(report.renderedCount).toBe(0);
    expect(report.deferred).toMatchObject([{ title: 'Worth human review', publication: { reason: 'below_score' } }]);
});
