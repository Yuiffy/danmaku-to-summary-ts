export {};
const { presentationFor } = require('./stream_activity_presentation');

test('song covers feature the name/date and preserve fragment metadata and the archive prefix', () => {
    const result = presentationFor({ recordedAt: '2026-10-02 20:24:20', streamerName: '岁己', streamTitle: '唱聊',
        events: [{ id: 's1', kind: 'song', name: '泡泡', performance: 'fragment' }] }, 'songs', [{ activityId: 's1', performance: 'fragment', sha256: 'media' }]);
    expect(result).toMatchObject({ version: 2, recordingDate: '2026.10.2', profile: { prefix: '【岁己歌切】' },
        cover: { version: 2, kind: 'songs', subject: '泡泡', date: '2026.10.2', caption: '片段演唱' },
        copy: { title: '泡泡-2026.10.2', coverText: '泡泡\n2026.10.2' }, parts: [{ title: '泡泡-2026.10.2' }] });
    expect(result.copy.description).toContain('片段演唱');
});

test('a multipart song cover lists the actual songs instead of a generic collection label', () => {
    const result = presentationFor({ recordedAt: '2026-10-02 20:24:20', streamerName: '岁己', streamTitle: '唱聊',
        events: [{ id: 's1', kind: 'song', name: "Don't Look Back in Anger" }, { id: 's2', kind: 'song', name: 'Moon River' }] },
        'songs', [{ activityId: 's1', sha256: 'one' }, { activityId: 's2', sha256: 'two' }]);
    expect(result.cover).toMatchObject({ subject: "Don't Look Back in Anger\nMoon River", date: '2026.10.2', caption: '直播演唱 · 共 2 首' });
    expect(result.copy.coverText).not.toContain('歌切');
    expect(result.copy.title).toBe("Don't Look Back in Anger / Moon River-2026.10.2");
    expect(result.tags).toEqual(["Don't Look Back in Anger", 'Moon River', '岁己', '小岁', '歌切', '虚拟主播']);
});

test('song tags follow submitted Ps and reviewed names without borrowing unsubmitted songs', () => {
    const plan = { recordedAt: '2026-10-02', streamerName: '岁己', streamTitle: '唱聊',
        events: [{ id: 's1', kind: 'song', name: null }, { id: 's2', kind: 'song', name: '未收录歌曲' }] };
    const parts = [{ activityId: 's1', sha256: 'one' }];
    const evidence = { items: [{ activityId: 's1', name: '泡泡' }] };
    const result = presentationFor(plan, 'songs', parts, evidence, ['自定义标签', '歌切']);
    expect(result.tags).toEqual(['泡泡', '自定义标签', '歌切']);
    expect(presentationFor(plan, 'songs', parts).tags).not.toContain('待确认歌名');
    expect(presentationFor(plan, 'songs', parts, evidence, ['歌切']).signature).not.toBe(result.signature);
});

test('viewing titles and screenshot covers identify the watched movie rather than a generic category', () => {
    const result = presentationFor({ recordedAt: '2026-10-04 20:38:02', streamerName: '岁己', streamTitle: '唱聊',
        events: [{ id: 'w1', kind: 'watch', name: '雷神3', mediaKind: 'movie' }] }, 'watch',
        [{ activityId: 'w1', sha256: 'one' }, { activityId: 'w1', sha256: 'two' }]);
    expect(result).toMatchObject({ version: 4, recordingDate: '2026.10.4', profile: { prefix: '【岁己同步视听】' },
        cover: { version: 2, kind: 'watch', subject: '《锤子哥3》', date: '2026.10.4' },
        copy: { title: '《锤子哥3》｜2026.10.4', coverText: '《锤子哥3》\n2026.10.4' },
        parts: [{ title: '《锤子哥3》 01/02' }, { title: '《锤子哥3》 02/02' }],
        publicNames: [{ activityId: 'w1', name: '雷神3', publicName: '锤子哥3' }] });
});

test('all public viewing surfaces use aliases while internal identity remains evidenced', () => {
    const plan = { recordedAt: '2026-10-10 21:03:17', streamerName: '岁己', streamTitle: '一起看银河护卫队3',
        events: [{ id: 'w1', kind: 'watch', name: '银河护卫队3' },
            { id: 'w2', kind: 'watch', name: '银河护卫队圣诞特辑（片段）' }] };
    const result = presentationFor(plan, 'watch', [{ activityId: 'w1', sha256: 'one' }, { activityId: 'w2', sha256: 'two' }]);
    expect(JSON.stringify({ copy: result.copy, cover: result.cover, parts: result.parts.map((p: any) => p.title), tags: result.tags })).not.toContain('银河护卫队');
    expect(result.copy.title).toContain('宇宙蹦迪天团圣诞特辑（片段）');
    expect(plan.events[0].name).toBe('银河护卫队3');
});

test('new works require a separate descriptive alias and never fall back to the original title', () => {
    const plan = { recordedAt: '2026-10-10 21:03:17', streamerName: '岁己', streamTitle: '陪你看',
        events: [{ id: 'w1', kind: 'watch', name: '新作品', publicName: '企鹅老板打工记' }] };
    const parts = [{ activityId: 'w1', sha256: 'one' }];
    expect(presentationFor(plan, 'watch', parts).copy.title).toContain('企鹅老板打工记');
    plan.events[0].publicName = '新作品搞笑版';
    expect(presentationFor(plan, 'watch', parts).copy.title).toContain('待确认化名');
});
