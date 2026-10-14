export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const generator = require('../ai_text_generator');
const topic = require('../topic_clipper');
const asr = require('../asr/asr_backends');
const { buildPreflightEvidence } = require('./preflight_evidence');
const { prepareTopicGroup } = require('./preflight_runner');
const { prepareCompetitionEvidence } = require('../../workflows/clipping/topicCompetitionRuntime');

describe('competition keyword suppression before rendering', () => {
    let dir: string, media: string, srt: string, request: any, capture: any;
    const config = { ai: { text: { provider: 'daiYu' } }, clipTopics: { enabled: true, keywords: ['小岁'],
        minClipSeconds: 10, review: { enabled: true, mode: 'preflight', strategy: 'single', model: 'fixture', reasoningEffort: 'max' },
        ai: { selectionCacheEnabled: false } } };
    const rows = [
        { start: 0, end: 8, text: '现在看EDGM和TTG比赛' },
        { start: 10, end: 20, text: '小岁拉到赵云了' },
        { start: 21, end: 38, text: '盾山把小岁吓哭了' },
        { start: 1000, end: 1008, text: '观赛结束了' },
        { start: 1010, end: 1020, text: '想和小岁一起玩' },
        { start: 1021, end: 1038, text: '以后找她约个时间' }
    ];

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-competition-'));
        media = path.join(dir, 'recording.mp4'); srt = path.join(dir, 'recording.srt');
        fs.writeFileSync(media, 'fake media');
        asr.writeSrt(asr.normalizeAsrResult({ backend: 'fixture', segments: rows }), srt);
        capture = jest.fn(async (_time, file) => fs.writeFileSync(file, Buffer.from([255, 216, 255, 217])));
        request = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (prompt: string, options: any) => {
            const input = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
            expect(options.images.length).toBeGreaterThan(0);
            expect(input.source.roomId).toBe('1741667419');
            const competitionContext = Number(input.subtitles[0].start) < 1000 ? { status: 'spectating', intervals: [{
                startCueId: input.subtitles[0].id, endCueId: input.subtitles.at(-1).id, reason: '正在看职业比赛',
                evidenceCueIds: [input.subtitles[0].id], evidenceDanmakuIds: [], evidenceFrameIds: [], players: [{
                    name: '小碎', visibleText: '上海EDGM·小碎', confusableKeywords: ['小岁'],
                    evidenceCueIds: [], evidenceDanmakuIds: [], evidenceFrameIds: ['F1']
                }]
            }] } : { status: 'other', intervals: [] };
            // Deliberately wrong positive verdict: the local gate must still reject this clip.
            return { text: JSON.stringify({ competitionContext, hits: input.hits.map(hit => ({ id: hit.id, verdict: 'mention',
                reason: '模型错误地把小碎判成小岁', evidenceCueIds: [hit.cueId] })), clips: [{
                    id: `${input.groupId}-1`, status: 'ready', startCueId: input.subtitles[0].id, endCueId: input.subtitles.at(-1).id,
                    hitIds: input.hits.map(hit => hit.id), event: '完整事件', reason: '有起因和收尾', score: 80, extensionReason: '',
                    sourceKind: 'live_speech', evidenceCueIds: input.hits.map(hit => hit.cueId), evidenceDanmakuIds: [], warnings: [],
                    title: '约好一起玩', description: '聊到一起玩的安排', coverText: '一起玩\n约个时间', subtitleEdits: []
                }] }), meta: { model: 'fixture', attempts: [{ model: 'fixture', reasoningEffortSent: 'max', apiModeUsed: 'responses' }] } };
        });
    });
    afterEach(() => { request?.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); });

    function prepare(roomId = '1741667419', overrides: any = {}, strategy = 'single') {
        const evidence = buildPreflightEvidence(rows.slice(0, 3));
        const matches = [1, 2].map(i => ({ ...evidence.cues[i].items[0], matchedKeywords: ['小岁'] }));
        const group = { index: 'E1', start: 0, end: 38, cues: evidence.cues, matchSegments: matches,
            bursts: [{ start: 0, end: 38, matchSegments: matches }] };
        const settings = topic.getClipTopicsConfig(config); settings.review.strategy = strategy;
        return prepareTopicGroup(group, evidence, settings, config,
            { mediaPath: media, srtPath: srt, roomId, streamerName: '十六萤Izayoi' }, { requests: [], failures: [] },
            { competitionIO: { capture }, boundaryRepair: false, ...overrides });
    }

    test('filters erroneous mention verdicts before burn/upload, saves evidence, then permits ordinary post-match chat', async () => {
        const render = jest.fn(async (_source, _window, _srt, file) => {
            fs.writeFileSync(file, 'rendered'); return { path: file, burnedSubtitles: true };
        });
        const register = jest.fn(() => ({ clipIds: [700] }));
        const result = await topic.generateTopicClips({ config, originalMediaPath: media, srtPath: srt,
            context: { roomId: '1741667419', streamerName: '十六萤Izayoi' }, competitionIO: { capture },
            mediaGenerator: render, coverGenerator: async () => null, registerReviewForUpload: register,
            notifyTopicClipResults: async () => true });
        expect(request).toHaveBeenCalledTimes(2);
        expect(capture.mock.calls.length).toBeLessThanOrEqual(6);
        expect(render).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
        expect(result[0].window.start).toBe(1000);
        expect(result[0].aiReview.competitionContext.status).toBe('other');
        const plan = JSON.parse(fs.readFileSync(path.join(dir, 'topic_clips', 'recording_TOPIC_PLAN.json'), 'utf8'));
        expect(plan.groups[0].hits.every(hit => hit.verdict === 'false_match')).toBe(true);
        expect(plan.groups[0].competitionContext.intervals[0].players[0].name).toBe('小碎');
        expect(plan.groups[0].competitionEvidence.frames[0].sha256).toHaveLength(64);
        expect(plan.groups[0].clips).toEqual([]);
    });

    test('a missing context decision holds candidates, rather than falling back to automatic positive aliases', async () => {
        const ordinary = request.getMockImplementation();
        request.mockImplementation(async (...args) => {
            const result = await ordinary(...args), raw = JSON.parse(result.text);
            delete raw.competitionContext; return { ...result, text: JSON.stringify(raw) };
        });
        const plan = await prepare();
        expect(plan.record.status).toBe('unavailable');
        expect(plan.clips.length).toBeGreaterThan(0);
        expect(plan.clips.every(clip => clip.status === 'needs_review')).toBe(true);
    });

    test('staged final copy cannot reinstate a suppressed anchor or lose its locked competition assessment', async () => {
        const ordinary = request.getMockImplementation();
        request.mockImplementation(async (...args) => {
            const result = await ordinary(...args), raw = JSON.parse(result.text);
            const input = JSON.parse(args[0].split('SOURCE EVIDENCE:\n')[1]);
            if (args[0].includes('LOCKED EVENT:')) {
                delete raw.competitionContext; delete raw.hits;
            } else {
                raw.competitionContext.intervals[0].endCueId = 'G2';
            }
            Object.assign(raw.clips[0], { startCueId: 'G3', endCueId: 'G3', hitIds: [input.hits[1].id], evidenceCueIds: ['G3'] });
            return { ...result, text: JSON.stringify(raw) };
        });
        const plan = await prepare('1741667419', {}, 'staged');
        expect(request).toHaveBeenCalledTimes(2);
        expect(plan.hits.map(hit => hit.verdict)).toEqual(['false_match', 'mention']);
        expect(plan.clips).toHaveLength(1);
        expect(plan.clips[0].status).toBe('ready');
        expect(plan.clips[0].hits[0].id).toBe('K2');
        expect(plan.competitionContext.intervals[0].endCueId).toBe('G2');
    });

    test('another source room keeps the existing request and does not capture frames', async () => {
        request.mockImplementation(async (prompt: string, options: any) => {
            const input = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
            expect(input.competitionGuard).toBeUndefined(); expect(options.images).toBeUndefined();
            return { text: JSON.stringify({ hits: input.hits.map(hit => ({ id: hit.id, verdict: 'false_match',
                reason: '普通游戏名词', evidenceCueIds: [hit.cueId] })), clips: [] }),
                meta: { attempts: [{ model: 'fixture', reasoningEffortSent: 'max', apiModeUsed: 'responses' }] } };
        });
        expect((await prepare('25788785')).clips).toEqual([]);
        expect(capture).not.toHaveBeenCalled();
    });

    test('frame errors remain explicit; text evidence can still suppress without another model call', async () => {
        capture.mockRejectedValue(new Error('frame unavailable'));
        request.mockImplementation(async (prompt: string, options: any) => {
            const input = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
            expect(options.images).toBeUndefined(); expect(input.competitionGuard.issues.length).toBeGreaterThan(0);
            return { text: JSON.stringify({ competitionContext: { status: 'spectating', intervals: [{
                startCueId: 'G1', endCueId: 'G3', reason: '看EDGM比赛', evidenceCueIds: ['G1'], evidenceDanmakuIds: [], evidenceFrameIds: [],
                players: [{ name: '小碎', visibleText: '', confusableKeywords: ['小岁'],
                    evidenceCueIds: [], evidenceDanmakuIds: ['D1'], evidenceFrameIds: [] }]
            }] }, hits: input.hits.map(hit => ({ id: hit.id, verdict: 'mention', reason: '误判', evidenceCueIds: [hit.cueId] })), clips: [] }),
                meta: { attempts: [{ model: 'fixture', reasoningEffortSent: 'max', apiModeUsed: 'responses' }] } };
        });
        const plan = await prepare('1741667419', { danmaku: [{ time: 15, text: '上海EDGM选手小碎' }] });
        expect(plan.hits.every(hit => hit.verdict === 'false_match')).toBe(true);
        expect(request).toHaveBeenCalledTimes(1);
    });

    test('frame acquisition is bounded and byte hashes bind the actual attachments', async () => {
        const group = { index: 'many', start: 0, end: 200, matchSegments: Array.from({ length: 20 }, (_v, i) => ({ start: i * 10, end: i * 10 + 5 })) };
        const evidence = await prepareCompetitionEvidence({ mediaPath: media }, group, { capture });
        expect(capture).toHaveBeenCalledTimes(3);
        expect(evidence.frames.map(frame => frame.id)).toEqual(['F1', 'F2', 'F3']);
        expect(evidence.images).toHaveLength(3);
        expect(evidence.images.every(image => image.startsWith('data:image/jpeg;base64,'))).toBe(true);
    });
});
