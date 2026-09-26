export {};
const fs = require('fs'), os = require('os'), path = require('path'), sharp = require('sharp');
const { runCreativeEnhancement } = require('./creative_runner');

test.each(['passed', 'qa_rejected', 'render_failed', 'source_changed', 'sound_plan', 'crop_repaired', 'crop_still_unsafe', 'many_moments', 'tutorial', 'performance', 'spatial_repaired', 'spatial_repair_twice', 'cover_protected', 'cover_allowed', 'cover_allowed_qa_rejected', 'visual_qa_repaired', 'visual_qa_persistent'])('creative pipeline %s binds the final artifact or returns the exact ordinary media/copy', async outcome => {
    const profileCase = ['tutorial', 'performance'].includes(outcome);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-runner-'));
    const sourcePath = path.join(dir, 'source.mp4'), sourceSrt = path.join(dir, 'source.srt');
    const output = { mediaPath: path.join(dir, 'clip.mp4'), srtPath: path.join(dir, 'clip.srt'),
        coverPath: path.join(dir, 'clip.jpg'), metadataPath: path.join(dir, 'clip.json'), burnedSubtitles: true };
    const jpeg = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#325575' } }).jpeg().toBuffer();
    for (const file of [sourcePath, sourceSrt, output.mediaPath, output.srtPath]) fs.writeFileSync(file, 'fixture');
    fs.writeFileSync(output.coverPath, jpeg);
    const original = { uploadReady: true, window: { start: 100, end: 160, duration: 60, index: 2 },
        copy: { title: '发现画面中的重点', coverText: '看这里', description: '这里有东西' }, output,
        precisionExperiment: { selected: true, reason: '具体反应' } };
    const context: any = { config: { enhancements: { creative: { soundEffects: true, filters: true }, stageDefaults: { maxTokens: 8000 }, budget: {} } },
        info: { roomId: 'room' }, parsed: { segments: [{ start: 101, end: 106, text: '等一下，这里有东西' }] }, danmaku: [],
        source: { kind: 'video', mediaPath: sourcePath }, options: { srtPath: sourceSrt }, clip: {}, subtitleEvidence: {},
        topic: {
            calculateSubtitleStyle: require('../topic_clipper').calculateSubtitleStyle,
            buildBurnAssContentFromSrt: require('../topic_clipper').buildBurnAssContentFromSrt,
            runFfmpeg: jest.fn(async args => {
                if (args.at(-1).endsWith('.jpg')) fs.writeFileSync(args.at(-1), jpeg);
                if (args.at(-1).endsWith('.pcm')) {
                    const samples = new Float32Array(60 * 16000 * 2), rendered = args.at(-1).includes('audio-rendered');
                    for (let i = 0; i < samples.length; i++) {
                        const t = Math.floor(i / 2) / 16000;
                        samples[i] = .1 * Math.sin(2 * Math.PI * 200 * t) + (rendered && t >= 5.2 && t < 7 ? .015 * Math.sin(2 * Math.PI * 900 * t) : 0);
                    }
                    fs.writeFileSync(args.at(-1), Buffer.from(samples.buffer));
                }
            }),
            cutClipMedia: jest.fn(async (_source, window, srt, target, options) => {
                if (outcome === 'render_failed') throw new Error('encoder unavailable');
                expect(window).toEqual(original.window);
                if (profileCase) { expect(srt).toContain('.edited.srt'); expect(options.creativePlan.music).toBeUndefined(); }
                else expect(srt).toBe(output.srtPath);
                expect(options.creativePlan.effects).toHaveLength(outcome === 'many_moments' ? 8 : 1);
                if (outcome === 'crop_repaired') {
                    expect(options.creativePlan.effects[0].zoom).toBeUndefined();
                    expect(options.creativePlan.effects[0].filter).toBe('monochrome');
                }
                if (outcome === 'sound_plan') expect(options.creativePlan.effects[0].sound).toEqual({ id: 'audience_laugh', offsetSeconds: 2.2, levelDb: -8 });
                fs.writeFileSync(target, 'edited artifact'); return { path: target, burnedSubtitles: true, creativeEffectsApplied: 1 };
            }),
            generateClipCover: jest.fn(async (_video, _copy, _dir, options) => { fs.writeFileSync(options.outputPath, jpeg); return options.outputPath; }),
            resolveFfprobePath: () => 'ffprobe',
            getVideoResolution: jest.fn(async () => ({ width: 1920, height: 1080 }))
        } };
    if (outcome === 'sound_plan') {
        const bytes = Buffer.from('fixture audio'), assetManifest = path.join(dir, 'assets.json');
        fs.writeFileSync(path.join(dir, 'laugh.wav'), bytes);
        fs.writeFileSync(assetManifest, JSON.stringify({ version: 1, cacheDirectory: dir, assets: [{
            id: 'audience_laugh', kind: 'sound', file: 'laugh.wav', label: 'laugh', usage: 'reaction',
            sha256: require('crypto').createHash('sha256').update(bytes).digest('hex'), creator: 'fixture', license: 'fixture',
            sourceUrl: 'https://example.test/source', licenseUrl: 'https://example.test/license', downloadUrl: 'https://example.test/laugh.wav', sampleStart: 0, sampleSeconds: 1.8
        }] }));
        context.config.enhancements.creative = { soundEffects: true, variety: true, assetManifest };
    }
    if (outcome === 'many_moments') {
        context.config.enhancements.creative.maxMoments = 8;
        context.parsed.segments[0].end = 159;
    }
    const spatialCase = outcome.startsWith('spatial_');
    if (spatialCase) context.config.enhancements.creative.focusPlacement = 'source';
    const coverCase = outcome.startsWith('cover_'), coverAllowed = outcome.startsWith('cover_allowed');
    if (coverCase) Object.assign(context.config.enhancements.creative, { focusPlacement: 'source', faceInsetDiameter: .6, allowCoverFaceOverlap: coverAllowed });
    if (profileCase) {
        context.config.enhancements.creative.style = 'compact';
        context.parsed.segments = [{ start: 100, end: 160, text: '完整的说明或表演内容' }];
        context.topic.parseTopicSrt = () => ({ segments: [{ start: 0, end: 60, text: '完整的说明或表演内容' }] });
        context.subtitleEvidence = { byId: new Map() };
        if (outcome === 'tutorial') {
            const cache = path.join(dir, 'previous'), scratch = path.join(cache, 'temp', 'clip-creative');
            fs.mkdirSync(scratch, { recursive: true });
            const profile = { kind: 'tutorial', tone: 'neutral', density: 'light', preserveContinuity: false, music: 'none', laughter: false, reason: '讲解步骤' };
            const draft = { profile, keep: [{ fromCue: 'C1', toCue: 'C1', role: 'explanation', reason: '完整说明' }] };
            const timeline = require('./creative_timeline').validateStoryPlan(draft, [{ id: 'C1', start: 0, end: 60, text: '完整的说明或表演内容' }], 60, [], profile);
            fs.writeFileSync(path.join(cache, 'clip.json'), JSON.stringify({ qaResult: { status: 'passed' },
                editorialProfile: { ...profile, tone: 'comic', music: 'playful', laughter: true }, creativePlan: { timeline },
                creativeResult: { history: [{ stage: 'story', timeline, qa: { approved: true, issues: [] } }] } }));
            fs.writeFileSync(path.join(scratch, 'story-response.json'), JSON.stringify({ text: JSON.stringify(draft) }));
            context.options.creativeResumeDirectory = cache;
        }
    }
    const stages: string[] = [];
    const dependencies = {
        requestStage: jest.fn(async (_config, _budget, info, phase, prompt, images) => {
            stages.push(phase);
            let value;
            if (phase.includes('story-qa')) value = { approved: true, issues: [] };
            else if (phase.includes('story')) value = { profile: { kind: outcome, tone: 'neutral', density: 'light', preserveContinuity: outcome === 'performance',
                music: 'none', laughter: false, reason: '保留完整内容' }, keep: [{ fromCue: 'C1', toCue: 'C1', role: outcome === 'performance' ? 'performance' : 'explanation', reason: '完整说明' }] };
            else if (phase.includes('moments')) {
                expect(info.outputContract.key).toBe('moments');
                value = { moments: outcome === 'many_moments' ? Array.from({ length: 8 }, (_, i) =>
                    ({ start: 3 + i * 6, end: 4.5 + i * 6, speechIds: ['S1'], reason: '发现重点' }))
                    : [{ start: 3, end: 5, speechIds: ['S1'], reason: '发现重点' }] };
            } else if (phase.includes('visual-plan')) {
                const cropCase = ['crop_repaired', 'crop_still_unsafe'].includes(outcome);
                const repair = phase.includes('repair');
                if (cropCase && repair) {
                    expect(prompt).toContain('M1.zoom.safeToCrop');
                    expect(prompt).toContain('zoom=null');
                }
                value = { effects: [{ momentId: 'M1', frameIds: ['M1F0', 'M1F1', 'M1F2'], visualConfirmed: true,
                    reason: '三帧清楚显示重点', filter: cropCase || outcome.startsWith('visual_qa_') ? 'monochrome' : null,
                    zoom: outcome === 'crop_repaired' && repair ? null
                        : { scale: 1.3, x: .5, y: .4, target: 'detail', safeToCrop: !cropCase } }] };
                if (outcome === 'many_moments') {
                    expect(images).toHaveLength(2);
                    value.effects = Array.from({ length: 8 }, (_, i) => ({ ...value.effects[0], momentId: `M${i + 1}`,
                        frameIds: [0, 1, 2].map(n => `M${i + 1}F${n}`) }));
                }
                if (profileCase) value.effects[0] = { momentId: 'M1', frameIds: ['M1F0', 'M1F1', 'M1F2'], visualConfirmed: true, reason: '关键细节保持上下文',
                    focusInset: { target: outcome === 'tutorial' ? 'chat' : 'detail', shape: 'rectangle', placement: 'source',
                        sourceBox: { x: .2, y: .2, width: .2, height: .1 }, magnification: 1.5, clearOfAction: true } };
                if (spatialCase) {
                    if (repair) {
                        expect(prompt).toContain('M1: Focus leaves no readable subtitle area');
                        expect(context.topic.cutClipMedia).not.toHaveBeenCalled();
                    }
                    value.effects[0].zoom = null;
                    value.effects[0].filter = 'monochrome';
                    if (!repair || (outcome === 'spatial_repair_twice' && !phase.includes('repair-2-'))) {
                        value.effects[0].focusInset = { target: 'person', shape: 'rectangle', placement: 'source',
                            sourceBox: { x: .3, y: .25, width: .4, height: .4 }, magnification: 2, clearOfAction: true };
                    }
                }
                if (coverCase) {
                    value.effects[0].zoom = null;
                    value.effects[0].faceInset = { sourceBox: { x: .75, y: .8, width: .1, height: .17 },
                        placement: 'source', diameter: .4, clearOfAction: true };
                }
            }
            else if (phase.includes('sound-plan')) value = { sounds: [{ momentId: 'M1', id: 'audience_laugh', offsetSeconds: 2.2, levelDb: -8 }] };
            else if (phase.includes('qa-repair')) {
                expect(prompt).toContain('滤镜语气不协调');
                value = { repairs: [{ momentId: 'M1', remove: ['filter'] }] };
            }
            else {
                if (coverCase) {
                    expect(prompt.includes('用户已明确接受本次封面文字遮挡人脸')).toBe(coverAllowed);
                    const coverOptions = context.topic.generateClipCover.mock.calls[0][3];
                    expect(coverOptions.protectedBoxes).toHaveLength(coverAllowed ? 0 : 1);
                    expect(coverOptions.protectSubtitleBand).toBe(true);
                }
                if (outcome === 'many_moments') expect(images).toHaveLength(3);
                if (outcome === 'source_changed') fs.appendFileSync(sourceSrt, 'changed');
                value = { approved: !outcome.endsWith('qa_rejected'), checks: { meaning: true, focus: true, subtitles: true, restraint: true, impact: true }, issues: [] };
                if (outcome.startsWith('visual_qa_') && (!phase.includes('qa-final') || outcome === 'visual_qa_persistent')) {
                    value.approved = false; value.checks.restraint = false; value.issues = ['滤镜语气不协调'];
                }
            }
            return { text: JSON.stringify(value), meta: { ledgerId: 'id', usage: { input_tokens: 100 }, elapsedMs: 10 } };
        }),
        probeMedia: jest.fn(async () => ({ format: { duration: 60 }, streams: [
            { codec_type: 'video', start_time: 0 }, { codec_type: 'audio', start_time: 0 }] }))
    };
    try {
        const result = await runCreativeEnhancement(original, context, dependencies);
        if (outcome.startsWith('visual_qa_')) expect(result.creativeResult.history.filter(row => row.stage === 'error')).toEqual([]);
        if (spatialCase || ['passed', 'sound_plan', 'crop_repaired', 'many_moments', 'tutorial', 'performance', 'cover_allowed', 'cover_protected', 'visual_qa_repaired'].includes(outcome)) {
            expect(result.creativeResult.status).toBe('edited'); expect(result.qaResult.status).toBe('passed');
            expect(result.qaResult.digests.video).toMatch(/^[a-f0-9]{64}$/);
            expect(result.editPlan.removed).toEqual([]);
            expect(result.output.mediaPath).toContain('.creative.mp4');
            expect(result.copy.description).toContain('精切实验模式');
        } else {
            expect(result.creativeResult.status).toBe('kept_original'); expect(result.precisionExperiment.selected).toBe(false);
            expect(result.copy).toEqual(original.copy); expect(result.output).toEqual(original.output);
            expect(result.qaRequired).toBeUndefined();
        }
        expect(result.uploadReady).toBe(true);
        expect(fs.readFileSync(output.mediaPath, 'utf8')).toBe('fixture');
        if (profileCase) {
            expect(result.output.srtPath).toContain('.edited.srt'); expect(result.editorialProfile.kind).toBe(outcome);
            expect(result.creativePlan.music).toBeUndefined(); expect(result.creativePlan.effects.every(row => !row.sound)).toBe(true);
        } else expect(result.output.srtPath).toBe(output.srtPath);
        if (outcome === 'crop_still_unsafe') {
            expect(result.creativeResult.reason).toContain('M1.zoom.safeToCrop');
            expect(context.topic.cutClipMedia).not.toHaveBeenCalled();
        }
        if (outcome === 'tutorial') expect(stages.some(stage => stage.includes('story-qa'))).toBe(true);
        if (outcome.startsWith('visual_qa_')) {
            expect(context.topic.cutClipMedia).toHaveBeenCalledTimes(2);
            expect(dependencies.probeMedia).toHaveBeenCalledTimes(2);
            expect(context.topic.cutClipMedia.mock.calls[1][4].creativePlan.effects[0].filter).toBeUndefined();
            expect(context.topic.cutClipMedia.mock.calls[1][4].creativePlan.effects[0].zoom).toBeDefined();
            expect(result.creativeResult.history.filter(row => row.stage === 'qa')).toHaveLength(2);
        }
        expect(stages).toHaveLength(outcome.startsWith('visual_qa_') ? 5 : spatialCase ? outcome === 'spatial_repair_twice' ? 5 : 4 : outcome === 'tutorial' ? 4 : profileCase ? 5 : outcome === 'render_failed' ? 2 : ['sound_plan', 'crop_repaired', 'crop_still_unsafe'].includes(outcome) ? 4 : 3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 15000);
