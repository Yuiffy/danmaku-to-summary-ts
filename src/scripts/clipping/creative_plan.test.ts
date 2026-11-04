export {};
const { creativeSettings, speechForCreative, validateMoments, sanitizeMoments, validateCreativePlan, assertRenderPlan,
    stickerAss, buildCreativeFilter } = require('./creative_plan');
const limits = creativeSettings({ soundEffects: true });
const speech = speechForCreative([{ start: 100, end: 110, text: '等一下，怎么回事？' }], { start: 100, end: 160 });
const moments = () => validateMoments({ moments: [{ start: 3, end: 5, speechIds: ['S1'], reason: '疑惑反应' }] }, speech, 60, limits);
const effect = () => ({ momentId: 'M1', frameIds: ['M1F0', 'M1F1', 'M1F2'], visualConfirmed: true, reason: '表情清楚',
    zoom: { scale: 1.35, x: .8, y: .5, target: 'avatar', safeToCrop: true },
    sticker: { id: 'question', x: .2, y: .3, motion: 'pop', clearOfSubject: true }, sound: 'pop' });

test('chat is quoted as a danmaku layer (scroll/bubble) instead of an enlarged chat column', () => {
    const audience = [{ time: 1, text: '大姐你走反了' }, { time: 2, text: '不会这都是走吧' }];
    const base = { ...effect(), zoom: null, sticker: null, sound: null };
    // 默认不放大人人区：一次框三条弹幕看不出重点，战斗中还会挡住游戏画面。
    expect(() => validateCreativePlan({ effects: [{ ...base,
        focusInset: { target: 'chat', shape: 'rectangle', placement: 'source', sourceBox: { x: .02, y: .1, width: .16, height: .2 },
            magnification: 1.6, clearOfAction: true } }] }, moments(), 'source', 60, limits, {}, { audience }))
        .toThrow(/target=chat is disabled/);
    // 运营点名要放大弹幕时才允许。
    const optedIn = creativeSettings({ soundEffects: true, chatInset: true });
    expect(validateCreativePlan({ effects: [{ ...base,
        focusInset: { target: 'chat', shape: 'rectangle', placement: 'source', sourceBox: { x: .02, y: .1, width: .16, height: .2 },
            magnification: 1.6, clearOfAction: true } }] }, moments(), 'source', 60, optedIn, {}, { audience })
        .effects[0].focusInset.target).toBe('chat');
    const plan = validateCreativePlan({ effects: [{ ...base, danmaku: { text: '大姐你走反了', style: 'scroll', y: .18 } }] },
        moments(), 'source', 60, limits, {}, { audience });
    assertRenderPlan(plan, 60, limits);
    const ass = stickerAss(plan, 640, 360, 'Arial');
    expect(ass).toContain('Dialogue: 2,0:00:03.00');
    expect(ass).toMatch(/\\move\(\d+,\d+,-\d+,\d+\)/);
    expect(ass).toContain('大姐你走反了');
    // 弹幕不是自由文案：编造观众反应会被拒。
    expect(() => validateCreativePlan({ effects: [{ ...base, danmaku: { text: '主播好可爱', style: 'bubble', y: .14 } }] },
        moments(), 'source', 60, limits, {}, { audience })).toThrow(/must be copied from the provided audience chat/);
});

test('a bubble danmaku is drawn with a background box above the subtitle bar', () => {
    const audience = [{ time: 2, text: '不会这都是走吧' }];
    const plan = validateCreativePlan({ effects: [{ momentId: 'M1', frameIds: ['M1F0', 'M1F1', 'M1F2'], visualConfirmed: true,
        reason: '观众反应', danmaku: { text: '不会这都是走吧', style: 'bubble', y: .14, size: 1.1 } }] },
        moments(), 'source', 60, limits, {}, { audience });
    const ass = stickerAss(plan, 1280, 720);
    expect(ass).toContain('Style: Bubble,');
    // 气泡底是一层 \p1 圆角矩形，颜色和透明度都由行内覆盖决定。
    expect(ass).toMatch(/\{\\an7\\pos\(\d+,\d+\)\\p1\\bord0\\shad0\\1c&H0E0A07&\\1a&H34&/);
    expect(ass).toMatch(/\}m \d+ \d+ l \d+ \d+ b /);
    expect(ass).toContain('不会这都是走吧');
    expect(ass).not.toContain('\\move(');
});

test('a long quoted line wraps inside the bubble instead of a hair-thin banner', () => {
    const line = '羡慕小岁这种刚玩就能忘记每次走路就像是新游戏的状态';
    const plan = validateCreativePlan({ effects: [{ momentId: 'M1', frameIds: ['M1F0', 'M1F1', 'M1F2'], visualConfirmed: true,
        reason: '观众反应', danmaku: { text: line, style: 'bubble', y: .14, size: 1 } }] },
        moments(), 'source', 60, limits, {}, { audience: [{ time: 2, text: line }] });
    const ass = stickerAss(plan, 1920, 1080);
    // 折行靠 \N，两行以上时底框也要跟着变高，否则文字会溢出气泡。
    const bubbleText = ass.split('\n').find(row => row.includes('Style: Bubble')).length ? ass.split('\n').filter(row => row.includes(',Bubble,')).at(-1) : '';
    expect(bubbleText).toContain('\\N');
    const boxHeight = Number(/\}m \d+ \d+ l (\d+) \d+ b /.exec(ass)?.[1]);
    const single = stickerAss(validateCreativePlan({ effects: [{ momentId: 'M1', frameIds: ['M1F0', 'M1F1', 'M1F2'], visualConfirmed: true,
        reason: '观众反应', danmaku: { text: '跳下去再上去', style: 'bubble', y: .14, size: 1 } }] },
        moments(), 'source', 60, limits, {}, { audience: [{ time: 2, text: '跳下去再上去' }] }), 1920, 1080);
    const singleHeight = Number(/\}m \d+ \d+ l (\d+) \d+ b /.exec(single)?.[1]);
    expect(boxHeight).toBeGreaterThan(singleHeight);
    // 每一行都要自己过一遍转义，拼接处不能把 {} 带进 ASS 覆盖块。
    expect(bubbleText).not.toMatch(/\{[^}]*\{/);
});

test('pictorial reaction stickers come from the asset catalog instead of hand-drawn ASS vectors', () => {
    const { assets } = require('./creative_assets').loadCreativeAssets({ assetManifest: 'config/clip-creative-assets.json' });
    const sticker = { id: 'irasutoya_ase', x: .24, y: .3, motion: 'pop', clearOfSubject: true };
    // 未登记的形象贴纸（曾经手绘的 sweat）不再被接受，必须有真实素材文件。
    expect(() => validateCreativePlan({ effects: [{ ...effect(), sticker: { ...sticker, id: 'sweat' } }] },
        moments(), 'source', 60, limits, assets)).toThrow(/Invalid sticker/);
    if (!assets.irasutoya_ase) return;
    const plan = validateCreativePlan({ effects: [{ ...effect(), sticker }] }, moments(), 'source', 60, limits, assets);
    assertRenderPlan(plan, 60, limits, assets);
    expect(plan.effects[0].sticker.id).toBe('irasutoya_ase');
    // 素材贴纸由 overlay 合成，ASS 里不应再出现手绘矢量路径。
    expect(stickerAss(plan, 640, 360)).not.toContain('\\p1\\1c');
});

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

test('sanitizeMoments greedily enforces the spacing and coverage budgets instead of failing', () => {
    const settings = creativeSettings({ style: 'compact', editorialDensity: 'dense' });
    const cues = Array.from({ length: 8 }, (_, i) => ({ id: `S${i + 1}`, start: i * 4, end: i * 4 + 2, text: `句${i + 1}` }));
    const draft = { moments: [
        { start: 1, end: 5, speechIds: ['S1'], reason: 'A' },
        { start: 5.05, end: 7, speechIds: ['S2'], reason: 'B，与A间距不足' },
        { start: 9, end: 13.5, speechIds: ['S3'], reason: 'C' },
        { start: 13.2, end: 15, speechIds: ['S4'], reason: 'D，与C重叠' },
        { start: 17, end: 19, speechIds: ['S5'], reason: 'E' }
    ] };
    const moments = sanitizeMoments(draft, cues, 30, settings);
    expect(moments.map(row => row.reason[0])).toEqual(['A', 'C', 'E']);
    expect(validateMoments({ moments: moments.map(({ start, end, reason, speechIds }) => ({ start, end, reason, speechIds })) },
        cues, 30, settings)).toEqual(moments);
    // Invalid speech evidence and overlong nodes are dropped, not fatal.
    const messy = { moments: [
        { start: 1, end: 20, speechIds: ['S1'], reason: '过长' },
        { start: 22, end: 24, speechIds: ['S999'], reason: '无证据' },
        { start: 22, end: 24, speechIds: ['S6'], reason: '有效' }
    ] };
    expect(sanitizeMoments(messy, cues, 30, settings).map(row => row.reason)).toEqual(['有效']);
});

test('compact continuous speech can use a justified longer node while preserving a hard upper bound', () => {
    const settings = creativeSettings({ style: 'compact', editorialDensity: 'dense' });
    const cues = [{ id: 'S1', start: 1, end: 13, text: '连续表达' }, { id: 'S2', start: 15, end: 29, text: '第二段连续表达' }];
    const raw = { moments: [{ start: 1, end: 10.415, speechIds: ['S1'], reason: '完整的转折' }] };
    expect(settings.maxEffectSeconds).toBe(12);
    expect(validateMoments(raw, cues, 30, settings)[0].end).toBe(10.415);
    expect(() => validateMoments({ moments: [
        { ...raw.moments[0], end: 13.1 }, { start: 15, end: 27.5, speechIds: ['S2'], reason: '完整的接话' }
    ] }, cues, 30, settings)).toThrow('M1: 12.1s exceeds 12s; M2: 12.5s exceeds 12s');
});

test('compact long node can cite six nearby cues without weakening the ordinary evidence limit', () => {
    const cues = Array.from({ length: 6 }, (_, i) => ({ id: `S${i + 1}`, start: i * 1.5, end: i * 1.5 + 1, text: '连续表达' }));
    const row = { start: 0, end: 10, speechIds: cues.map(cue => cue.id), reason: '完整的表述' };
    expect(validateMoments({ moments: [row] }, cues, 20, creativeSettings({ style: 'compact' }))).toHaveLength(1);
    expect(() => validateMoments({ moments: [{ ...row, end: 5 }] }, cues, 20, limits)).toThrow('invalid timing or speech evidence');
    expect(() => validateMoments({ moments: [{ ...row, speechIds: [...row.speechIds, 'S999'] }] }, cues, 20,
        creativeSettings({ style: 'compact' }))).toThrow('invalid timing or speech evidence');
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
