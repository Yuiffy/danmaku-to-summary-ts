export {};
const { validateFaceInset, insetGeometry, faceInsetFilters, applyInsetLayout } = require('./face_inset');
const { creativeSettings, validateCreativePlan, buildCreativeFilter, stickerAss } = require('./creative_plan');
const inset = () => ({ sourceBox: { x: .76, y: .815, width: .1, height: .17 }, x: .73, y: .30, diameter: .42, clearOfAction: true });

test('round inset uses a square source crop, preserves edge faces with padding and leaves room for subtitles', () => {
    const g = insetGeometry(inset(), 1920, 1080);
    expect(g.size).toBe(454);
    expect(g.cropH).toBeLessThan(g.side);
    expect(g.left + g.size).toBeLessThan(1920);
    expect(g.top + g.size).toBeLessThan(1080 * .84);
    expect(() => validateFaceInset({ ...inset(), clearOfAction: false })).toThrow();
    expect(() => validateFaceInset({ ...inset(), y: .6 })).toThrow();
    expect(() => insetGeometry({ ...inset(), x: .85 }, 1920, 1080)).toThrow('safe area');
    expect(() => insetGeometry({ ...inset(), sourceBox: { x: .6, y: .5, width: .3, height: .4 } }, 1920, 1080)).toThrow('magnify');
});

test('inset conversion retains gameplay, timing and audio while moving filters to the face only', () => {
    const raw = { effects: [{ momentId: 'M1', frameIds: ['M1F0', 'M1F1', 'M1F2'], visualConfirmed: true, reason: 'reaction',
        zoom: { target: 'avatar', scale: 2, x: .8, y: .8, safeToCrop: true }, filter: 'monochrome', sound: 'pop' }] };
    const converted = applyInsetLayout(raw, { insets: [{ momentId: 'M1', ...inset() }] });
    expect(converted.effects[0].zoom).toBeNull(); expect(converted.effects[0].sound).toBe('pop');
    expect(raw.effects[0].zoom).not.toBeNull();
    expect(() => applyInsetLayout(raw, { insets: [] })).toThrow('every avatar');
    const plan = validateCreativePlan(converted, [{ id: 'M1', start: 2, end: 5 }], 'source', 60,
        creativeSettings({ style: 'compact', soundEffects: true, filters: true }));
    const graph = buildCreativeFilter(plan, { width: 1920, height: 1080 }, 8, 68, 'captions.ass', 'effects.ass');
    expect(graph).toContain('alphamerge'); expect(graph).toContain('hypot(');
    expect(graph).toContain('[ib0][ic0]overlay=');
    expect(graph).toContain('hue=s=0[if0]');
    expect(graph).not.toContain('[iv0]hue=');
    expect(stickerAss(plan, 1920, 1080)).toContain('\\p1');
    expect(graph.indexOf('alphamerge')).toBeLessThan(graph.indexOf('subtitles='));
});

test.each([
    { x: .755, y: .815, width: .1, height: .175 },
    { x: .005, y: .005, width: .1, height: .175 },
    { x: .895, y: .815, width: .1, height: .175 }
])('large edge closeup keeps its padding outside the viewport and the complete face visible (%j)', sourceBox => {
    const value = { sourceBox, placement: 'source', edgeOverflow: true, diameter: .60, clearOfAction: true };
    const width = 1920, height = 1080, g = insetGeometry(value, width, height);
    const scale = g.size / g.side;
    const faceLeft = g.left + (sourceBox.x * width - g.cropX + g.padX) * scale;
    const faceTop = g.top + (sourceBox.y * height - g.cropY + g.padY) * scale;
    expect(faceLeft).toBeGreaterThanOrEqual(-2);
    expect(faceTop).toBeGreaterThanOrEqual(-2);
    expect(faceLeft + sourceBox.width * width * scale).toBeLessThanOrEqual(width + 2);
    expect(faceTop + sourceBox.height * height * scale).toBeLessThanOrEqual(height + 2);
    if (g.padX) expect(g.left + g.padX * scale).toBeLessThanOrEqual(0);
    if (g.padY) expect(g.top + g.padY * scale).toBeLessThanOrEqual(0);
    if (g.padX + g.cropW < g.side) expect(g.left + (g.padX + g.cropW) * scale).toBeGreaterThanOrEqual(width);
    if (g.padY + g.cropH < g.side) expect(g.top + (g.padY + g.cropH) * scale).toBeGreaterThanOrEqual(height);
    expect(g.size).toBe(648);
    expect(g.left < 0 || g.top < 0 || g.left + g.size > width || g.top + g.size > height).toBe(true);
    const old = insetGeometry({ ...value, edgeOverflow: false, diameter: .4 }, width, height);
    expect(g.size / g.side).toBeGreaterThan(old.size / old.side * 1.45);
});

test('detail zoom keeps a separate original-scale face feed, while faces already in view need no duplicate', () => {
    const sourceBox = { x: .755, y: .815, width: .1, height: .175 };
    const raw = { effects: [{ momentId: 'M1', frameIds: ['M1F0', 'M1F1', 'M1F2'], visualConfirmed: true, reason: 'bridge detail',
        zoom: { target: 'detail', scale: 2, x: .4, y: .4, targetBox: { x: .3, y: .3, width: .1, height: .1 }, safeToCrop: true } }] };
    const { applyFaceRetention } = require('./face_inset');
    const converted = applyFaceRetention(raw, { faces: [{ momentId: 'M1', sourceBox, clearOfAction: true }] }, { width: 1920, height: 1080 });
    const g = insetGeometry(converted.effects[0].faceInset, 1920, 1080);
    expect(g.size / g.side).toBe(1);
    const plan = validateCreativePlan(converted, [{ id: 'M1', start: 2, end: 5 }], 'source', 60, creativeSettings({ style: 'compact' }));
    const graph = buildCreativeFilter(plan, { width: 1920, height: 1080 }, 8, 68, 'captions.ass', 'effects.ass');
    expect(graph).toContain('[cv0]split=2[detailbase0][originalface0]');
    expect(graph).toContain('[originalface0]trim=start=2:end=5,crop=');
    expect(graph).toContain('[zv0][ic0]overlay=');
    expect(graph.indexOf('[zv0][ic0]')).toBeLessThan(graph.indexOf('subtitles='));
    const visible = applyFaceRetention({ effects: [{ ...raw.effects[0], zoom: { ...raw.effects[0].zoom, x: .76, y: .75 } }] },
        { faces: [{ momentId: 'M1', sourceBox, clearOfAction: true }] }, { width: 1920, height: 1080 });
    expect(visible.effects[0].faceInset).toBeUndefined();
    const atBottom = insetGeometry({ mode: 'retain', placement: 'source', sourceBox: { x: .75, y: .84, width: .1, height: .16 }, clearOfAction: true }, 1920, 1080);
    expect(atBottom.size).toBe(atBottom.side);
    expect(atBottom.top + (atBottom.padY + atBottom.cropH)).toBe(1080);
});

test('detail framing can exclude a partial enlarged face without losing the approved target', () => {
    const zoom = { target: 'detail', scale: 1.8, x: .52, y: .59, targetBox: { x: .3, y: .38, width: .42, height: .38 } };
    const face = { x: .74, y: .78, width: .09, height: .18 };
    const adjusted = require('./face_inset').avoidPartialFaceInDetail(zoom, face), extent = 1 / adjusted.scale;
    expect(adjusted).not.toEqual(zoom);
    const left = adjusted.x - extent / 2, top = adjusted.y - extent / 2;
    expect(left + extent <= face.x || top + extent <= face.y).toBe(true);
    expect(left).toBeLessThanOrEqual(zoom.targetBox.x);
    expect(left + extent).toBeGreaterThanOrEqual(zoom.targetBox.x + zoom.targetBox.width);
    expect(top).toBeLessThanOrEqual(zoom.targetBox.y);
    expect(top + extent).toBeGreaterThanOrEqual(zoom.targetBox.y + zoom.targetBox.height);
});
