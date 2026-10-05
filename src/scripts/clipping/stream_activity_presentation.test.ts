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
});

test('viewing titles and screenshot covers identify the watched movie rather than a generic category', () => {
    const result = presentationFor({ recordedAt: '2026-10-04 20:38:02', streamerName: '岁己', streamTitle: '唱聊',
        events: [{ id: 'w1', kind: 'watch', name: '雷神3', mediaKind: 'movie' }] }, 'watch',
        [{ activityId: 'w1', sha256: 'one' }, { activityId: 'w1', sha256: 'two' }]);
    expect(result).toMatchObject({ version: 3, recordingDate: '2026.10.4', profile: { prefix: '【岁己同步视听】' },
        cover: { version: 2, kind: 'watch', subject: '《雷神3》', date: '2026.10.4' },
        copy: { title: '《雷神3》｜2026.10.4', coverText: '《雷神3》\n2026.10.4' },
        parts: [{ title: '《雷神3》 01/02' }, { title: '《雷神3》 02/02' }] });
});
