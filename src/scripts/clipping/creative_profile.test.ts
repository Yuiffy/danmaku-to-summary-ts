export {};
const { editorialProfile, rotateLaughter } = require('./creative_profile');
const { validateStoryPlan } = require('./creative_timeline');

test.each(['gameplay', 'conversation', 'story', 'tutorial', 'performance', 'mixed'])('content profile supports %s without imposing a comedy template', kind => {
    const p = editorialProfile({ kind, tone: 'neutral', density: 'light', preserveContinuity: kind === 'performance', music: 'none', laughter: false, reason: '完整内容' });
    const cues = [{ id: 'C1', start: 0, end: 80 }, { id: 'C2', start: 80, end: 120 }];
    expect(validateStoryPlan({ keep: [{ fromCue: 'C1', toCue: 'C2', role: kind === 'performance' ? 'performance' : 'explanation', reason: '连贯段落' }] }, cues, 120, [], p).duration).toBe(120);
});

test('serious material rejects canned laughter and performances cannot be internally spliced', () => {
    expect(() => editorialProfile({ kind: 'story', tone: 'serious', density: 'light', preserveContinuity: false, music: 'none', laughter: true, reason: 'test' })).toThrow('cannot inherit');
    const p = editorialProfile({ kind: 'performance', tone: 'neutral', density: 'light', preserveContinuity: true, music: 'none', laughter: false, reason: '乐句完整' });
    const cues = [0, 10, 20].map((start, i) => ({ id: `C${i + 1}`, start, end: start + 5 }));
    expect(() => validateStoryPlan({ keep: [0, 2].map(i => ({ fromCue: cues[i].id, toCue: cues[i].id, role: 'performance', reason: 'test' })) }, cues, 25, [], p)).toThrow('internally spliced');
});

test('laughter rotates real excerpts, not aliases, and is removed when inappropriate', () => {
    const assets = Object.fromEntries(['a', 'b', 'c', 'd'].map((id, i) => [id, { id, kind: 'sound', family: 'laughter', sha256: 'same-recording', sampleStart: i * 5, sampleSeconds: 2 }]));
    assets.alias = { ...assets.a, id: 'alias' };
    const raw = { effects: Array.from({ length: 7 }, (_, i) => ({ momentId: `M${i + 1}`, sound: { id: 'sitcom_laugh', offsetSeconds: 1, levelDb: -2 } })) };
    const settings = { laughAssets: ['a', 'alias', 'b', 'c', 'd'] };
    const result = rotateLaughter(raw, assets, settings);
    const keys = result.effects.map(row => assets[row.sound.id].sampleStart);
    expect(new Set(keys.slice(0, 4)).size).toBe(4);
    expect(keys.every((x, i) => !i || x !== keys[i - 1])).toBe(true);
    expect(rotateLaughter(raw, assets, settings)).toEqual(result);
    expect(rotateLaughter(raw, assets, settings, [], { laughter: false }).effects.every(row => row.sound === null)).toBe(true);
    expect(raw.effects.every(row => row.sound.id === 'sitcom_laugh')).toBe(true);
});
