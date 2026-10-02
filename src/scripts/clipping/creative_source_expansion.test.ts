export {};
const fs = require('fs'), os = require('os'), path = require('path'), sharp = require('sharp');
const { runCreativeEnhancement } = require('./creative_runner');
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { normalizePlan } = require('./topic_edit_plan');
const { srtText } = require('./creative_timeline');

const profile = { kind: 'story', tone: 'neutral', density: 'light', preserveContinuity: false,
    music: 'none', laughter: false, reason: '完整保留故事和收束' };

test.each(['tail', 'opening', 'twice', 'final_qa', 'in_window_repair', 'final_in_window', 'many_requirements', 'structured_qa', 'boundary_repaired', 'boundary_rejected', 'boundary_unknown', 'spillover', 'resumed', 'final_rejected', 'render_failed', 'source_changed', 'exhausted'])(
    'source expansion %s rebuilds from the recording and repeats every gate without changing the ordinary clip', async outcome => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-expansion-'));
        const source = { mediaPath: path.join(dir, 'source.mp4') }, sourceSrt = path.join(dir, 'source.srt');
        const rows = [
            { start: 90, end: 94, text: '窗外的必要提问' },
            { start: 100, end: 104, text: '原字幕中的疑词' },
            { start: 105, end: 107, text: '可删除的无关等待' },
            { start: 108, end: 112, text: '闻到那个味道也很' },
            { start: 112.3, end: 115, text: '难抗拒' },
            { start: 118, end: 120, text: '第一次完整收束' },
            { start: 124, end: 128, text: '后来还有一次尝试' },
            { start: 130, end: 134, text: '最后才真的收束' },
            { start: 138, end: 140, text: '已经转到另一个话题' },
            { start: 180, end: 184, text: '窗外后续的必要澄清' },
            { start: 220, end: 224, text: '更后的真实回应' }
        ];
        if (outcome === 'many_requirements') rows.splice(9, 0, ...Array.from({ length: 33 }, (_, i) => ({
            start: 140.2 + i * .1, end: 140.27 + i * .1, text: `必须保留的后续原话${i + 1}`
        })));
        const output = { mediaPath: path.join(dir, 'clip.mp4'), srtPath: path.join(dir, 'clip.srt'),
            metadataPath: path.join(dir, 'clip.json'), coverPath: path.join(dir, 'cover.jpg'), burnedSubtitles: true };
        const jpeg = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#325575' } }).jpeg().toBuffer();
        fs.writeFileSync(source.mediaPath, 'recording'); fs.writeFileSync(sourceSrt, srtText(rows));
        fs.writeFileSync(output.mediaPath, 'ordinary video'); fs.writeFileSync(output.coverPath, jpeg);
        const approved = rows.slice(1, 4).map((c, i) => ({ ...c, start: c.start - 100, end: c.end - 100,
            text: i === 0 ? '用户已确认的字词' : c.text }));
        fs.writeFileSync(output.srtPath, srtText(approved));
        const baseline = { window: { start: 100, end: 112, duration: 12, index: 1 }, output, uploadReady: true,
            copy: { title: '夜跑进夜市', coverText: '带着食物回家', description: '闻到食物很难抗拒' },
            precisionExperiment: { selected: true } };
        const evidence = buildSubtitleEvidence(rows, { groupSegments: false });
        const topicEditPlan = normalizePlan({ ranges: ['keep', 'drop', 'keep'].map((action, index) => ({
            startCueId: `G${index + 2}`, endCueId: `G${index + 2}`, action,
            role: index === 2 ? 'closing' : 'setup', reason: '保持原选材的必留和删减约束'
        })), continuation: 'next_topic', nextCueId: 'G5', closingReason: '旧窗口误认为已经完整'
        }, { start: 100, end: 112, endCueId: 'G4' }, evidence);
        let currentDuration = 12, sourceAttempt = 0;
        const stages: string[] = [];
        const context: any = { config: { ai: { topicContextSeconds: 45 }, enhancements: { creative: { style: 'compact' },
            stages: { edit: { model: 'editor' }, qa: { model: 'reviewer' } }, budget: {} } },
            parsed: { segments: rows }, info: {}, source, options: { srtPath: sourceSrt }, danmaku: [],
            clip: { start: 100, end: 112, topicEditPlan }, subtitleEvidence: evidence,
            execution: { withMedia: jest.fn(work => work({ mode: 'idle', ffmpegThreads: 4 })) },
            topic: {
                parseTopicSrt: file => require('../asr/asr_backends').parseSrt(file),
                calculateSubtitleStyle: require('../topic_clipper').calculateSubtitleStyle,
                buildBurnAssContentFromSrt: require('../topic_clipper').buildBurnAssContentFromSrt,
                getVideoResolution: async () => ({ width: 1920, height: 1080 }), resolveFfprobePath: () => 'ffprobe',
                cutClipMedia: jest.fn(async (input, window, srt, target, config) => {
                    expect(input.mediaPath).toBe(source.mediaPath);
                    if (!config.creativePlan && outcome === 'render_failed') throw new Error('expansion encoder failed');
                    currentDuration = config.creativePlan?.timeline?.duration ?? window.end - window.start;
                    fs.writeFileSync(target, 'rendered');
                    return { burnedSubtitles: true, creativeEffectsApplied: config.creativePlan?.effects.length || 0 };
                }),
                runFfmpeg: jest.fn(async args => {
                    if (args.at(-1).endsWith('.jpg')) fs.writeFileSync(args.at(-1), jpeg);
                    if (args.at(-1).endsWith('.pcm')) {
                        const samples = new Float32Array(Math.round(currentDuration * 16000 * 2));
                        for (let i = 0; i < samples.length; i++) samples[i] = .1 * Math.sin(i / 2 * .07);
                        fs.writeFileSync(args.at(-1), Buffer.from(samples.buffer));
                    }
                }),
                generateClipCover: async (_video, _text, _dir, opts) => { fs.writeFileSync(opts.outputPath, jpeg); return opts.outputPath; }
            } };
        if (outcome === 'resumed') {
            const resume = path.join(dir, 'previous'), scratch = path.join(resume, 'temp', 'clip-creative');
            fs.mkdirSync(scratch, { recursive: true });
            fs.writeFileSync(path.join(resume, 'clip.json'), JSON.stringify({ window: baseline.window, editorialProfile: profile }));
            fs.writeFileSync(path.join(scratch, 'story-response.json'), JSON.stringify({ text: JSON.stringify({ profile, keep: [
                { fromCue: 'C1', toCue: 'C1', role: 'setup', reason: '原起因' },
                { fromCue: 'C3', toCue: 'C3', role: 'closing', reason: '旧结尾' }
            ] }) }));
            context.options.creativeResumeDirectory = resume;
        }
        const dependencies = { probeMedia: async () => ({ format: { duration: currentDuration }, streams: [
            { codec_type: 'video', start_time: 0 }, { codec_type: 'audio', start_time: 0 }] }),
            requestStage: jest.fn(async (config, _budget, _info, phase, prompt) => {
                const stage = phase.replace(/^creative-/, '').replace(/-review-\d+$/, '').replace(/-1(?:-source-\d+)?$/, ''); stages.push(stage);
                let value;
                if (stage.endsWith('-source-requirements')) {
                    value = { requirements: [{ cueIds: [outcome === 'final_in_window' || outcome === 'in_window_repair' && sourceAttempt ? 'R6'
                        : sourceAttempt >= 2 ? 'R11' : sourceAttempt ? 'R10' : 'R5'], reason: '定位审核缺少的真实原话' }] };
                } else if (stage === 'source-expand-qa') {
                    expect(config.model).toBe('reviewer');
                    const reject = ['boundary_rejected', 'boundary_unknown'].includes(outcome)
                        || outcome === 'boundary_repaired' && stages.filter(s => s === stage).length === 1;
                    value = { approved: !reject, issues: reject ? ['缺少必要起因或后续回应'] : [],
                        requiredStartCueId: outcome === 'boundary_repaired' && reject ? 'R1' : '',
                        requiredEndCueId: outcome === 'boundary_unknown' ? 'R999' : '' };
                } else if (stage.startsWith('source-expand')) {
                    sourceAttempt++;
                    expect(prompt).toContain('难抗拒');
                    value = { expansions: [{ startCueId: outcome === 'opening' ? 'R1' : '',
                        endCueId: sourceAttempt > 1 ? 'R10' : 'R6',
                        requiredCueIds: ['R5'], reason: '把窗外完整收束纳入新素材' }] };
                    if (outcome === 'source_changed') fs.appendFileSync(sourceSrt, 'changed');
                } else if (['story-qa', 'story-qa-final'].includes(stage)) {
                    expect(config.model).toBe('reviewer');
                    const needs = sourceAttempt === 0 && outcome !== 'final_qa'
                        || sourceAttempt === 1 && outcome === 'twice' || outcome === 'exhausted'
                        || sourceAttempt === 1 && outcome === 'in_window_repair' && stage === 'story-qa';
                    value = { approved: !needs, needsSourceExpansion: needs,
                        issues: needs ? ['结尾截在也很，必须扩展原录播以保留难抗拒和后续收束'] : [] };
                    if (needs && outcome === 'many_requirements') value.requiredSourceCueIds = Array.from({ length: 38 }, (_, i) => `R${i + 5}`);
                    if (needs && outcome === 'structured_qa') value.issues = [{ position: '片尾', issue: '必要后半句在窗外，需扩展素材' }];
                } else if (stage.startsWith('story')) {
                    const offset = ['opening', 'boundary_repaired'].includes(outcome) && sourceAttempt ? 1 : 0;
                    value = { profile, keep: [
                        { fromCue: 'C1', toCue: `C${1 + offset}`, role: 'setup', reason: '保留起因和确认词' },
                        { fromCue: `C${3 + offset}`, toCue: `C${outcome === 'many_requirements' && sourceAttempt ? 41 : sourceAttempt > 1 ? 9 : sourceAttempt
                            ? outcome === 'in_window_repair' && stage === 'story' ? 4 : 5 + offset : 3}`,
                            role: 'closing', reason: '保留完整后续与结尾' }
                    ] };
                } else if (stage === 'moments') value = { moments: [] };
                else if (stage === 'visual-plan') value = { effects: [] };
                else if (stage === 'qa-repair') value = { repairs: [] };
                else {
                    const needs = outcome === 'final_qa' && !sourceAttempt
                        || outcome === 'final_in_window' && stages.filter(s => s === 'qa').length === 1;
                    value = { approved: !needs && outcome !== 'final_rejected', needsSourceExpansion: needs,
                        checks: { meaning: !needs, focus: true, subtitles: true, restraint: true, impact: true },
                        issues: needs ? ['成片结尾缺少窗外的完整回答'] : outcome === 'final_rejected' ? ['成片内容仍不完整'] : [] };
                }
                return { text: JSON.stringify(value), meta: {} };
            }) };
        try {
            const result = await runCreativeEnhancement(baseline, context, dependencies);
            const failed = ['boundary_rejected', 'boundary_unknown', 'final_rejected', 'render_failed', 'source_changed', 'exhausted'].includes(outcome);
            expect(result.creativeResult.status).toBe(failed ? 'kept_original' : 'edited');
            expect(result.enhancement.baseline.mediaPath).toBe(output.mediaPath);
            expect(fs.readFileSync(output.mediaPath, 'utf8')).toBe('ordinary video');
            expect(fs.readFileSync(output.srtPath, 'utf8')).toBe(srtText(approved));
            if (['source_changed', 'boundary_rejected', 'boundary_unknown'].includes(outcome)) expect(context.execution.withMedia).not.toHaveBeenCalled();
            else expect(context.execution.withMedia).toHaveBeenCalled();
            if (failed) {
                expect(result.window).toEqual(baseline.window); expect(result.output).toEqual(output);
                expect(result.copy).toEqual(baseline.copy);
                if (outcome === 'final_rejected') expect(result.creativeResult.reason).toContain('成片内容仍不完整');
                if (outcome === 'render_failed') expect(result.creativeResult.reason).toContain('expansion encoder failed');
                if (outcome === 'source_changed') expect(result.creativeResult.reason).toContain('changed');
                if (outcome === 'exhausted') expect(sourceAttempt).toBe(2);
            } else {
                expect(result.qaResult.status).toBe('passed');
                expect(result.window.end).toBe(outcome === 'many_requirements' ? 146.47 : sourceAttempt > 1 ? 187 : 143);
                expect(result.window.start).toBe(['opening', 'boundary_repaired'].includes(outcome) ? 89.88 : 100);
                const text = fs.readFileSync(result.output.srtPath, 'utf8');
                expect(text).toContain('用户已确认的字词'); expect(text).toContain('难抗拒');
                expect(text).not.toContain('可删除的无关等待'); expect(text).not.toContain('原字幕中的疑词');
                expect(result.sourceExpansion.attempts).toHaveLength(outcome === 'twice' ? 2 : 1);
                expect(stages.filter(stage => stage === 'story-qa')).toHaveLength(sourceAttempt + 1 + (outcome === 'final_in_window' ? 1 : 0));
                expect(stages.filter(stage => stage === 'qa')).toHaveLength(['final_qa', 'final_in_window'].includes(outcome) ? 2 : 1);
                expect(context.topic.cutClipMedia.mock.calls.some(call => !call[4].creativePlan)).toBe(true);
                if (outcome === 'structured_qa') expect(result.creativeResult.history.find(r => r.stage === 'source_window_incomplete').qa.issues[0]).toContain('片尾');
                if (outcome === 'spillover') {
                    expect(result.editPlan.keep.at(-1).end).toBe(123);
                    expect(text).not.toContain('最后才真的收束');
                }
                if (outcome === 'resumed') {
                    const reused = result.enhancement.generationLogs.filter(row => row.status === 'reused_draft');
                    expect(reused).toHaveLength(1); expect(reused[0]).toMatchObject({ stage: 'story', sourceAttempt: 0 });
                }
                if (outcome === 'boundary_repaired') {
                    expect(sourceAttempt).toBe(1);
                    expect(result.sourceExpansion.attempts[0].boundaryQa.history).toHaveLength(1);
                    expect(stages.filter(s => s === 'source-expand-qa')).toHaveLength(2);
                    expect(result.editPlan.keep.at(-1).end).toBe(123);
                }
                if (outcome === 'in_window_repair') {
                    expect(stages).toContain('story-qa-repair'); expect(stages).toContain('story-qa-final');
                    expect(result.sourceExpansion.attempts).toHaveLength(1);
                    expect(result.creativeResult.history.some(row => row.stage === 'source_requirement_route'
                        && row.qa.reportedNeedsSourceExpansion && !row.qa.needsSourceExpansion)).toBe(true);
                }
                if (outcome === 'final_in_window') {
                    expect(stages.filter(s => s === 'story')).toHaveLength(3);
                    expect(result.creativeResult.history.some(row => row.stage === 'final_story_repair')).toBe(true);
                    expect(result.sourceExpansion.attempts).toHaveLength(1);
                }
            }
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

test.each(['unknown', 'inward', 'noop', 'outside_context', 'required_outside'])(
    'source expansion rejects %s boundary evidence', outcome => {
        const { expandedWindow, sourceCues } = require('./creative_source_expansion');
        const cues = sourceCues([{ start: 90, end: 94, text: '起因' }, { start: 100, end: 112, text: '原片' },
            { start: 120, end: 124, text: '完整收束' }, { start: 400, end: 410, text: '遥远的另一件事' }]);
        const plan = { startCueId: '', endCueId: 'R3', requiredCueIds: [], reason: '补全结尾' };
        if (outcome === 'unknown') plan.endCueId = 'R999';
        if (outcome === 'inward') plan.endCueId = 'R2';
        if (outcome === 'noop') plan.endCueId = '';
        if (outcome === 'outside_context') plan.endCueId = 'R4';
        if (outcome === 'required_outside') plan.requiredCueIds = ['R4'];
        expect(() => expandedWindow(plan, cues, { start: 100, end: 112 }, 180)).toThrow();
    });

test('extending a clamped edge cue preserves its approved words while restoring its full source duration', () => {
    const { expandedSubtitles, sourceCues } = require('./creative_source_expansion');
    const rows = sourceCues([{ start: 98, end: 104, text: '原来识别错了' }, { start: 108, end: 116, text: '旧片截断的长句' },
        { start: 118, end: 120, text: '必要后续' }]);
    const approved = [{ start: 0, end: 4, text: '用户改正过的开头' }, { start: 8, end: 12, text: '用户改正过的结尾' }];
    const result = expandedSubtitles(rows, approved, { start: 100, end: 112 }, { start: 98, end: 120 });
    expect(result.map(c => c.text)).toEqual(['用户改正过的开头', '用户改正过的结尾', '必要后续']);
    expect(result[0]).toMatchObject({ start: 0, end: 6 });
    expect(result[1]).toMatchObject({ start: 10, end: 18 });
    expect(() => expandedSubtitles(rows, [{ ...approved[0], start: 1 }, approved[1]],
        { start: 100, end: 112 }, { start: 98, end: 120 })).toThrow('approved subtitle words');
});

test('structured QA issues keep their location and quoted defect without granting approval', () => {
    const { normalizeCreativeQa } = require('./creative_source_expansion');
    const issue = { position: '片尾 323.761–324.761 秒', issue: '止于我来搜索，下一句才是搜索一下' };
    const qa = normalizeCreativeQa({ approved: false, needsSourceExpansion: true, issues: [issue] });
    expect(qa.approved).toBe(false); expect(qa.needsSourceExpansion).toBe(true);
    expect(JSON.parse(qa.issues[0])).toEqual(issue);
    expect(() => normalizeCreativeQa({ approved: false, issues: [{ position: '片尾' }] })).toThrow('Invalid creative QA issue');
    expect(() => normalizeCreativeQa({ approved: false, issues: [null] })).toThrow('Invalid creative QA issue');
});
