export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const topic = require('../topic_clipper');
const generator = require('../ai_text_generator');
const runtime = require('../workflow-runtime');
const production = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../config/production.json'), 'utf8'));

describe('ambiguous names reach AI preflight without approving ordinary words', () => {
    let dir: string;
    let srt: string;
    let media: string;
    let request: any;
    let mediaGenerator: any;
    const config = { ai: { text: { provider: 'daiYu' } }, clipTopics: {
        enabled: true, keywords: ['岁己', '小岁'], ambiguousRecall: production.clipTopics.ambiguousRecall,
        review: { enabled: true, mode: 'preflight', strategy: 'single', model: 'gpt-6-luna', reasoningEffort: 'high' },
        ai: { selectionCacheEnabled: false }
    } };
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-recall-'));
        srt = path.join(dir, 'source.srt'); media = path.join(dir, 'source.mp4');
        fs.writeFileSync(media, 'mock source');
        fs.writeFileSync(srt, ['1', '00:00:00,000 --> 00:00:10,000', '聊朋友要求消息秒回', '',
            '2', '00:00:11,000 --> 00:00:20,000', '我觉得好震惊然后呢就被随即吐槽', '',
            '3', '00:00:21,000 --> 00:00:40,000', '他说看到了消息就必须要回', '',
            '4', '00:00:41,000 --> 00:01:00,000', '讲完了这次朋友的消息要求', ''].join('\n'));
        request = jest.spyOn(generator, 'generateTextWithDaiYu');
        mediaGenerator = jest.fn(async (_source, _window, _subtitle, output) => {
            fs.writeFileSync(output, 'mock rendered video'); return { path: output, burnedSubtitles: true };
        });
    });
    afterEach(() => { request.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); });

    function respond(verdict: string, support = true, auxiliary = false) {
        request.mockImplementation(async (prompt: string) => {
            const input = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
            expect(input.hits).toHaveLength(auxiliary ? 2 : 1);
            expect(input.hits[0].text).toContain('随即');
            expect(input.hits[0].text).not.toContain('岁己');
            expect(input.hits[0].recall.requiresSemanticConfirmation).toBe(true);
            expect(input.target.possibleAsrForms).not.toContain('随即');
            const ids = support ? ['G2', 'G3'] : ['G2'];
            return { text: JSON.stringify({ hits: input.hits.map((hit, i) => ({ id: hit.id,
                    verdict: i ? 'uncertain' : verdict, reason: '语义判断及上下文依据', evidenceCueIds: i ? [hit.cueId] : ids })),
                clips: verdict === 'false_match' ? [] : [{ id: 'E1-1', status: 'ready', startCueId: 'G1', endCueId: 'G4',
                    hitIds: ['K1'], event: '消息秒回的要求', reason: '朋友的要求与回应', score: 80,
                    extensionReason: '', sourceKind: 'live_speech', evidenceCueIds: ['G1', 'G2', 'G3'],
                    evidenceDanmakuIds: [], warnings: auxiliary ? ['G4疑词保留原文，核心要求由G2、G3支持'] : [], title: '消息秒回的要求', description: '讲述朋友要求消息秒回',
                    coverText: '消息秒回\n朋友吐槽', subtitleEdits: verdict === 'mention' ? [{ cueId: 'G2', original: '随即',
                        replacement: '岁己', reason: '上下文确认人名', evidenceCueIds: ids }] : [] }] }),
                meta: { model: 'gpt-6-luna', attempts: [{ model: 'gpt-6-luna', apiModeUsed: 'responses', reasoningEffortSent: 'high' }] } };
        });
    }
    function run(root = config) {
        return topic.generateTopicClips({ config: root, originalMediaPath: media, srtPath: srt, mediaGenerator,
            coverGenerator: async () => null, previewGenerator: async () => null,
            registerReviewForUpload: (_review, results) => ({ clipIds: results.map((_clip, i) => 800 + i) }),
            notifyTopicClipResults: async () => true });
    }

    test('a false ordinary reading produces no clip or render', async () => {
        respond('false_match');
        expect(await run()).toEqual([]);
        expect(request).toHaveBeenCalledTimes(1);
        expect(mediaGenerator).not.toHaveBeenCalled();
        const plan = JSON.parse(fs.readFileSync(path.join(dir, 'topic_clips/source_TOPIC_PLAN.json'), 'utf8'));
        expect(plan.groups[0].hits[0]).toMatchObject({ verdict: 'false_match', recall: { kind: 'ambiguous_asr' } });
    });
    test('an uncertain hypothesis with an empty model edit stays in the review list without rendering', async () => {
        respond('uncertain');
        const original = request.getMockImplementation();
        request.mockImplementation(async (prompt: string, options) => {
            const result = await original(prompt, options);
            const data = JSON.parse(result.text);
            return { ...result, text: JSON.stringify({ ...data, clips: [] }) };
        });
        const result = await run();
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ status: 'pending_preflight', uploadReady: false });
        expect(result[0].aiReview.keyword.hits[0].verdict).toBe('uncertain');
        expect(result[0].aiReview.quality.issues.join(' ')).toContain('模型未给出事件选窗');
        expect(result[0].candidateId).toBe(800);
        expect(mediaGenerator).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(dir, 'topic_clips/REVIEW.md'), 'utf8')).toContain('疑似人名');
        expect(fs.readFileSync(srt, 'utf8')).not.toContain('岁己');
    });
    test.each([['uncertain', true], ['mention', false]])('holds a model-ready clip when semantic evidence is insufficient (%s)', async (verdict, support) => {
        const original = fs.readFileSync(srt, 'utf8');
        respond(verdict as string, support as boolean);
        const result = await run();
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ status: 'pending_preflight', uploadReady: false });
        expect(mediaGenerator).not.toHaveBeenCalled();
        expect(fs.readFileSync(srt, 'utf8')).toBe(original);
        expect(result[0].aiReview.quality.issues.join(' ')).toMatch(/疑似人名/);
        if (verdict === 'mention') expect(result[0].aiReview.rejectedSubtitleEdits).toHaveLength(1);
    });
    test('renders a semantically confirmed source-bound patch, preserving original recording subtitles', async () => {
        const original = fs.readFileSync(srt, 'utf8');
        respond('mention');
        const result = await run();
        expect(result).toHaveLength(1);
        expect(result[0].aiReview.status).toBe('ready');
        expect(mediaGenerator).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(result[0].output.srtPath, 'utf8')).toContain('被岁己吐槽');
        expect(fs.readFileSync(srt, 'utf8')).toBe(original);
    });
    test('a confirmed event retains an uncertain auxiliary word without using it as an identity anchor', async () => {
        fs.writeFileSync(srt, fs.readFileSync(srt, 'utf8').replace('讲完了这次朋友的消息要求', '这一集就会消息息说让我等一下'));
        respond('mention', true, true);
        const result = await run();
        expect(result).toHaveLength(1);
        expect(result[0].aiReview.status).toBe('ready');
        expect(mediaGenerator).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(result[0].output.srtPath, 'utf8')).toContain('这一集就会消息息说让我等一下');
        const plan = JSON.parse(fs.readFileSync(path.join(dir, 'topic_clips/source_TOPIC_PLAN.json'), 'utf8'));
        expect(plan.groups[0].hits.map(hit => hit.verdict)).toEqual(['mention', 'uncertain']);
        expect(plan.groups[0].clips[0].hitIds).toEqual(['K1']);
        expect(plan.groups[0].clips[0].warnings).toHaveLength(1);
    });
    test.each([false, true])('keeps semantic assessments and boundaries when repair is unavailable (repair=%s)', async repair => {
        respond('mention');
        const original = request.getMockImplementation();
        request.mockImplementation(async (prompt: string, options) => {
            if (request.mock.calls.length > 1) throw new Error('boundary repair provider failed');
            const result = await original(prompt, options);
            const data = JSON.parse(result.text);
            data.clips[0].boundaryReview = { setupCueId: 'G1', closureCueId: 'G4',
                startReason: '包含起因', endReason: '尚有回指待确认', dependencies: [], unresolvedCueIds: ['G3'] };
            return { ...result, text: JSON.stringify(data) };
        });
        const { buildPreflightEvidence } = require('./preflight_evidence');
        const { buildTopicEditorialGroups } = require('./topic_editorial');
        const { prepareTopicGroup } = require('./preflight_runner');
        const root = { ...config, clipTopics: { ...config.clipTopics,
            review: { ...config.clipTopics.review, qualityRules: true } } };
        const settings = topic.getClipTopicsConfig(root);
        const segments = topic.parseTopicSrt(srt).segments;
        const matches = runtime.loadWorkflow('clipping/topicRecovery').mergeTopicRecallMatches(segments, [], settings);
        const evidence = buildPreflightEvidence(segments);
        const bursts = topic.buildTopicBursts(segments, matches, settings);
        const group = buildTopicEditorialGroups(bursts, evidence, settings)[0];
        const plan = await prepareTopicGroup(group, evidence, settings, root, { srtPath: srt },
            { failures: [], requests: [] }, { boundaryRepair: repair });
        expect(plan.record.status).toBe('unavailable');
        expect(plan.hits[0]).toMatchObject({ verdict: 'mention', recall: { kind: 'ambiguous_asr' } });
        expect(plan.record.hits).toEqual(plan.hits);
        expect(plan.clips[0]).toMatchObject({ status: 'needs_review', start: 0, end: 60,
            sourceKind: 'live_speech', boundaryReview: { unresolvedCueIds: ['G3'] } });
        expect(plan.clips[0].issues.join(' ')).toContain('未找到必要起因或收尾');
        expect(request).toHaveBeenCalledTimes(repair ? 2 : 1);
        expect(fs.readFileSync(srt, 'utf8')).not.toContain('岁己');
        expect(mediaGenerator).not.toHaveBeenCalled();
    });
    test('AI failure cannot turn a recall hypothesis into a render or approved subtitle', async () => {
        request.mockRejectedValue(new Error('provider unavailable'));
        const result = await run();
        expect(result.length).toBeGreaterThan(0);
        expect(result.every(clip => clip.status === 'pending_preflight' && !clip.uploadReady)).toBe(true);
        expect(mediaGenerator).not.toHaveBeenCalled();
        expect(fs.readFileSync(srt, 'utf8')).not.toContain('岁己');
    });
    test.each(['mismatch', 'no_speech', 'unavailable'])('production entry holds %s audio even if AI claims mention', async status => {
        respond('mention');
        const loadOriginal = runtime.loadWorkflow;
        const prepare = jest.fn(async (_input, _config, source) => {
            expect(source.mediaPath).toBe(media);
            expect(source.srtPath).toBe(srt);
            expect(source.selectionCacheDirectory).toContain('topic_selection');
            return { version: 1, windows: [{ hitIds: ['K1'], status }], skipped: [] };
        });
        const load = jest.spyOn(runtime, 'loadWorkflow').mockImplementation(name => {
            const stage = loadOriginal(name);
            return name === 'clipping/topicRecovery' ? { ...stage, prepareTopicAudio: prepare } : stage;
        });
        try {
            const result = await run({ ...config, clipTopics: { ...config.clipTopics,
                review: { ...config.clipTopics.review, audioChecks: { enabled: true } } } } as any);
            expect(prepare).toHaveBeenCalledTimes(1);
            expect(result[0].aiReview.status).toBe('needs_review');
            expect(result[0].aiReview.keyword.hits[0].verdict).toBe('uncertain');
            expect(result[0].aiReview.audioChecks.windows[0].status).toBe(status);
            expect(mediaGenerator).not.toHaveBeenCalled();
            expect(fs.readFileSync(srt, 'utf8')).not.toContain('岁己');
        } finally { load.mockRestore(); }
    });
    test('paired prompts stay separate and a biased name cannot approve an uncertain identity', async () => {
        respond('uncertain');
        const answer = request.getMockImplementation();
        request.mockImplementation(async (prompt, options) => {
            const input = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
            expect(input.unpromptedChecks).toEqual([]);
            expect(input.audioChecks.windows[0].biased.text).toBe('岁己');
            expect(prompt).toContain('NOT independent corroboration');
            return answer(prompt, options);
        });
        const original = runtime.loadWorkflow;
        const load = jest.spyOn(runtime, 'loadWorkflow').mockImplementation(name => {
            const stage = original(name);
            return name === 'clipping/topicRecovery' ? { ...stage, prepareTopicAudio: async () => ({
                windows: [{ hitIds: ['K1'], status: 'aligned', unprompted: { text: '随即', prompted: false },
                    biased: { text: '岁己', prompted: true } }], skipped: [] }) } : stage;
        });
        try {
            const result = await run({ ...config, clipTopics: { ...config.clipTopics,
                review: { ...config.clipTopics.review, audioChecks: { enabled: true } } } } as any);
            expect(result[0].aiReview.status).toBe('needs_review');
            expect(mediaGenerator).not.toHaveBeenCalled();
        } finally { load.mockRestore(); }
    });
    test('an older active release retains literal matching until the candidate release is activated', async () => {
        const load = jest.spyOn(runtime, 'loadWorkflow').mockReturnValue({});
        try {
            expect(await run()).toEqual([]);
            expect(request).not.toHaveBeenCalled();
            expect(mediaGenerator).not.toHaveBeenCalled();
        } finally { load.mockRestore(); }
    });
});
