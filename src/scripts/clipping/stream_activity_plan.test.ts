export {};
const p = require('./stream_activity_plan');
const c = p.getActivityConfig({});
const event = (changes = {}) => ({ kind: 'song', start: 100, end: 400, name: '测试曲', performance: 'full',
    startObserved: true, endObserved: true, evidenceIds: ['T1'], titleEvidenceIds: ['T1'], note: '', windows: [1], ...changes });

test('only explicitly enabled rooms run the new workflow, independently of highlights', () => {
    expect(p.activityEnabled({}, '25788785')).toBe(false);
    expect(p.activityEnabled({ streamActivityClips: { enabled: true } }, '25788785')).toBe(true);
    expect(p.activityEnabled({ streamActivityClips: { enabled: true } }, '22470216')).toBe(false);
    expect(() => p.getActivityConfig({ streamActivityClips: { roomIds: [] } })).toThrow('allowlist');
});
test.each([10, 1500, 1801, 3001, 3601, 5401, 9000])('watch parts cover %s seconds exactly, in order and within 30 minutes', duration => {
    const parts = p.splitWatch(20, 20 + duration);
    expect(parts[0].start).toBe(20); expect(parts.at(-1).end).toBe(20 + duration);
    expect(parts.reduce((n, row) => n + row.duration, 0)).toBeCloseTo(duration, 6);
    parts.forEach((part, i) => {
        expect(part.duration).toBeLessThanOrEqual(1800);
        if (i) expect(part.start).toBe(parts[i - 1].end);
    });
    if (duration >= 2400) expect(Math.min(...parts.map(row => row.duration))).toBeGreaterThanOrEqual(1200);
});
test('song duplicates from detector overlap merge, but distinct repeats and short fragments remain', () => {
    const events = p.mergeEvents([event(), event({ start: 101, end: 402, windows: [2] }),
        event({ start: 500, end: 800 }), event({ start: 900, end: 913, name: null, performance: 'fragment' })]);
    expect(events).toHaveLength(3); expect(events[0]).toMatchObject({ start: 100, end: 402, windows: [1, 2] });
    const parts = p.buildParts(events, 1000, c);
    expect(parts.songs).toHaveLength(3);
    expect(parts.songs[0]).toMatchObject({ start: 98, end: 404 });
    expect(parts.songs[2].title).toContain('片段演唱');
    expect(p.songRecord({ status: 'planned', events, parts }).songs.map(row => row.name)).toEqual(['测试曲', '测试曲', null]);
});
test('an ongoing movie is joined across windows and retains its observed outer boundaries', () => {
    const events = p.mergeEvents([
        event({ kind: 'watch', start: 1200, end: 1980, endObserved: false }),
        event({ kind: 'watch', start: 1620, end: 3780, startObserved: false, endObserved: false, windows: [2] }),
        event({ kind: 'watch', start: 3420, end: 6000, startObserved: false, windows: [3] })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ start: 1200, end: 6000, startObserved: true, endObserved: true, reviewIssues: [] });
    expect(p.buildParts(events, 6100, c).watch.map(row => row.duration)).toEqual([1200, 1200, 1200, 1200]);
});
test('a brief open watch interval joins a later observed start without duplicating playback', () => {
    const watch = (changes = {}) => event({ kind: 'watch', mediaKind: 'movie', name: '测试电影', ...changes });
    const events = p.mergeEvents([
        watch({ start: 5393.72, end: 5580, startObserved: false, endObserved: false }),
        watch({ start: 5510.44, end: 7380, startObserved: true, endObserved: false, windows: [2] }),
        watch({ start: 7020, end: 12388, startObserved: false, windows: [3] }),
        watch({ start: 13000, end: 14000 }),
        watch({ start: 14200, end: 15000, name: '另一部电影' })]);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ start: 5393.72, end: 12388, startObserved: false, endObserved: true, windows: [1, 2, 3] });
    const parts = p.buildParts(events, 15100, c).watch.filter(row => row.activityId === events[0].id);
    expect(parts.reduce((n, row) => n + row.duration, 0)).toBeCloseTo(12388 - 5393.72, 6);
});
test('unknown song titles stay in the setlist, and unsupported titles or unseen citations cannot become facts', () => {
    const rows = p.evidenceRows([{ start: 100, end: 400, text: '唱一下测试曲' }], [{ time: 102, text: '好听' }]);
    const window = { start: 0, end: 600, from: 0, to: 600, rows };
    expect(p.parseEvents({ events: [event()] }, window, 600)[0].name).toBe('测试曲');
    expect(p.parseEvents({ events: [event({ name: '另一个歌名' })] }, window, 600)[0].name).toBeNull();
    const lyricWindow = { ...window, rows: p.evidenceRows([{ start: 100, end: 400, text: '想吹个泡泡，点住你某个回眸' }]) };
    expect(p.parseEvents({ events: [event({ name: '泡泡' })] }, lyricWindow, 600)[0].name).toBeNull();
    expect(() => p.parseEvents({ events: [event({ evidenceIds: ['D999'] })] }, window, 600)).toThrow('unseen');
    expect(() => p.parseEvents({ events: [event({ start: -1 })] }, window, 600)).toThrow('bounds');
    expect(() => p.parseEvents({ events: [event({ endObserved: undefined })] }, window, 600)).toThrow('boundary');
});
test('dense input splits rather than truncating and still inspects every recording second', () => {
    const rows = p.evidenceRows(Array.from({ length: 80 }, (_, i) => ({ start: i * 10, end: i * 10 + 5, text: '文'.repeat(100) })));
    const windows = p.detectionWindows(rows, 800, { ...c, chunkSeconds: 800, contextSeconds: 1, maxEvidenceChars: 2500 });
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0].start).toBe(0); expect(windows.at(-1).end).toBe(800);
    expect(new Set(windows.flatMap(w => w.rows.map(row => row.id))).size).toBe(rows.length);
    windows.forEach((w, i) => { if (i) expect(w.start).toBe(windows[i - 1].end); });
});
test('context-only events are left to their own inspected core rather than failing this window', () => {
    const rows = p.evidenceRows([{ start: 100, end: 400, text: '唱一下测试曲' }]);
    expect(p.parseEvents({ events: [event()] }, { start: 500, end: 1000, from: 320, to: 1000, rows }, 1000)).toEqual([]);
});
test('citation repair identifies the exact invalid prefix and supplied source examples', () => {
    const window = { start: 7200, end: 8100, from: 7020, to: 8280, rows: [
        { id: 'T3056', start: 7100, end: 7102, text: '电影对白' },
        { id: 'T3727', start: 8278, end: 8280, text: '继续观看' },
        { id: 'D3818', start: 8090, end: 8090, text: '测试电影' }] };
    expect(() => p.parseEvents({ events: [event({ kind: 'watch', mediaKind: 'movie', start: 7020, end: 8280,
        evidenceIds: ['T3056', 'T3818', 'T3871'] })] }, window, 9000))
        .toThrow('unseen source citations: T3818, T3871. T examples: T3056, T3727; D examples: D3818');
});
