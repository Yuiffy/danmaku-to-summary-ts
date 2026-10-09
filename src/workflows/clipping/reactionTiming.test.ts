import { planLaughterTiming, reactionPieces, reactionSourceTime, reactionOutputTime } from './reactionTiming';

const assets = { laugh: { family: 'laughter', sampleSeconds: 2.6 } };
const profile = { tone: 'comic', laughter: true, preserveContinuity: false };
const speech = [{ id: 'S1', start: 2, end: 6.3, text: '冷若冰山' },
    { id: 'S2', start: 6.3, end: 8.13, text: '嘴角上扬三个像素点' },
    { id: 'S3', start: 8.13, end: 9.95, text: '了' },
    { id: 'S4', start: 9.95, end: 10.65, text: '谢谢' },
    { id: 'S5', start: 10.87, end: 15, text: '下一句' }];
const plan = { duration: 20, timeline: { version: 1, sourceDuration: 25, duration: 20,
    removedSeconds: 5, keep: [{ start: 0, end: 15 }, { start: 20, end: 25 }] },
effects: [{ id: 'M1', start: 2, end: 9.95, speechIds: ['S1', 'S2', 'S3', 'S4'], zoom: { scale: 1.35 },
    sound: { id: 'laugh', offsetSeconds: 6.15, levelDb: -1 } },
    { id: 'M2', start: 11, end: 13, speechIds: ['S5'], sound: { id: 'pop', offsetSeconds: .2 } }] };

test('split final syllable and closing thanks finish before laughter; a short pause protects the next reply', () => {
    const result = planLaughterTiming(plan, speech, assets, profile);
    const first = result.plan.effects[0], sound = first.sound as any;
    expect(first.start + sound.offsetSeconds).toBeCloseTo(10.61, 3);
    expect(sound.afterCueId).toBe('S4');
    expect(sound.durationSeconds).toBeCloseTo(1.24, 3);
    expect(result.plan.timeline!.addedSeconds).toBeCloseTo(.98, 3);
    expect(result.plan.duration).toBeCloseTo(20.98, 3);
    expect(result.plan.timeline!.removedSeconds).toBe(5);
    expect(first.start + sound.offsetSeconds + sound.durationSeconds).toBeCloseTo(10.87 + .98, 3);
    expect(result.plan.effects[1].start).toBeCloseTo(11.98, 3);
    expect((result.plan.effects[1].sound as any).offsetSeconds).toBe(.2);
    expect(plan.effects[0].sound.offsetSeconds).toBe(6.15);
});

test('long natural quiet keeps the actual laugh excerpt and adds no freeze', () => {
    const result = planLaughterTiming(plan, speech.slice(0, 4).concat({ ...speech[4], start: 14 }), assets, profile);
    expect(result.insertions).toEqual([]);
    expect((result.plan.effects[0].sound as any).durationSeconds).toBe(2.6);
});

test.each([{ tone: 'neutral' }, { preserveContinuity: true }, { laughter: false }])('continuous or unsuitable material never gets inserted reaction beats: %j', preference => {
    const result = planLaughterTiming(plan, speech, assets, { ...profile, ...preference });
    expect(result.insertions).toEqual([]);
    expect(result.plan.effects[0].sound).toBeUndefined();
});

test('missing citations stop timing repair rather than inventing a punchline boundary', () => {
    expect(() => planLaughterTiming(plan, speech.filter(c => c.id !== 'S3'), assets, profile)).toThrow('retained speech');
});

test('paused time maps to one source frame; cue ending and following cue onset are distinct', () => {
    const timeline = planLaughterTiming(plan, speech, assets, profile).plan.timeline!;
    expect(reactionPieces(timeline).map(p => [p.start, p.end, p.hold])).toEqual([[0, 10.65, .98], [10.65, 15, 0], [20, 25, 0]]);
    expect(reactionSourceTime(11.2, timeline)).toBe(10.65);
    expect(reactionSourceTime(11.85, timeline)).toBeCloseTo(10.87, 3);
    expect(reactionOutputTime(10.65, timeline, 'end')).toBe(10.65);
    expect(reactionOutputTime(10.65, timeline)).toBe(11.63);
    expect(reactionOutputTime(23, timeline)).toBeCloseTo(18.98, 3);
    expect(() => reactionSourceTime(25, timeline)).toThrow('exceeds');
});

test.each([0, -1, 1.001, NaN])('pause seconds %s cannot become an unbounded media hold', seconds => {
    expect(() => reactionPieces({ ...plan.timeline, holds: [{ after: 10, seconds, cueId: 'S3' }] })).toThrow('reaction pause');
});

test('two laughs shift later cues once and retain original chronological source intervals', () => {
    const secondSpeech = speech.concat({ id: 'S6', start: 16, end: 17, text: '另一个笑点' }, { id: 'S7', start: 17, end: 18, text: '回答' });
    const secondPlan = { ...plan, effects: plan.effects.concat({ id: 'M3', start: 16, end: 17, speechIds: ['S6'],
        zoom: { scale: 1.35 }, sound: { id: 'laugh', offsetSeconds: .1, levelDb: -1 } }) };
    const result = planLaughterTiming(secondPlan, secondSpeech, assets, profile);
    expect(result.insertions).toHaveLength(2);
    expect(result.plan.effects[2].start).toBeCloseTo(16.98, 3);
    expect((result.plan.effects[2].sound as any).offsetSeconds).toBeCloseTo(.96, 3);
    expect(result.plan.timeline!.holds!.map(h => h.after)).toEqual([10.65, 22]);
});
