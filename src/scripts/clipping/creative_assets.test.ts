export {};
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { loadCreativeAssets, creativeInputs } = require('./creative_assets');
const { creativeSettings, validateMoments, validateCreativePlan, assertRenderPlan, buildCreativeFilter, stickerAss } = require('./creative_plan');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('only installed hash-matching catalog assets become available; changed files cannot be rendered', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-assets-'));
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const entry = { id: 'test_image', kind: 'sticker', file: 'test.png', sourceUrl: 'https://example.test/source',
        downloadUrl: 'https://example.test/image.png', licenseUrl: 'https://example.test/license', license: 'test', creator: 'fixture', sha256: hash(bytes) };
    const manifest = path.join(dir, 'catalog.json');
    try {
        fs.writeFileSync(manifest, JSON.stringify({ version: 1, cacheDirectory: dir, assets: [entry] }));
        expect(loadCreativeAssets({ assetManifest: manifest }).unavailable).toHaveLength(1);
        fs.writeFileSync(path.join(dir, 'test.png'), bytes);
        const { assets } = loadCreativeAssets({ assetManifest: manifest });
        expect(Object.keys(assets)).toEqual(['test_image']);
        const plan = { effects: [{ sticker: { id: 'test_image' } }] };
        expect(creativeInputs(plan, assets).args).toEqual(['-i', path.join(dir, 'test.png')]);
        fs.appendFileSync(path.join(dir, 'test.png'), 'changed');
        expect(() => creativeInputs(plan, assets)).toThrow('asset changed');
        expect(Object.keys(loadCreativeAssets({ assetManifest: manifest }).assets)).toEqual([]);
        fs.writeFileSync(manifest, JSON.stringify({ version: 1, cacheDirectory: dir, assets: [{ ...entry, file: '../other.png' }] }));
        expect(() => loadCreativeAssets({ assetManifest: manifest })).toThrow('Invalid creative asset');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PNG effects and real sound use separate bounded inputs, original dialogue drives ducking, subtitles remain on top', () => {
    const limits = creativeSettings({ filters: true, soundEffects: true, variety: true });
    const assets = { picture: { kind: 'sticker' }, laugh: { kind: 'sound', sampleStart: 2, sampleSeconds: 1.8 } };
    const moments = validateMoments({ moments: [{ start: 3, end: 7, speechIds: ['S1'], reason: 'reaction' }] },
        [{ id: 'S1', start: 2, end: 6 }], 60, limits);
    const plan = validateCreativePlan({ effects: [{ momentId: 'M1', frameIds: ['M1F0', 'M1F1', 'M1F2'], visualConfirmed: true,
        reason: 'comic reaction', sticker: { id: 'picture', x: .2, y: .4, width: .25, motion: 'slide', clearOfSubject: true },
        sound: { id: 'laugh', offsetSeconds: .5, levelDb: -10 }, filter: 'cold' }] }, moments, 'source', 60, limits, assets);
    assertRenderPlan(plan, 60, limits, assets);
    const graph = buildCreativeFilter(plan, { width: 640, height: 360 }, 8, 68, 'subtitle.ass', 'symbol.ass', {
        '0:sticker': { inputIndex: 1, asset: assets.picture }, '0:sound': { inputIndex: 2, asset: assets.laugh } });
    expect(graph).toContain('[1:v:0]loop=');
    expect(graph).toContain('[2:a:0]atrim=start=2:duration=1.8');
    expect(graph).toContain('adelay=3500:all=1');
    expect(graph).toContain('[accents][voice]sidechaincompress');
    expect(graph).toContain('[original][ducked]amix');
    expect(graph.lastIndexOf('overlay=')).toBeLessThan(graph.indexOf('subtitles='));
    expect(stickerAss(plan, 640, 360)).not.toContain('undefined');
    expect(() => assertRenderPlan(plan, 60, limits, {})).toThrow('sticker');
    plan.effects[0].sound.offsetSeconds = 8;
    expect(() => assertRenderPlan(plan, 60, limits, assets)).toThrow('sound');
});

test('millisecond clip endpoints survive floating-point subtraction without extending the source', () => {
    const duration = 1638.184 - 1428.74;
    const moments = validateMoments({ moments: [{ start: 204.799, end: 209.444, speechIds: ['S440'], reason: 'closing reaction' }] },
        [{ id: 'S440', start: 207, end: duration }], duration, creativeSettings({}));
    expect(moments[0].end).toBe(duration);
    expect(moments[0].end).toBeLessThanOrEqual(duration);
});

test('variety review rejects a sequence of zoom-only events while preserving the original conservative mode', () => {
    const plan = { version: 2, workflow: 'creative', duration: 60, effects: [2, 12].map(start =>
        ({ start, end: start + 2, zoom: { scale: 1.2, x: .5, y: .4 } })) };
    expect(() => assertRenderPlan(plan, 60, { variety: true })).toThrow('zoom-only');
    expect(() => assertRenderPlan(plan, 60, { variety: false })).not.toThrow();
});
