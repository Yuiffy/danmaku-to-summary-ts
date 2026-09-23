export {};
const { creativeSettings, speechForCreative, validateMoments, validateCreativePlan, assertRenderPlan,
    stickerAss, buildCreativeFilter } = require('./creative_plan');
const limits = creativeSettings({ soundEffects: true });
const speech = speechForCreative([{ start: 100, end: 110, text: '等一下，怎么回事？' }], { start: 100, end: 160 });
const moments = () => validateMoments({ moments: [{ start: 3, end: 5, speechIds: ['S1'], reason: '疑惑反应' }] }, speech, 60, limits);
const effect = () => ({ momentId: 'M1', frameIds: ['M1F0', 'M1F1', 'M1F2'], visualConfirmed: true, reason: '表情清楚',
    zoom: { scale: 1.35, x: .8, y: .5, target: 'avatar', safeToCrop: true },
    sticker: { id: 'question', x: .2, y: .3, motion: 'pop', clearOfSubject: true }, sound: 'pop' });

test('creative timestamps use local seconds, preserve source speech ids, and burn captions after all visual effects', () => {
    expect(speech[0]).toEqual({ id: 'S1', start: 0, end: 10, text: '等一下，怎么回事？' });
    const plan = validateCreativePlan({ effects: [effect()] }, moments(), 'source', 60, limits);
    assertRenderPlan(plan, 60, limits);
    const graph = buildCreativeFilter(plan, { width: 640, height: 360 }, 8, 68, 'D:/clip.burn.ass', 'D:/effects.ass');
    expect(graph).toContain('trim=start=8:end=68');
    expect(graph.indexOf('overlay=')).toBeLessThan(graph.indexOf('subtitles='));
    expect(graph.indexOf("ass='")).toBeLessThan(graph.indexOf('subtitles='));
    expect(graph).toContain('duration=first');
    expect(graph).toContain('normalize=0');
    expect(stickerAss(plan, 640, 360)).toContain('0:00:03.00,0:00:05.00');
});

test.each([
    { start: -1 }, { end: 90 }, { speechIds: ['S999'] }, { speechIds: [] }, { end: 3.1 }
])('rejects unsupported moment %j', change => {
    expect(() => validateMoments({ moments: [{ ...moments()[0], ...change }] }, speech, 60, limits)).toThrow();
});

test.each([
    { frameIds: ['M1F0', 'M1F0', 'M1F0'] }, { visualConfirmed: false },
    { zoom: { scale: 4, x: .5, y: .5, target: 'avatar', safeToCrop: true } },
    { sticker: { id: 'external.png', x: .5, y: .2, motion: 'pop', clearOfSubject: true } },
    { sticker: { id: 'question', x: .5, y: .9, motion: 'pop', clearOfSubject: true } },
    { sound: 'movie-meme.mp3' }, { filter: 'monochrome' }
])('rejects unsupported or unsafe visual operation %j', change => {
    expect(() => validateCreativePlan({ effects: [{ ...effect(), ...change }] }, moments(), 'source', 60, limits)).toThrow();
});

test('limits effect density and validates the closed vocabulary again at the render boundary', () => {
    expect(() => validateMoments({ moments: [moments()[0], { ...moments()[0], start: 6, end: 8 }] }, speech, 60, limits)).toThrow();
    const plan = validateCreativePlan({ effects: [effect()] }, moments(), 'source', 60, limits);
    plan.effects[0].zoom.x = '0;movie=secret';
    expect(() => assertRenderPlan(plan, 60, limits)).toThrow();
});

test('repair diagnostics identify every unsafe crop and allow the remaining effects without approving that crop', () => {
    const settings = creativeSettings({ soundEffects: true, filters: true, variety: true });
    const nodes = ['M1', 'M4', 'M5'].map((id, index) => ({ ...moments()[0], id, start: 3 + index * 10, end: 5 + index * 10 }));
    const effects = nodes.map((node, index) => ({ ...effect(), momentId: node.id,
        frameIds: [0, 1, 2].map(i => `${node.id}F${i}`),
        zoom: { scale: 1.8, x: .77, y: .72, target: 'avatar', safeToCrop: index === 0 },
        sticker: null, sound: null, filter: 'monochrome' }));
    let message = '';
    try { validateCreativePlan({ effects }, nodes, 'source', 60, settings); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain('M4.zoom.safeToCrop');
    expect(message).toContain('M5.zoom.safeToCrop');
    expect(message).not.toContain('M1.zoom');
    expect(message).toContain('zoom=null');
    const repaired = effects.map((row, index) => index ? { ...row, zoom: null } : row);
    const plan = validateCreativePlan({ effects: repaired }, nodes, 'source', 60, settings);
    expect(plan.effects).toHaveLength(3);
    expect(plan.effects[0].zoom.scale).toBe(1.8);
    expect(plan.effects.slice(1).every(row => !row.zoom && row.filter === 'monochrome')).toBe(true);
});

test('a repaired empty moment is omitted while visual evidence and invalid operations remain checked', () => {
    const nodes = [moments()[0], { ...moments()[0], id: 'M2', start: 14, end: 16 }];
    const rows = [{ ...effect(), zoom: null, sticker: null, sound: null },
        { ...effect(), momentId: 'M2', frameIds: ['M2F0', 'M2F1', 'M2F2'] }];
    const plan = validateCreativePlan({ effects: rows }, nodes, 'source', 60, limits);
    expect(plan.effects).toHaveLength(1);
    expect(plan.effects[0].sound).toBe('pop');
    expect(() => validateCreativePlan({ effects: [{ ...rows[0], visualConfirmed: false }] }, moments(), 'source', 60, limits)).toThrow('visual evidence');
    expect(() => validateCreativePlan({ effects: [{ ...rows[0], sticker: { id: 'missing', x: .2, y: .2,
        motion: 'pop', clearOfSubject: true } }] }, moments(), 'source', 60, limits)).toThrow('sticker');
});

test('known filter id object is normalized to the closed string vocabulary', () => {
    const settings = creativeSettings({ filters: true, soundEffects: true });
    const row = { ...effect(), filter: { id: 'monochrome' } };
    expect(validateCreativePlan({ effects: [row] }, moments(), 'source', 60, settings).effects[0].filter).toBe('monochrome');
    expect(() => validateCreativePlan({ effects: [{ ...row, filter: { id: 'other' } }] }, moments(), 'source', 60, settings)).toThrow('M1.filter');
    expect(() => validateCreativePlan({ effects: [{ ...row, filter: { id: 'monochrome', args: 'unsafe' } }] }, moments(), 'source', 60, settings)).toThrow('M1.filter');
    expect(() => validateCreativePlan({ effects: [{ ...row, filter: { id: 'monochrome', offsetSeconds: 1.6, durationSeconds: .5 } }] },
        moments(), 'source', 60, settings)).toThrow('M1.filter');
});

test('compact sound needs enough remaining playback time at the end of a clip', () => {
    const settings = creativeSettings({ style: 'compact', soundEffects: true });
    const node = { id: 'M1', start: 8, end: 9.8 };
    const row = { ...effect(), sound: { id: 'laugh', offsetSeconds: 1.5, levelDb: -1 }, zoom: null };
    const assets = { laugh: { kind: 'sound', sampleSeconds: 2.6 } };
    const trimmed = validateCreativePlan({ effects: [row] }, [node], 'source', 10, settings, assets);
    expect(trimmed.effects[0].sound).toBeUndefined();
    expect(trimmed.audioAdjustments).toEqual([{ momentId: 'M1', sound: 'laugh', reason: 'avoid_truncated_end_sound' }]);
    expect(validateCreativePlan({ effects: [{ ...row, sound: { ...row.sound, offsetSeconds: .6 } }] },
        [node], 'source', 10, settings, assets).effects[0].sound.offsetSeconds).toBe(.6);
    const late = { ...row, sound: { ...row.sound, offsetSeconds: 2, levelDb: -2 } };
    const omitted = validateCreativePlan({ effects: [late] }, [node], 'source', 10, settings, assets);
    expect(omitted.effects).toHaveLength(1);
    expect(omitted.effects[0].sound).toBeUndefined();
    expect(omitted.audioAdjustments).toEqual([{ momentId: 'M1', sound: 'laugh', reason: 'avoid_truncated_end_sound' }]);
});

test('compact closeups require a real target box inside the crop rather than an arbitrary gameplay center', () => {
    const settings = creativeSettings({ style: 'compact', soundEffects: true });
    const row = { ...effect(), zoom: { scale: 4, x: .8, y: .9, target: 'avatar', safeToCrop: true,
        targetBox: { x: .76, y: .81, width: .1, height: .18 } } };
    expect(validateCreativePlan({ effects: [row] }, moments(), 'source', 60, settings).effects[0].zoom.target).toBe('avatar');
    row.zoom.x = .5;
    expect(() => validateCreativePlan({ effects: [row] }, moments(), 'source', 60, settings)).toThrow('crop must contain');
});

test('compact reactions keep laughter instead of stacking a short pop, and reserve subtitle space below the face', () => {
    const settings = creativeSettings({ style: 'compact', soundEffects: true, filters: true });
    const nodes = [{ id: 'M1', start: 1, end: 2 }, { id: 'M2', start: 2.2, end: 3 }];
    const rows = nodes.map((n, i) => ({ ...effect(), momentId: n.id, frameIds: [0, 1, 2].map(k => `${n.id}F${k}`),
        zoom: { scale: 2.8, x: .76, y: .78, target: 'avatar', safeToCrop: true, targetBox: { x: .68, y: .64, width: .17, height: .27 } },
        sound: { id: i ? 'pop' : 'laugh', offsetSeconds: .2, levelDb: i ? -7 : -2 } }));
    const plan = validateCreativePlan({ effects: rows }, nodes, 'source', 60, settings, { laugh: { kind: 'sound', sampleSeconds: 1.8 } });
    expect(plan.effects[0].sound.id).toBe('laugh'); expect(plan.effects[1].sound).toBeUndefined();
    expect(plan.audioAdjustments).toEqual([{ momentId: 'M2', sound: 'pop', reason: 'avoid_overlapping_reaction_sounds' }]);
    // Check the camera without sound bindings; this path specifically protects the mouth from captions.
    const graph = buildCreativeFilter({ ...plan, effects: plan.effects.map(({ sound, ...row }) => row) },
        { width: 640, height: 360 }, 0, 60, 'captions.ass', null);
    expect(graph).toContain('scale=562:316,pad=640:360:39:0');
});
