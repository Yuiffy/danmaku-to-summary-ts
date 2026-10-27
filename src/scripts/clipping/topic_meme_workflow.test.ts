export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const topic = require('../topic_clipper');
const generator = require('../ai_text_generator');
const production = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../config/production.json'), 'utf8'));

describe('unnamed meme references use the existing preflight and pending-review workflow', () => {
    let dir: string, srt: string, xml: string, media: string, original: string, request: any, render: any;
    const texts = ['神秘神秘加号搞了个大宵也要来', '我祝你搞了个大宵怎么也跑我这儿来了',
        '那我今天是不是今天要配你这个猪', '今天周五要配你这个猪',
        '今天周六要配这个猪猪死', '你天天猪能不能', '我看最近瑞娅前辈好像在用这个猪', '回到另一个独立话题'];
    const times = [[0, 5], [5.2, 8], [8.2, 12], [12.2, 16], [16.2, 20], [20.2, 32], [33, 36], [60, 70]];
    const stamp = (seconds: number) => `00:00:${String(Math.floor(seconds)).padStart(2, '0')},${String(Math.round(seconds % 1 * 1000)).padStart(3, '0')}`;
    const config = { ai: { text: { enabled: true, provider: 'daiYu' } }, clipTopics: {
        enabled: true, keywords: ['岁己', '小岁'], memeRecall: production.clipTopics.memeRecall,
        ambiguousRecall: { enabled: false },
        review: { enabled: true, mode: 'preflight', strategy: 'single', model: 'gpt-6-luna', reasoningEffort: 'high',
            audioChecks: { enabled: true }, transientMaxAttempts: 1 }, ai: { selectionCacheEnabled: false }
    } };
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-meme-'));
        srt = path.join(dir, 'source.srt'); media = path.join(dir, 'source.mp4'); xml = path.join(dir, 'source.xml');
        original = texts.map((text, i) => `${i + 1}\n${stamp(times[i][0])} --> ${stamp(times[i][1])}\n${text}\n`).join('\n');
        fs.writeFileSync(srt, original);
        fs.writeFileSync(media, 'mock source');
        fs.writeFileSync(xml, '<i><d p="50,1,25,16777215,1,0,1,0">岁己前辈先用的</d></i>');
        render = jest.fn(async (_source, _window, _subtitle, output) => {
            fs.writeFileSync(output, 'mock rendered media'); return { path: output, burnedSubtitles: true };
        });
        request = jest.spyOn(generator, 'generateTextWithDaiYu');
    });
    afterEach(() => { request.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); });

    const run = () => topic.generateTopicClips({ config, originalMediaPath: media, srtPath: srt, xmlPath: xml,
        context: { roomId: '1791260716', streamerName: '来源主播' }, mediaGenerator: render,
        coverGenerator: async () => null, previewGenerator: async () => null,
        registerReviewForUpload: (_review, results) => ({ clipIds: results.map((_clip, i) => 800 + i) }),
        notifyTopicClipResults: async () => true });

    function respond(verdict = 'mention', empty = false, patch = false) {
        request.mockImplementation(async (prompt: string) => {
            const input = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
            expect(input.hits).toHaveLength(2);
            expect(input.hits.every(hit => hit.recall.kind === 'meme_reference' && !hit.text.includes('岁己'))).toBe(true);
            expect(input.audience).toEqual([{ id: 'D1', time: 50, text: expect.any(String) }]);
            expect(input.audioChecks).toBeUndefined();
            expect(prompt).toContain('NEVER replace a meme phrase');
            return { text: JSON.stringify({ hits: input.hits.map(hit => ({ id: hit.id, verdict,
                reason: '结合原句与明确点名的弹幕判断梗关联', evidenceCueIds: [hit.cueId], evidenceDanmakuIds: ['D1'] })),
                clips: empty || verdict === 'false_match' ? [] : [{ id: 'E1-1', status: 'ready', startCueId: 'G1', endCueId: 'G6',
                    hitIds: input.hits.map(hit => hit.id), event: '连续说出周五周六的标题', reason: '保留完整接梗与收尾',
                    score: 80, extensionReason: '', sourceKind: 'live_speech', evidenceCueIds: ['G3', 'G4', 'G5', 'G6'],
                    evidenceDanmakuIds: [], warnings: [], title: '从周五说到周六', description: '连说周五周六的标题',
                    coverText: '今天周五\n今天周六', subtitleEdits: patch ? [{ cueId: 'G3', original: '猪', replacement: '岁己',
                        reason: '错误的人名替换建议', evidenceCueIds: ['G3'] }] : [] }] }),
                meta: { model: 'gpt-6-luna', attempts: [{ model: 'gpt-6-luna', apiModeUsed: 'responses', reasoningEffortSent: 'high' }] } };
        });
    }

    test('recalls the phrase with ambiguous-name recall disabled and preserves source, audience and subtitle provenance', async () => {
        respond('mention', false, true);
        const results = await run();
        expect(results).toHaveLength(1);
        expect(results[0].aiReview.status).toBe('ready');
        expect(render).toHaveBeenCalledTimes(1);
        expect(results[0].aiReview.keyword.hits[0]).toMatchObject({ verdict: 'mention', evidenceDanmakuIds: ['D1'],
            recall: { kind: 'meme_reference' } });
        expect(results[0].aiReview.rejectedSubtitleEdits).toHaveLength(1);
        expect(fs.readFileSync(results[0].output.srtPath, 'utf8')).toContain('配你这个猪');
        expect(fs.readFileSync(results[0].output.srtPath, 'utf8')).not.toContain('岁己');
        expect(fs.readFileSync(srt, 'utf8')).toBe(original);
        const plan = JSON.parse(fs.readFileSync(path.join(dir, 'topic_clips/source_TOPIC_PLAN.json'), 'utf8'));
        expect(plan.groups[0].hits[0].evidenceDanmakuIds).toEqual(['D1']);
    });

    test('an unrelated named audience comment cannot turn an unsupported model-ready meme into a render', async () => {
        fs.writeFileSync(xml, '<i><d p="50,1,25,16777215,1,0,1,0">岁己晚上好</d></i>');
        respond();
        const results = await run();
        expect(results[0]).toMatchObject({ status: 'pending_preflight', uploadReady: false, candidateId: 800 });
        expect(results[0].aiReview.quality.issues.join(' ')).toContain('解释梗关联');
        expect(render).not.toHaveBeenCalled();
    });

    test('an uncertain unnamed reference with an empty edit remains visible under a pending candidate ID', async () => {
        respond('uncertain', true);
        const results = await run();
        expect(results[0]).toMatchObject({ status: 'pending_preflight', uploadReady: false, candidateId: 800 });
        expect(results[0].aiReview.quality.issues.join(' ')).toContain('梗句与目标人物关联未确认');
        expect(render).not.toHaveBeenCalled();
    });

    test('the semantic reviewer can discard an unrelated phrase without creating media', async () => {
        respond('false_match');
        expect(await run()).toEqual([]);
        expect(render).not.toHaveBeenCalled();
    });

    test('provider failure holds the recalled event without changing source words or rendering', async () => {
        request.mockRejectedValue(new Error('provider unavailable'));
        const results = await run();
        expect(results.length).toBeGreaterThan(0);
        expect(results.every(row => row.status === 'pending_preflight' && !row.uploadReady)).toBe(true);
        expect(render).not.toHaveBeenCalled();
        expect(fs.readFileSync(srt, 'utf8')).toBe(original);
    });
});
