import { CollabSession, CollabPlan, compileCollab, mapPrimary, mapLocal, validateSession } from './collabPolicy';
import { suggestSync } from './collabSync';
const session = (): CollabSession => ({ version: 1, primaryId: 'sui', sources: [
    { id: 'sui', name: '岁己', roomId: '1', mediaPath: 'sui.mp4', sync: [], protectedRegions: [[0, 0, .3, .1]] },
    { id: 'peer', name: '队友', roomId: '2', mediaPath: 'peer.mp4', protectedRegions: [],
        sync: [{ primary: { start: 10, end: 60 }, local: { start: 20, end: 70.1 }, basis: 'shared_game', reviewNote: '两个动作帧已对照' }] }
] });
const media = { sui: { duration: 100, width: 1280, height: 720, audio: true }, peer: { duration: 110, width: 1920, height: 1080, audio: true } };
const evidence = [{ id: 'sui:S1', sourceId: 'sui', kind: 'subtitle' as const, start: 11, end: 12, primaryStart: 11, primaryEnd: 12, text: '别急' },
    { id: 'peer:D1', sourceId: 'peer', kind: 'danmaku' as const, start: 23, end: 23.001, primaryStart: 12.994, primaryEnd: 12.995, text: '哈哈' }];
const plan = (): CollabPlan => ({ version: 1, dossierSha256: 'hash', shots: [{ mode: 'primary', sourceId: 'sui', start: 10, end: 15,
    reason: '铺垫和反应', evidenceIds: ['sui:S1'], overlays: [{ sourceId: 'peer', kind: 'chat', start: 12, end: 14,
        crop: [.8, 0, .2, .7], placement: [.65, .2, .3, .4], reviewNote: '检查三帧和游戏路线' }] }] });
test('peer windows map drift but never extrapolate or cross a gap', () => {
    const source = session().sources[1];
    expect(mapPrimary(source, { start: 12, end: 14 }).local.start).toBeCloseTo(22.004);
    expect(() => mapPrimary(source, { start: 9, end: 12 })).toThrow(/coverage/);
    source.sync.push({ primary: { start: 70, end: 90 }, local: { start: 80, end: 100 }, basis: 'manual', reviewNote: '重连后校验' });
    expect(() => mapPrimary(source, { start: 59, end: 71 })).toThrow(/coverage/);
});
test('all subtitles come from the single chosen audio source, peer chat remains evidence', () => {
    const timeline = compileCollab(session(), plan(), media, { sui: [{ start: 11, end: 12, text: '别急' }], peer: [{ start: 22, end: 23, text: '重复连麦声音' }] }, evidence);
    expect(timeline.duration).toBe(5); expect(timeline.cues).toEqual([{ start: 1, end: 2, text: '别急' }]);
    expect(timeline.shots[0].mappedOverlays[0].rate).toBeCloseTo(1.002);
});
test('local cues at a reconnect boundary use a single complete sync window', () => {
    const source = session().sources[1];
    source.sync = [{ primary: { start: 0, end: 10 }, local: { start: 0, end: 10 }, basis: 'manual', reviewNote: '第一段' },
        { primary: { start: 20, end: 30 }, local: { start: 10, end: 20 }, basis: 'manual', reviewNote: '断流后接续' }];
    expect(mapLocal(source, { start: 10, end: 11 }, 'sui')).toEqual({ start: 20, end: 21 });
    expect(mapLocal(source, { start: 9, end: 11 }, 'sui')).toBeNull();
});
test.each(['unreviewed', 'gap', 'hud', 'subtitles', 'overlap', 'sentence', 'evidence', 'order', 'solo'])('rejects unsafe %s plan', kind => {
    const s = session(), p = plan();
    const speech = { sui: [{ start: 11, end: 12, text: '别急' }] };
    if (kind === 'unreviewed') s.sources[1].sync[0].reviewNote = '';
    if (kind === 'gap') p.shots[0].overlays[0].start = 9;
    if (kind === 'hud') p.shots[0].overlays[0].placement = [0, 0, .2, .2];
    if (kind === 'subtitles') p.shots[0].overlays[0].placement = [.6, .7, .3, .2];
    if (kind === 'overlap') p.shots[0].overlays.push({ ...p.shots[0].overlays[0] });
    if (kind === 'sentence') p.shots[0].start = 11.5;
    if (kind === 'evidence') p.shots[0].evidenceIds = ['missing'];
    if (kind === 'order') p.shots.push({ ...p.shots[0], overlays: [] });
    if (kind === 'solo') p.shots[0].mode = 'solo';
    expect(() => compileCollab(s, p, media, speech, evidence)).toThrow();
});
test('a solo cut uses local recording time and only that source transcript', () => {
    const p = plan();
    p.shots.push({ mode: 'solo', sourceId: 'peer', start: 23, end: 25, reason: '独有闭麦吐槽，画面注明', evidenceIds: ['peer:D1'], overlays: [] });
    const result = compileCollab(session(), p, media, { peer: [{ start: 23, end: 24, text: '只在这边说的' }] }, evidence);
    expect(result.cues).toEqual([{ start: 5, end: 6, text: '只在这边说的' }]);
});
test('session rejects overlapping anchors and excessive drift', () => {
    const s = session(); s.sources[1].sync[0].local.end = 80;
    expect(() => validateSession(s, media)).toThrow(/drift/);
    const t = session(); t.sources[1].sync.push(t.sources[1].sync[0]);
    expect(() => validateSession(t, media)).toThrow(/overlap/);
});
test('bounded envelope search finds an offset and rejects silence, repeated beats and search edges', () => {
    let seed = 8;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const reference = Array.from({ length: 500 }, random), noise = Array.from({ length: 1000 }, random);
    noise.splice(200, reference.length, ...reference.map(x => x * .7 + .2));
    const found = suggestSync(reference, noise);
    expect(found.status).toBe('candidate'); expect(found).toMatchObject({ offsetSeconds: 4, reviewed: false });
    expect(suggestSync(Array(500).fill(-8), Array(1000).fill(-8)).status).toBe('ambiguous');
    expect(suggestSync(reference, [...reference, ...reference, ...reference]).status).toBe('ambiguous');
    expect(suggestSync(reference, [...reference, ...noise]).status).toBe('ambiguous');
});
