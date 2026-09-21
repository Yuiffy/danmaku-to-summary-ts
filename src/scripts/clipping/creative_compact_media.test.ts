export {};
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const topic = require('../topic_clipper');
const { audioTimelineFilter } = require('./creative_timeline');
const { analyzeCreativeAudio } = require('./creative_audio_audit');
const realMedia = process.env.DANMAKU_TEST_REAL_MEDIA === '1' ? test : test.skip;

realMedia('compact multi-cut mix keeps original dialogue level and adds audible normalized accents plus music', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-media-'));
    const config = require('../own_stream_clipper').getOwnStreamClipsConfig(require('../config-loader').getConfig());
    const source = path.join(dir, 'source.mp4'), base = path.join(dir, 'base.mp4'), output = path.join(dir, 'edited.mp4');
    const srt = path.join(dir, 'caption.srt'), accent = path.join(dir, 'accent.wav');
    const window = { start: 0, end: 12, duration: 12 };
    try {
        fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\nTest caption\n');
        await topic.runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=12', '-f', 'lavfi', '-i',
            'sine=frequency=230:sample_rate=48000:duration=12', '-c:v', config.subtitleVideoEncoder, '-c:a', 'aac', source], config);
        await topic.runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=710:sample_rate=48000:duration=2', accent], config);
        const music = require('./creative_music').createPlayfulMusic(dir);
        const assets = { [music.id]: music, accent: { id: 'accent', kind: 'sound', filePath: accent, sampleStart: 0, sampleSeconds: 1.8,
            sha256: crypto.createHash('sha256').update(fs.readFileSync(accent)).digest('hex') } };
        const timeline = { version: 1, sourceDuration: 12, duration: 6.26,
            keep: [{ start: 0, end: 2.22 }, { start: 5.18, end: 7.22 }, { start: 10, end: 12 }] };
        const plan = require('./creative_layout').anchorSpatialPlan({ version: 2, style: 'compact', workflow: 'creative', duration: 6.26, timeline,
            music: { id: music.id, levelDb: -27 }, effects: [{ start: .2, end: 2, sound: { id: 'accent', offsetSeconds: .2, levelDb: -3 },
                faceInset: { sourceBox: { x: .75, y: .80, width: .1, height: .17 }, placement: 'source', diameter: .4, clearOfAction: true },
                sticker: { id: 'question', x: .18, y: .2, width: .14, motion: 'pop' } },
                { start: 2.3, end: 3.7, focusInset: { target: 'detail', shape: 'rectangle', placement: 'source', sourceBox: { x: .1, y: .1, width: .18, height: .1 }, magnification: 1.8, clearOfAction: true } },
                { start: 4, end: 5.5, zoom: { target: 'detail', scale: 2, x: .3, y: .3 },
                    faceInset: { mode: 'retain', placement: 'source', sourceBox: { x: .75, y: .80, width: .1, height: .17 }, clearOfAction: true } }] },
            { width: 640, height: 360 }, { focusPlacement: 'source', faceInsetDiameter: .6 }, assets);
        await topic.cutClipMedia({ kind: 'video', mediaPath: source }, window, srt, base, config);
        await topic.cutClipMedia({ kind: 'video', mediaPath: source }, window, srt, output, { ...config,
            creativePlan: plan, creativeAssets: assets, creativeSettings: { style: 'compact', soundEffects: true } });
        for (const [i, file] of [base, output].entries()) await topic.runFfmpeg(['-v', 'error', '-y', '-i', file,
            ...(i === 0 ? ['-filter_complex', audioTimelineFilter(timeline), '-map', '[baseaudio]'] : ['-map', '0:a:0']),
            '-vn', '-ar', '16000', '-ac', '2', '-f', 'f32le', path.join(dir, `${i}.pcm`)], config);
        const audit = analyzeCreativeAudio(fs.readFileSync(path.join(dir, '0.pcm')), fs.readFileSync(path.join(dir, '1.pcm')), plan, assets);
        expect(audit.issues).toEqual([]);
        expect(audit.originalGain).toBeCloseTo(1, 1);
        expect(audit.effects[0].relativeDb).toBeGreaterThan(-11);
        expect(audit.outsideErrorRms).toBeGreaterThan(.004);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 60000);
