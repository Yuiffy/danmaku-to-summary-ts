export {};
const { prepareCreativeDraft, shouldConvertAvatarZoom } = require('./creative_preflight');
const { creativeSettings } = require('./creative_plan');
const topic = require('../topic_clipper');
const resolution = { width: 1920, height: 1080 };
const settings = creativeSettings({ style: 'compact', focusPlacement: 'source', faceInsetDiameter: .6, filters: true });
const subtitleStyle = topic.calculateSubtitleStyle(1920, 1080, {});
const subtitleAss = topic.buildBurnAssContentFromSrt('1\n00:00:00,000 --> 00:00:25,000\n原字幕不能缩小也不能改字\n', subtitleStyle);
const moments = ['M1', 'M2', 'M3'].map((id, i) => ({ id, start: 1 + i * 6, end: 5 + i * 6, speechIds: ['S1'], reason: 'reaction' }));
const row = (momentId, effect) => ({ momentId, frameIds: [0, 1, 2].map(i => `${momentId}F${i}`), visualConfirmed: true, reason: 'visible in three frames', ...effect });
const prepare = effects => prepareCreativeDraft({ effects }, { moments, sourceId: 'fixture', duration: 30,
    settings, assets: {}, resolution, subtitleAss, subtitleStyle });

test('reports all oversized direct insets together, even those without stickers', () => {
    const faceInset = { sourceBox: { x: .385, y: .28, width: .23, height: .27 }, placement: 'source', diameter: .36, clearOfAction: true };
    try {
        prepare([row('M1', { faceInset }), row('M2', { faceInset }), row('M3', { filter: 'monochrome' })]);
        throw new Error('Expected preflight failure');
    } catch (error) {
        expect(error.message).toContain('M1:');
        expect(error.message).toContain('M2:');
        expect(error.message).not.toContain('M3:');
        expect(error.message).toContain('required diameter>=');
        expect(error.message).toContain('Keep the observed face box intact');
    }
    expect(faceInset.sourceBox.width).toBe(.23);
});

test('checks full-size subtitle layout before rendering a geometrically valid central enlargement', () => {
    const focusInset = { sourceBox: { x: .3, y: .25, width: .4, height: .4 }, target: 'person', shape: 'rectangle',
        placement: 'source', magnification: 2, clearOfAction: true };
    expect(() => prepare([row('M1', { focusInset })])).toThrow(/M1: Focus leaves no readable subtitle area/);
    const repaired = prepare([row('M1', { filter: 'monochrome' }), row('M2', { zoom: { scale: 1.5, x: .5, y: .4,
        target: 'avatar', targetBox: { x: .38, y: .28, width: .23, height: .27 }, safeToCrop: true } })]);
    expect(repaired.effects.map(e => e.id)).toEqual(['M1', 'M2']);
});

test('auto circle conversion respects scene and achievable magnification', () => {
    const large = { zoom: { target: 'avatar', targetBox: { x: .38, y: .28, width: .23, height: .27 } } };
    const small = { zoom: { target: 'avatar', targetBox: { x: .02, y: .7, width: .1, height: .15 } } };
    expect(shouldConvertAvatarZoom(large, settings, { kind: 'story' }, resolution)).toBe(false);
    expect(shouldConvertAvatarZoom(large, settings, { kind: 'gameplay' }, resolution)).toBe(false);
    expect(shouldConvertAvatarZoom(small, settings, { kind: 'gameplay' }, resolution)).toBe(true);
    expect(shouldConvertAvatarZoom(small, settings, { kind: 'conversation' }, resolution)).toBe(false);
    expect(shouldConvertAvatarZoom(large, { ...settings, avatarMode: 'circle' }, { kind: 'story' }, resolution)).toBe(true);
});

test('preflight still rejects unconfirmed crops and conflicting presentations', () => {
    expect(() => prepare([row('M1', { zoom: { scale: 1.5, x: .5, y: .4, target: 'avatar',
        targetBox: { x: .38, y: .28, width: .23, height: .27 }, safeToCrop: false } })])).toThrow('safeToCrop');
});
