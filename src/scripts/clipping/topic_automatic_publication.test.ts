export {};

jest.mock('../wechat_work_markdown', () => ({
    ...jest.requireActual('../wechat_work_markdown'), sendWeChatMarkdown: jest.fn(async () => true)
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const asr = require('../asr/asr_backends');
const topic = require('../topic_clipper');
const generator = require('../ai_text_generator');
const { sendWeChatMarkdown } = require('../wechat_work_markdown');

const passed = { status: 'passed', checks: { content: true, attribution: true, subtitles: true, visuals: true, policy: true },
    issues: [], resolvedGroundingIssues: [] };
const picture = 'data:image/jpeg;base64,/9j/';

describe('topic automatic publication integration', () => {
    let directory: string, media: string, subtitles: string, xml: string;
    let planner: any, timeline: string[], config: any;

    beforeEach(() => {
        sendWeChatMarkdown.mockClear();
        timeline = [];
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-publication-'));
        media = path.join(directory, 'recording.mp4');
        subtitles = path.join(directory, 'recording.srt');
        xml = path.join(directory, 'recording.xml');
        fs.writeFileSync(media, 'source video fixture');
        fs.writeFileSync(xml, '<i><d p="12,1,25,16777215,0,0,fixture,0">原始弹幕证据</d></i>');
        const segments = [0, 1000, 2000].flatMap((start, index) => [
            { start, end: start + 8, text: 'The setup of this event.' },
            { start: start + 10, end: start + 20, text: index ? 'SUI has a story.' : 'SUI has a prise.',
                ...(index ? {} : { raw_text: 'SUI has a price.' }) },
            { start: start + 21, end: start + 42, text: 'That is the full response.' }
        ]);
        asr.writeSrt(asr.normalizeAsrResult({ backend: 'test', segments }), subtitles, { write_evidence: true });
        config = { ai: { text: { enabled: true, provider: 'daiYu' } }, wechatWork: { webhookUrl: 'https://example.invalid/fixture' },
            ownStreamClips: { selectionPolicy: { excludedCategories: ['全局排除内容'], roomOverrides: {
                '31415': { excludedCategories: ['本房间排除内容'] }, '25788785': { excludedCategories: ['现实家庭关系'] }
            } } }, clipTopics: {
                enabled: true, keywords: ['SUI'], ignoredRoomIds: ['25788785'], ai: { selectionCacheEnabled: false },
                review: { enabled: true, mode: 'preflight', strategy: 'single', model: 'gpt-6-luna', reasoningEffort: 'max' },
                automaticPublication: { mode: 'auto', policyVersion: 'topic-v1', scope: 'configured_keywords',
                    activatedAt: '2026-01-01T00:00:00Z', authorizationNote: 'Authorized by test fixture', concurrency: 1 },
                notify: { enabled: true, includeSubtitleContext: false, includeDanmakuContext: false }
            } };
        planner = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (prompt: string) => {
            const input = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
            timeline.push(`plan:${input.groupId}`);
            return { text: JSON.stringify({ hits: input.hits.map(hit => ({ id: hit.id, verdict: 'mention',
                reason: 'The person is explicitly mentioned.', evidenceCueIds: [hit.cueId] })), clips: [{
                id: `${input.groupId}-1`, status: 'ready', startCueId: input.subtitles[0].id, endCueId: input.subtitles.at(-1).id,
                hitIds: input.hits.map(hit => hit.id), event: 'A complete event', reason: 'The setup and full answer are retained.',
                score: 80, extensionReason: '', sourceKind: 'recount', evidenceCueIds: input.hits.map(hit => hit.cueId),
                evidenceDanmakuIds: [], warnings: [], title: 'A complete story', description: 'The complete answer.', coverText: 'Complete\nStory',
                subtitleEdits: input.groupId === 'E1' ? [{ cueId: input.hits[0].cueId, original: 'prise', replacement: 'price',
                    reason: 'Original ASR corroborates this word.', evidenceCueIds: [input.hits[0].cueId] }] : []
            }] }), meta: { model: 'gpt-6-luna', attempts: [{ model: 'gpt-6-luna', responseModel: 'gpt-6-luna',
                reasoningEffortSent: 'max', apiModeUsed: 'responses' }] } };
        });
    });

    afterEach(() => { planner.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); });

    function run(overrides: Record<string, any> = {}) {
        const ids = [713, 4107, 8309];
        let queued: number[] = [];
        const mediaGenerator = jest.fn(async (_source, window, _srt, output) => {
            timeline.push(`media:${window.index}`);
            fs.writeFileSync(output, 'rendered final video');
            return { path: output, burnedSubtitles: true };
        });
        const coverGenerator = jest.fn(async video => {
            const file = video.replace(/\.mp4$/u, '.jpg');
            fs.writeFileSync(file, 'rendered cover');
            return file;
        });
        const previewGenerator = jest.fn(async metadata => {
            const file = path.join(directory, `${metadata.window.index}_preview.mp4`);
            fs.writeFileSync(file, 'rough preview');
            fs.copyFileSync(metadata.candidateSubtitles.path, file.replace('.mp4', '.srt'));
            metadata.reviewPreview = { status: 'ready', mediaPath: file, srtPath: file.replace('.mp4', '.srt'),
                clipStart: 0, clipEnd: metadata.window.duration };
        });
        const request = jest.fn(async (artifact, _prompt, _images) => {
            timeline.push(`final:${artifact.window.index}`);
            return { text: JSON.stringify(passed) };
        });
        const inspect = jest.fn(async artifact => {
            expect(fs.existsSync(artifact.output.mediaPath)).toBe(true);
            expect(fs.existsSync(artifact.output.coverPath)).toBe(true);
            return { passed: true, issues: [], frames: [picture, picture] };
        });
        const register = jest.fn((_reviewPath, results) => {
            timeline.push(queued.length ? 'registry:refresh' : 'registry:import');
            return { clipIds: results.map((_row, index) => ids[index]),
                clipIdsByReviewIndex: Object.fromEntries(results.map((row, index) => [row.reviewIndex, ids[index]])),
                clipStatusByReviewIndex: Object.fromEntries(results.map((row, index) => [row.reviewIndex,
                    queued.includes(ids[index]) ? 'queued' : row.status === 'pending_preflight' ? 'pending_cut' : 'ready'])) };
        });
        const automaticEnqueue = jest.fn(async selected => {
            timeline.push('enqueue'); queued = selected;
            return 'AUTOMATIC_ENQUEUE_RESULT: ' + JSON.stringify({ queuedIds: selected, results: selected.map(id => ({ id, status: 'queued' })) });
        });
        const notify = jest.fn(async (...args) => { timeline.push('notify'); return topic.notifyTopicClipResults(...args); });
        return { ids, request, inspect, register, automaticEnqueue, notify, mediaGenerator, coverGenerator, previewGenerator,
            promise: topic.generateTopicClips({ config, originalMediaPath: media, srtPath: subtitles, xmlPath: xml,
                context: { roomId: '31415', streamerName: 'Source Host' }, mediaGenerator, coverGenerator, previewGenerator,
                registerReviewForUpload: register, notifyTopicClipResults: notify, automaticEnqueue,
                publicationAdapters: { request, inspect }, ...overrides }) };
    }

    test('disabled automatic policy preserves one ordinary list without final review or enqueue', async () => {
        config.clipTopics.automaticPublication.mode = 'off';
        const sourceBefore = fs.readFileSync(subtitles, 'utf8');
        const job = run(), results = await job.promise;
        expect(results).toHaveLength(3);
        expect(planner).toHaveBeenCalledTimes(3);
        expect(job.request).not.toHaveBeenCalled(); expect(job.inspect).not.toHaveBeenCalled();
        expect(job.automaticEnqueue).not.toHaveBeenCalled(); expect(job.register).toHaveBeenCalledTimes(1);
        expect(results.every(result => !result.automaticPublicationRequired && !result.publicationKind)).toBe(true);
        expect(job.notify).toHaveBeenCalledTimes(1); expect(sendWeChatMarkdown).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(subtitles, 'utf8')).toBe(sourceBefore);
    });

    test('only a passed final enters the queue; held and unrendered siblings remain in the single refreshed list', async () => {
        const prepare = planner.getMockImplementation();
        planner.mockImplementation(async (...args) => {
            const response = await prepare(...args), data = JSON.parse(response.text);
            if (data.clips[0].id === 'E3-1') { data.clips[0].status = 'needs_review'; data.clips[0].warnings = ['还需核对具体人物']; }
            return { ...response, text: JSON.stringify(data) };
        });
        const request = jest.fn(async (artifact, prompt, images) => {
            timeline.push(`final:${artifact.window.index}`);
            const evidence = JSON.parse(prompt.split('EVIDENCE_JSON ')[1]);
            expect(evidence.excludedCategories).toEqual(['全局排除内容', '本房间排除内容', '现实家庭关系']);
            expect(evidence.configuredKeywords).toEqual(['SUI']); expect(evidence.sourceHost).toBe('Source Host');
            expect(images).toEqual([picture, picture]);
            if (artifact.window.index === 'E1-1') {
                expect(evidence.completeRetainedSubtitles.some(row => row.text.includes('price'))).toBe(true);
                expect(evidence.topicEvidence.aiReview.subtitleEdits[0].replacement).toBe('price');
                expect(evidence.sourceAudience[0].text).toBe('原始弹幕证据');
            }
            return { text: JSON.stringify(artifact.window.index === 'E1-1' ? passed : {
                ...passed, status: 'needs_review', checks: { ...passed.checks, attribution: false }, issues: ['人物指代仍需人工核对']
            }) };
        });
        const inspect = jest.fn(async () => ({ passed: true, issues: [], frames: [picture, picture] }));
        const job = run({ publicationAdapters: { request, inspect } }), results = await job.promise;
        expect(results.map(result => result.window.index)).toEqual(['E1-1', 'E2-1', 'E3-1']);
        expect(results.map(result => result.publicationDecision?.action)).toEqual(['auto_queue', 'needs_human', undefined]);
        expect(job.automaticEnqueue).toHaveBeenCalledTimes(1); expect(job.automaticEnqueue).toHaveBeenCalledWith([713]);
        expect(results.map(result => result.uploadId || result.candidateId)).toEqual([713, 4107, 8309]);
        expect(results[0].publicationReview.source.xmlPath).toBe(path.resolve(xml));
        expect(results[2].status).toBe('pending_preflight'); expect(results[2].output.mediaPath).toBeNull();
        expect(results[2].candidateSubtitles.approval).toBeFalsy();
        expect(request).toHaveBeenCalledTimes(2); expect(inspect).toHaveBeenCalledTimes(2);
        expect(job.mediaGenerator).toHaveBeenCalledTimes(2); expect(job.previewGenerator).toHaveBeenCalledTimes(1);
        expect(job.register).toHaveBeenCalledTimes(2); expect(job.notify).toHaveBeenCalledTimes(1);
        expect(timeline.slice(-4)).toEqual(['registry:import', 'enqueue', 'registry:refresh', 'notify']);
        expect(sendWeChatMarkdown).toHaveBeenCalledTimes(1);
        const message = sendWeChatMarkdown.mock.calls[0][1];
        expect(message).toContain('ID 713'); expect(message).toContain('状态: 已排队投稿');
        expect(message).toContain('ID 4107'); expect(message).toContain('状态: 待人工复核');
        expect(message).toContain('候选ID 8309'); expect(message).toContain('人物指代仍需人工核对');
        expect(message).not.toMatch(/BV[A-Za-z0-9]+|bilibili\.com/u);
        expect(fs.readFileSync(path.join(directory, 'topic_clips', 'REVIEW.md'), 'utf8')).toContain('状态: 已排队投稿');
    });

    test('failed unregistered siblings cannot shift the stable IDs sent to automatic enqueue', async () => {
        const mediaGenerator = jest.fn(async (_source, window, _srt, output) => {
            if (window.index === 'E1-1') throw new Error('fixture encode failed');
            fs.writeFileSync(output, 'rendered final video'); return { path: output, burnedSubtitles: true };
        });
        const job = run({ mediaGenerator }), results = await job.promise;
        expect(results[0].status).toBe('failed'); expect(results[0].uploadId).toBeUndefined();
        expect(results.slice(1).map(result => result.uploadId)).toEqual([713, 4107]);
        expect(job.automaticEnqueue).toHaveBeenCalledWith([713, 4107]);
        expect(job.request.mock.calls.map(call => call[0].window.index)).toEqual(['E2-1', 'E3-1']);
        expect(job.register).toHaveBeenCalledTimes(2); expect(job.notify).toHaveBeenCalledTimes(1);
        expect(sendWeChatMarkdown).toHaveBeenCalledTimes(1);
        const message = sendWeChatMarkdown.mock.calls[0][1];
        expect(message).toContain('已排队 2'); expect(message).toContain('fixture encode failed');
        expect(message).not.toContain('ID 8309');
    });

    test.each([
        [{ planningGroupIds: ['E2'] }, 1],
        [{ planPath: 'saved-topic-plan.json' }, 3]
    ])('manual recovery stays manual under enabled automatic policy (%j)', async (recovery, expectedCount) => {
        const job = run(recovery), results = await job.promise;
        expect(results).toHaveLength(expectedCount);
        expect(job.request).not.toHaveBeenCalled(); expect(job.inspect).not.toHaveBeenCalled();
        expect(job.automaticEnqueue).not.toHaveBeenCalled(); expect(job.register).toHaveBeenCalledTimes(1);
        expect(results.every(result => !result.automaticPublicationRequired && !result.publicationKind)).toBe(true);
        expect(job.notify).toHaveBeenCalledTimes(1); expect(sendWeChatMarkdown).toHaveBeenCalledTimes(1);
        if ('planningGroupIds' in recovery) expect(results[0].window.index).toBe('E2-1');
    });

    test.each(['missing cover', 'subtitle burn fallback'])('%s cannot receive automatic publication permission', async failure => {
        const overrides = failure === 'missing cover' ? { coverGenerator: jest.fn(async () => null) }
            : { mediaGenerator: jest.fn(async (_source, _window, _srt, output) => {
                fs.writeFileSync(output, 'unburned fallback video');
                return { path: output, burnedSubtitles: false, fallbackUsed: true, fallbackReason: 'fixture burn failed' };
            }) };
        const job = run(overrides), results = await job.promise;
        expect(results).toHaveLength(3);
        expect(results.every(result => result.publicationDecision.action === 'needs_human')).toBe(true);
        if (failure === 'missing cover') expect(results.every(result => result.output.coverPath === null)).toBe(true);
        else expect(results.every(result => result.output.burnedSubtitles === false && result.status === 'partial')).toBe(true);
        expect(job.request).not.toHaveBeenCalled(); expect(job.inspect).not.toHaveBeenCalled();
        expect(job.automaticEnqueue).not.toHaveBeenCalled();
        expect(job.notify).toHaveBeenCalledTimes(1); expect(sendWeChatMarkdown).toHaveBeenCalledTimes(1);
        expect(sendWeChatMarkdown.mock.calls[0][1]).toContain('已排队 0');
    });
});
