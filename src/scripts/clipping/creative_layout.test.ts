export {};
const { anchorSpatialPlan, focusBounds, subtitleZone, layoutSubtitleAss } = require('./creative_layout');
const { focusGeometry, validateFocusInset } = require('./focus_inset');
const topic = require('../topic_clipper');

test.each([[1920, 1080, .78, .8], [1920, 1080, .05, .05], [1080, 1080, .8, .75], [720, 1280, .1, .8]])('focus stays near its original subject for %j x %j', (width, height, x, y) => {
    const sourceBox = { x, y, width: .06, height: .07 };
    const plan = anchorSpatialPlan({ effects: [{ start: 1, end: 3, faceInset: { sourceBox, x: .03, y: .3, diameter: .4, clearOfAction: true },
        sticker: { id: 'question', x: .2, y: .2, width: .14, motion: 'pop' } }] }, { width, height }, { focusPlacement: 'source' });
    const row = plan.effects[0], box = focusBounds(row, width, height), cx = (x + .03) * width, cy = (y + .035) * height;
    expect(cx).toBeGreaterThanOrEqual(box.left); expect(cx).toBeLessThanOrEqual(box.left + box.outputWidth);
    expect(cy).toBeGreaterThanOrEqual(box.top); expect(cy).toBeLessThanOrEqual(box.top + box.outputHeight);
    expect(Math.abs(row.sticker.x * width - cx)).toBeLessThan(width * .35);
    expect(row.faceInset.placement).toBe('source');
});

test('chat and object details can be enlarged at their source location with a rectangular frame', () => {
    for (const target of ['chat', 'detail']) {
        const inset = validateFocusInset({ target, shape: 'rectangle', placement: 'source', sourceBox: { x: .05, y: .25, width: .2, height: .08 }, magnification: 1.8, clearOfAction: true });
        const box = focusGeometry(inset, 1920, 1080);
        expect(box.left).toBeLessThan(1920 * .15);
        expect(box.outputWidth).toBeGreaterThan(1920 * .2);
        expect(box.outputWidth / box.outputHeight).toBeCloseTo(box.cropW / box.cropH, 1);
    }
});

test('bottom-right face reserves a left subtitle lane without shrinking type or changing words/timing', () => {
    const original = '你还在吃奶粉的时候我就在玩游戏了';
    const style = { playResX: 1280, playResY: 720, fontSize: 68, outline: 6, marginV: 24 };
    const plan = anchorSpatialPlan({ effects: [{ start: 1, end: 4,
        faceInset: { sourceBox: { x: .755, y: .815, width: .1, height: .175 }, diameter: .4, placement: 'source', clearOfAction: true },
        sticker: { id: 'question', x: .18, y: .2, width: .14, motion: 'pop' } }] }, { width: 1920, height: 1080 }, { focusPlacement: 'source' });
    const box = focusBounds(plan.effects[0], style.playResX, style.playResY), zone = subtitleZone(plan.effects[0], style.playResX, style.playResY, style.marginV);
    expect(zone.right).toBeLessThan(box.left);
    expect(plan.effects[0].sticker.x).toBeGreaterThan(.65);
    const ass = topic.buildBurnAssContentFromSrt(`1\n00:00:00,000 --> 00:00:05,000\n${original}\n`, style);
    const rewritten = layoutSubtitleAss(ass, plan, style), events = rewritten.split('\n').filter(line => line.startsWith('Dialogue:'));
    expect(events).toHaveLength(3);
    expect(events[1]).toContain('0:00:01.00,0:00:04.00');
    expect(events[1]).toContain('\\pos('); expect(events[1]).toContain('\\N');
    expect(events[1].split(',').slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, '')).toBe(original);
    expect(rewritten.match(/^Style:.*$/m)[0]).toBe(ass.match(/^Style:.*$/m)[0]);
    expect(rewritten).not.toContain('\\fs');
});

test('the large circle setting does not enlarge a retained face during a detail zoom', () => {
    const sourceBox = { x: .755, y: .815, width: .1, height: .175 };
    const plan = anchorSpatialPlan({ effects: [{ start: 2, end: 5, zoom: { target: 'detail', scale: 2, x: .4, y: .3 },
        faceInset: { mode: 'retain', sourceBox, placement: 'source', clearOfAction: true } }] },
        { width: 1920, height: 1080 }, { focusPlacement: 'source', faceInsetDiameter: .6 });
    const box = focusBounds(plan.effects[0], 1920, 1080);
    expect(box.size).toBe(box.side);
    expect(plan.effects[0].faceInset.diameter).toBeUndefined();
    expect(box.top + box.outputHeight).toBeGreaterThan(1080);
});
