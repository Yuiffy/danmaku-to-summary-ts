export {};
const { validateStoryPlan, mapTimelineCues, sourceTimeForOutput, absoluteEditPlan, assertTimeline, applySpeedWindows, speedBadges, burnedCues, hiddenCues, atempoFilter, srtText, truncateStoryKeep, forceKeepCueTail } = require('./creative_timeline');
const { creativeSettings, assertRenderPlan, buildCreativeFilter, speedBadgeFilter } = require('./creative_plan');
const cues = Array.from({ length: 6 }, (_, i) => ({ id: `C${i + 1}`, start: i * 10, end: i * 10 + 4, text: `句${i + 1}` }));
const draft = { keep: [{ fromCue: 'C1', toCue: 'C1', role: 'setup', reason: '起因' },
    { fromCue: 'C4', toCue: 'C4', role: 'reaction', reason: '反差' }, { fromCue: 'C6', toCue: 'C6', role: 'payoff', reason: '回扣' }] };

test('a real chronological content edit renders without inventing decorative effects', () => {
    const timeline = validateStoryPlan(draft, cues, 60);
    const plan = { version: 2, workflow: 'creative', duration: timeline.duration, timeline, effects: [] };
    expect(() => assertRenderPlan(plan, 60, {})).not.toThrow();
    const graph = buildCreativeFilter(plan, { width: 640, height: 360 }, 0, 60, 'caption.ass', null);
    expect(graph).toContain('concat=n=3:v=1:a=0');
    expect(graph).toContain('concat=n=3:v=0:a=1');
    expect(() => assertRenderPlan({ ...plan, timeline: null, duration: 60 }, 60, {})).toThrow();
});

test('adjacent complete cue groups merge overlapping padding without duplicating speech or accepting repeated cues', () => {
    const close = [{ id: 'C1', start: 1, end: 4, text: '起因' }, { id: 'C2', start: 4.1, end: 7, text: '反应' },
        { id: 'C3', start: 8, end: 9, text: '删除的支线' }, { id: 'C4', start: 10, end: 12, text: '收尾' }];
    const plan = { keep: [{ fromCue: 'C1', toCue: 'C1', role: 'setup', reason: '起因' },
        { fromCue: 'C2', toCue: 'C2', role: 'reaction', reason: '反应' }, { fromCue: 'C4', toCue: 'C4', role: 'payoff', reason: '收尾' }] };
    const result = validateStoryPlan(plan, close, 15, [close[0], close[1], close[3]]);
    expect(result.keep).toHaveLength(2);
    expect(result.keep[0].start).toBe(.88);
    expect(result.keep[0].end).toBe(7.22);
    expect(result.duration).toBe(8.68);
    expect(mapTimelineCues(close, result).map(c => c.id)).toEqual(['C1', 'C2', 'C4']);
    expect(() => validateStoryPlan({ keep: [plan.keep[0], plan.keep[0], plan.keep[2]] }, close, 15)).toThrow('chronological');
    expect(() => validateStoryPlan({ keep: [plan.keep[1], plan.keep[0], plan.keep[2]] }, close, 15)).toThrow('chronological');
});

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

test('a bounded action lead retains silent gameplay before the reaction and maps its complete caption', () => {
    const plan = { keep: draft.keep.map(row => row.fromCue === 'C4' ? { ...row, actionBeforeSeconds: 5 } : row) };
    const timeline = validateStoryPlan(plan, cues, 60);
    expect(timeline.keep[1].start).toBe(25);
    const mapped = mapTimelineCues(cues, timeline);
    expect(mapped.map(c => c.id)).toEqual(['C1', 'C4', 'C6']);
    expect(mapped[1].start).toBeCloseTo(9.22);
    expect(sourceTimeForOutput(mapped[1].start, timeline)).toBe(30);
    expect(absoluteEditPlan(timeline, 'source', { start: 100, end: 160 }).keep[1].start).toBe(125);
});

test('continuous performance may be wrapped by an introduction and a closing reaction', () => {
    const plan = { keep: [
        { fromCue: 'C1', toCue: 'C1', role: 'setup', reason: '歌曲引入' },
        { fromCue: 'C2', toCue: 'C3', role: 'performance', reason: '连续两句' },
        { fromCue: 'C6', toCue: 'C6', role: 'reaction', reason: '岁己前辈问句' },
    ] };
    expect(() => validateStoryPlan(plan, cues, 60, [], { preserveContinuity: true })).not.toThrow();
    expect(() => validateStoryPlan({ ...plan, keep: [...plan.keep.slice(0, 2),
        { fromCue: 'C5', toCue: 'C5', role: 'performance', reason: '拆开的演唱' }] }, cues, 60, [], { preserveContinuity: true }))
        .toThrow('must not be internally spliced');
});

test('action leads clamp at source start and omitted speech, and merge adjacent retained padding', () => {
    const plan = { keep: draft.keep.map(row => ({ ...row, actionBeforeSeconds: 12 })) };
    const timeline = validateStoryPlan(plan, cues, 60);
    expect(timeline.keep.map(span => span.start)).toEqual([0, 24, 44]);
    expect(mapTimelineCues(cues, timeline).map(c => c.id)).toEqual(['C1', 'C4', 'C6']);
    const adjacent = { keep: [{ ...draft.keep[0], actionBeforeSeconds: 12 },
        { fromCue: 'C2', toCue: 'C2', role: 'payoff', reason: '动作连贯', actionBeforeSeconds: 12 }] };
    expect(validateStoryPlan(adjacent, cues, 60).keep).toHaveLength(1);
    expect(validateStoryPlan({ keep: draft.keep.map(row => ({ ...row, actionBeforeSeconds: 0 })) }, cues, 60))
        .toEqual(validateStoryPlan(draft, cues, 60));
});

test.each([-1, 12.01, NaN, Infinity, '5', null])('invalid explicit action lead %p fails without changing speech boundaries', value => {
    const plan = { keep: draft.keep.map((row, i) => i === 1 ? { ...row, actionBeforeSeconds: value } : row) };
    expect(() => validateStoryPlan(plan, cues, 60)).toThrow('actionBeforeSeconds');
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

test('a post-speech reaction pause shifts captions, media and audio reference together without replaying words', () => {
    const timeline = { version: 1, sourceDuration: 8, duration: 8.8, keep: [{ start: 0, end: 8 }],
        holds: [{ after: 2, seconds: .8, cueId: 'S1' }], addedSeconds: .8 };
    const words = [{ id: 'S1', start: 0, end: 2, text: '完整笑话' }, { id: 'S2', start: 2, end: 4, text: '下句回答' }];
    const mapped = mapTimelineCues(words, timeline);
    expect(mapped).toEqual([{ ...words[0] }, { ...words[1], start: 2.8, end: 4.8 }]);
    expect(sourceTimeForOutput(2.4, timeline)).toBe(2);
    expect(() => mapTimelineCues([{ id: 'S3', start: 1, end: 3 }], timeline)).toThrow('split speech');
    expect(() => assertTimeline(timeline, 8)).not.toThrow();
    const plan = { version: 2, workflow: 'creative', duration: 8.8, timeline, effects: [] };
    const graph = buildCreativeFilter(plan, { width: 640, height: 360 }, 0, 8, 'caption.ass', null, {});
    expect(graph).toContain('tpad=stop_mode=clone:stop_duration=0.8');
    expect(graph).toContain('apad,atrim=duration=2.800000');
    const audio = require('./creative_timeline').audioTimelineFilter(timeline);
    expect(audio).toContain('apad,atrim=duration=2.800000');
    expect(audio).toContain('afade=t=in:st=0:d=0.08');
    expect(audio).toContain('afade=t=out:st=5.92:d=0.08');
});

// --- acceleration and BGM opt-out -------------------------------------------

const { audioTimelineFilter } = require('./creative_timeline');
const traversal = [{ id: 'C1', start: 0, end: 4, text: '我们已经摸过这个铃铛了' },
    { id: 'C2', start: 4.2, end: 8, text: '我们接着往前走' },
    { id: 'C3', start: 8.2, end: 14, text: '打了几个小怪' },
    { id: 'C4', start: 14.2, end: 18, text: '这个游戏真是五米一个铃铛' },
    { id: 'C5', start: 18.2, end: 22, text: '我碰过了，真的假的' }];

test('an accelerated traversal span keeps whole captions, halves its source time and inverts its own clock', () => {
    const draft = { keep: [
        { fromCue: 'C1', toCue: 'C2', role: 'setup', reason: '先摸过铃铛再出发' },
        { fromCue: 'C3', toCue: 'C3', role: 'escalation', reason: '重复刷怪没有新信息', speed: 2, speedReason: '同一批小怪没有新信息' },
        { fromCue: 'C4', toCue: 'C5', role: 'payoff', reason: '以为是新铃铛' },
    ] };
    const timeline = validateStoryPlan(draft, traversal, 22);
    const sped = timeline.keep.find(span => span.speed === 2);
    expect(sped.end - sped.start).toBeGreaterThan(5.5);
    expect(timeline.duration).toBeLessThan(20);
    expect(timeline.spedSavedSeconds).toBeGreaterThan(2.5);
    const mapped = mapTimelineCues(traversal, timeline);
    expect(mapped.map(cue => cue.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5']);
    const cue = mapped.find(row => row.id === 'C3');
    expect(cue.end - cue.start).toBeCloseTo((14 - 8.2) / 2, 2);
    const middle = (cue.start + cue.end) / 2;
    expect(sourceTimeForOutput(middle, timeline)).toBeCloseTo(sped.start + (middle - cue.start) * 2, 1);
    const plan = { version: 2, workflow: 'creative', duration: timeline.duration, timeline, effects: [] };
    expect(() => assertRenderPlan(plan, 22, {})).not.toThrow();
    const graph = buildCreativeFilter(plan, { width: 640, height: 360, frameRate: 30 }, 0, 22, 'caption.ass', null, {});
    expect(graph).toContain('setpts=(PTS-STARTPTS)/2');
    expect(graph).toContain(',fps=30');
    expect(graph).toContain('atempo=2');
    expect(audioTimelineFilter(timeline)).toContain('atempo=2');
    expect(() => assertTimeline({ ...timeline, duration: timeline.duration + 1 }, 22)).toThrow('duration');
});

test.each([
    [{ fromCue: 'C4', toCue: 'C5', role: 'payoff', reason: '笑点', speed: 2, speedReason: '想快一点' }, 'payoff'],
    [{ fromCue: 'C3', toCue: 'C3', role: 'escalation', reason: '刷怪', speed: 2 }, 'speedReason'],
    [{ fromCue: 'C3', toCue: 'C3', role: 'escalation', reason: '刷怪', speed: 12, speedReason: '超出上限' }, 'between'],
])('unsafe acceleration is refused: %p', (row, message) => {
    expect(() => validateStoryPlan({ keep: [{ fromCue: 'C1', toCue: 'C2', role: 'setup', reason: '出发' }, row] }, traversal, 22))
        .toThrow(message);
});

test('acceleration that would flash a short caption is refused instead of silently speeding a punchline', () => {
    const short = [{ id: 'C1', start: 0, end: 3, text: '起身' }, { id: 'C2', start: 3.2, end: 4.1, text: '嗯？' },
        { id: 'C3', start: 4.3, end: 8, text: '收尾' }];
    expect(() => validateStoryPlan({ keep: [{ fromCue: 'C1', toCue: 'C1', role: 'setup', reason: '开场' },
        { fromCue: 'C2', toCue: 'C2', role: 'escalation', reason: '走两步', speed: 2, speedReason: '空走' },
        { fromCue: 'C3', toCue: 'C3', role: 'payoff', reason: '收尾' }] }, short, 8))
        .toThrow('unreadable');
});

test('an operator rate plan splits a retained span at caption edges and records its output position', () => {
    const whole = { preserveContinuity: false, music: 'none' };
    const timeline = validateStoryPlan({ keep: [{ fromCue: 'C1', toCue: 'C5', role: 'escalation', reason: '整段保留' }] }, traversal, 22, [], whole);
    // 8.3 and 14.05 land inside the C3 caption, so both edges snap to that caption.
    const next = applySpeedWindows(timeline, [{ start: 8.3, end: 13.95, rate: 2, reason: '刷怪' }], traversal, { start: 0, end: 22 });
    expect(next.keep).toHaveLength(3);
    expect(next.keep[1].speed).toBe(2);
    expect(next.keep[1].start).toBe(8.2);
    expect(next.keep[1].end).toBe(14);
    expect(next.speedWindows).toHaveLength(1);
    expect(next.speedWindows[0].outputStart).toBeCloseTo(8.2, 2);
    expect(next.speedWindows[0].outputDuration).toBeCloseTo((14 - 8.2) / 2, 2);
    expect(next.duration).toBeCloseTo(22 - (14 - 8.2) / 2, 2);
    expect(next.speedWindows[0].reason).toBe('刷怪');
    expect(mapTimelineCues(traversal, next).map(cue => cue.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5']);
    // Absolute recording seconds are converted through the supplied source window.
    const shifted = applySpeedWindows(timeline, [{ start: 13508.3, end: 13513.95, rate: 2 }], traversal, { start: 13500, end: 13522 });
    expect(shifted.speedWindows[0].start).toBe(8.2);
    expect(() => applySpeedWindows(timeline, [{ start: 8.3, end: 14.05, rate: 11 }], traversal, null)).toThrow('between');
    expect(() => applySpeedWindows(timeline, [{ start: 8.3, end: 40, rate: 2 }], traversal, null)).toThrow('outside');
});

test('a window edge that grazes a setup span is trimmed back instead of failing the whole cut', () => {
    // The operator's window starts inside the setup span; only the edge is wrong,
    // so the window shrinks to the setup boundary and the setup keeps real time.
    const timeline = { version: 1, sourceDuration: 22, duration: 22, removedSeconds: 0, keep: [
        { start: 0, end: 8, role: 'setup', reason: '先摸过铃铛再出发' },
        { start: 8, end: 14, role: 'escalation', reason: '重复刷怪' },
        { start: 14, end: 22, role: 'payoff', reason: '以为是新铃铛' }] };
    const next = applySpeedWindows(timeline, [{ start: 4.3, end: 14, rate: 2, reason: '刷怪' }], traversal, { start: 0, end: 22 });
    const sped = next.keep.filter(span => span.speed === 2);
    expect(sped).toHaveLength(1);
    expect(sped[0].start).toBe(8);
    expect(sped[0].end).toBe(14);
    expect(next.keep.find(span => span.role === 'setup').speed).toBeUndefined();
    expect(next.speedWindowTrimSeconds).toBeCloseTo(3.8, 2);
});

test('a protected span fully inside a rate window still fails instead of being sped up', () => {
    const timeline = { version: 1, sourceDuration: 22, duration: 22, removedSeconds: 0, keep: [
        { start: 0, end: 8, role: 'escalation', reason: '赶路' },
        { start: 8.2, end: 14, role: 'setup', reason: '看见新铃铛' },
        { start: 14.2, end: 22, role: 'payoff', reason: '确认碰过' }] };
    expect(() => applySpeedWindows(timeline, [{ start: 4.3, end: 18, rate: 2 }], traversal, null))
        .toThrow('setup span');
});

test('a rate plan that only covers removed footage is refused instead of producing a dishonest claim', () => {
    const timeline = validateStoryPlan({ keep: [{ fromCue: 'C1', toCue: 'C1', role: 'setup', reason: '开场' },
        { fromCue: 'C5', toCue: 'C5', role: 'payoff', reason: '收尾' }] }, traversal, 22);
    expect(() => applySpeedWindows(timeline, [{ start: 8.2, end: 14, rate: 2 }], traversal, null))
        .toThrow('mostly removed');
});

test('background music is optional and a disabled setting rejects a plan that still adds it', () => {
    expect(creativeSettings({ style: 'compact' }).music).toBe(true);
    expect(creativeSettings({ style: 'compact', music: false }).music).toBe(false);
    const timeline = validateStoryPlan(draft, cues, 60), settings = creativeSettings({ style: 'compact', music: false });
    const assets = { music: { kind: 'music', sampleSeconds: 10 } };
    const plan = { version: 2, style: 'compact', workflow: 'creative', duration: timeline.duration, timeline, effects: [] };
    expect(() => assertRenderPlan(plan, 60, settings, assets)).not.toThrow();
    expect(() => assertRenderPlan({ ...plan, music: { id: 'music', levelDb: -27 } }, 60, settings, assets)).toThrow('background music');
});

test('a very high rate chains atempo so the pitch stays put', () => {
    expect(atempoFilter(2)).toBe('atempo=2');
    expect(atempoFilter(3)).toBe('atempo=2,atempo=1.5');
    expect(atempoFilter(6)).toBe('atempo=2,atempo=2,atempo=1.5');
});

test('a high rate swaps burned captions for an on-screen rate and duration badge', () => {
    const timeline = validateStoryPlan({ keep: [{ fromCue: 'C1', toCue: 'C5', role: 'escalation', reason: '整段赶路' }] },
        traversal, 22, [], { preserveContinuity: false });
    const next = applySpeedWindows(timeline, [{ start: 8.2, end: 14, rate: 6, reason: '重复刷怪' }], traversal, null);
    const mapped = mapTimelineCues(traversal, next, true);
    expect(hiddenCues(mapped).map(cue => cue.id)).toEqual(['C3']);
    expect(burnedCues(mapped).map(cue => cue.id)).toEqual(['C1', 'C2', 'C4', 'C5']);
    expect(srtText(burnedCues(mapped))).not.toContain('打了几个小怪');
    const badges = speedBadges(next);
    expect(badges).toHaveLength(1);
    expect(badges[0].text).toBe('6× 快进 1s');
    expect(badges[0].start).toBeCloseTo(8.2, 2);
    expect(badges[0].end).toBeCloseTo(9.17, 2);
    expect(badges[0].rate).toBe(6);
    const graph = speedBadgeFilter({ timeline: next }, 1080, 'C:/Windows/Fonts/msyhbd.ttc');
    expect(graph).toContain("text='6× 快进 1s'");
    expect(graph).toContain("enable='between(t,8.2,9.167)'");
    expect(graph).toContain('fontsize=41');
    expect(graph).toContain('x=w-tw-54');
});

test('a moderate rate keeps the captions on screen instead of blanking them', () => {
    const timeline = validateStoryPlan({ keep: [{ fromCue: 'C1', toCue: 'C5', role: 'escalation', reason: '整段赶路' }] },
        traversal, 22, [], { preserveContinuity: false });
    const next = applySpeedWindows(timeline, [{ start: 8.2, end: 14, rate: 2, reason: '重复刷怪' }], traversal, null);
    expect(hiddenCues(mapTimelineCues(traversal, next, true))).toHaveLength(0);
    expect(speedBadges(next)[0].text).toBe('2× 快进 2.9s');
});

test('an operator hard cut drops the tail, clips crossing keep spans and keeps the head intact', () => {
    const value = { keep: [
        { fromCue: 'C1', toCue: 'C2', role: 'setup', reason: '起因' },
        { fromCue: 'C3', toCue: 'C6', role: 'payoff', reason: '原结尾' },
        { fromCue: 'C5', toCue: 'C5', role: 'context', reason: '后续支线' }
    ] };
    expect(truncateStoryKeep(value, cues, 34)).toBe(1);
    expect(value.keep).toHaveLength(2);
    expect(value.keep[0]).toMatchObject({ fromCue: 'C1', toCue: 'C2' });
    expect(value.keep[1].toCue).toBe('C4');
    expect(value.keep[1].reason).toContain('cut');
    const timeline = validateStoryPlan(value, cues, 60);
    expect(mapTimelineCues(cues, timeline).map(c => c.id)).toEqual(['C1', 'C2', 'C3', 'C4']);
    // An operator hard cut needs an exact ending, not the usual reaction hold.
    expect(validateStoryPlan(value, cues, 60, [], null, 0).keep.at(-1).end).toBe(34);
});

test('a hard cut is inert unless requested and rejects a point before the first cue', () => {
    const value = { keep: [{ fromCue: 'C1', toCue: 'C6', role: 'closing', reason: '完整一段' }] };
    expect(truncateStoryKeep(value, cues, Number.NaN)).toBe(0);
    expect(value.keep[0].toCue).toBe('C6');
    expect(truncateStoryKeep(value, cues, 60)).toBe(0);
    expect(value.keep[0].toCue).toBe('C6');
    expect(() => truncateStoryKeep(value, cues, 0)).toThrow('precedes the first');
});

test('the keep-tail decree restores every dropped tail cue without bridging silence gaps', () => {
    const value = { keep: [{ fromCue: 'C1', toCue: 'C1', role: 'setup', reason: '起因' }] };
    expect(forceKeepCueTail(value, cues, 30)).toBe(1);
    expect(value.keep.map(row => row.fromCue)).toEqual(['C1', 'C4']);
    expect(value.keep[1]).toMatchObject({ fromCue: 'C4', toCue: 'C6', role: 'context' });
    // Idempotent: a second enforcement pass finds the tail fully covered.
    expect(forceKeepCueTail(value, cues, 30)).toBe(0);
    // A partial cover only gets its missing leading cue inserted.
    const partial = { keep: [{ fromCue: 'C1', toCue: 'C1', role: 'setup', reason: '起因' },
        { fromCue: 'C5', toCue: 'C6', role: 'closing', reason: '收束' }] };
    expect(forceKeepCueTail(partial, cues, 30)).toBe(1);
    expect(partial.keep.map(row => row.fromCue)).toEqual(['C1', 'C4', 'C5']);
    const timeline = validateStoryPlan(value, cues, 60, [cues[3], cues[5]], {});
    expect(mapTimelineCues(cues, timeline).map(c => c.id)).toEqual(['C1', 'C4', 'C5', 'C6']);
    // Head cues outside the decree stay trimmable.
    expect(() => validateStoryPlan(value, cues, 60, [cues[2]])).toThrow('public-copy evidence');
});

test('a silent performance beat is held into the gap without restoring omitted speech', () => {
    const value = { keep: [
        { fromCue: 'C1', toCue: 'C1', role: 'setup', reason: '起因', holdAfterSeconds: 6 },
        { fromCue: 'C2', toCue: 'C2', role: 'reaction', reason: '尴尬笑后的反应' }
    ] };
    const timeline = validateStoryPlan(value, cues, 60, [], {});
    expect(timeline.keep).toHaveLength(1);
    expect(timeline.keep[0].end).toBe(14.22);
    expect(mapTimelineCues(cues, timeline).map(c => c.id)).toEqual(['C1', 'C2']);
    expect(() => validateStoryPlan({ keep: [{ fromCue: 'C1', toCue: 'C1', role: 'setup', reason: '起因', holdAfterSeconds: 99 }] },
        cues, 60, [], {})).toThrow('holdAfterSeconds');
});
