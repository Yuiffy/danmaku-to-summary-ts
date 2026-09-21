export {};
const { validateStoryPlan, mapTimelineCues, sourceTimeForOutput, absoluteEditPlan, assertTimeline } = require('./creative_timeline');
const { creativeSettings, assertRenderPlan, buildCreativeFilter } = require('./creative_plan');
const cues = Array.from({ length: 6 }, (_, i) => ({ id: `C${i + 1}`, start: i * 10, end: i * 10 + 4, text: `句${i + 1}` }));
const draft = { keep: [{ fromCue: 'C1', toCue: 'C1', role: 'setup', reason: '起因' },
    { fromCue: 'C4', toCue: 'C4', role: 'reaction', reason: '反差' }, { fromCue: 'C6', toCue: 'C6', role: 'payoff', reason: '回扣' }] };

test('story edit preserves complete approved cues, order and public-copy evidence while removing unrelated dialogue', () => {
    const timeline = validateStoryPlan(draft, cues, 60, [cues[0], cues[5]]);
    expect(timeline.removedSeconds).toBeGreaterThan(45);
    const mapped = mapTimelineCues(cues, timeline);
    expect(mapped.map(c => c.text)).toEqual(['句1', '句4', '句6']);
    expect(sourceTimeForOutput(mapped[1].start, timeline)).toBeCloseTo(30, 3);
    const plan = absoluteEditPlan(timeline, 'identity', { start: 100, end: 160 });
    expect(plan.keep[1].start).toBeCloseTo(129.88);
    expect(plan.removed.length).toBeGreaterThan(1);
    expect(() => validateStoryPlan(draft, cues, 60, [cues[2]])).toThrow('public-copy evidence');
    expect(() => validateStoryPlan({ keep: [...draft.keep].reverse() }, cues, 60)).toThrow('chronological');
    expect(() => assertTimeline({ ...timeline, duration: 60 }, 60)).toThrow('duration');
});

test('render concatenates source ranges before effects and subtitles, with audible normalized accents and separate music ducking', () => {
    const timeline = validateStoryPlan(draft, cues, 60), settings = creativeSettings({ style: 'compact', soundEffects: true, filters: true });
    const assets = { laugh: { kind: 'sound', sampleStart: 2, sampleSeconds: 1.8 }, music: { kind: 'music', sampleSeconds: 10 } };
    const plan = { version: 2, style: 'compact', workflow: 'creative', duration: timeline.duration, timeline,
        effects: [{ start: 1, end: 3, sound: { id: 'laugh', offsetSeconds: 0, levelDb: -3 }, filter: 'monochrome' }],
        music: { id: 'music', levelDb: -27 } };
    expect(() => assertRenderPlan(plan, 60, settings, assets)).not.toThrow();
    expect(() => assertRenderPlan(plan, 55, settings, assets)).toThrow('timeline');
    const graph = buildCreativeFilter(plan, { width: 640, height: 360 }, 8, 68, 'caption.ass', null,
        { '0:sound': { inputIndex: 1, asset: assets.laugh }, music: { inputIndex: 2, asset: assets.music } });
    expect(graph).toContain('concat=n=3:v=1:a=0');
    expect(graph).toContain('concat=n=3:v=0:a=1');
    expect(graph).toContain('loudnorm=I=-16:TP=-2:LRA=7,volume=-3dB');
    expect(graph).toContain('loudnorm=I=-27');
    expect(graph).toContain('[original][ducked][bgm]amix');
    expect(graph.indexOf('concat=')).toBeLessThan(graph.indexOf('subtitles='));
});

test('a 150ms beat gap is accepted at millisecond precision despite binary floating point', () => {
    const settings = creativeSettings({ style: 'compact', filters: true });
    const moments = require('./creative_plan').validateMoments({ moments: [
        { start: 30.131, end: 35.58, reason: '发现问题', speechIds: ['S1'] },
        { start: 35.73, end: 40.886, reason: '随后反应', speechIds: ['S1'] }
    ] }, [{ id: 'S1', start: 30, end: 41 }], 60, settings);
    expect(moments).toHaveLength(2);
    expect(() => assertRenderPlan({ version: 2, workflow: 'creative', duration: 60,
        effects: moments.map(row => ({ ...row, filter: 'monochrome' })) }, 60, settings)).not.toThrow();
});
