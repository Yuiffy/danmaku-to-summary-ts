import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { gateTopicAudioHits, planTopicAudio, topicAudioSettings, validateTopicAudio } from './topicAudio';
import { prepareTopicAudio } from './topicAudioRuntime';

const settings = topicAudioSettings({ enabled: true }, ['岁己', '小岁']);
const hit = { id: 'K1', cueId: 'G2', start: 12, end: 15, text: '就被随即吐槽',
    verdict: 'mention', reason: 'person reference', recall: { requiresSemanticConfirmation: true } };
const input = () => ({ sourceSha256: 'source', target: { names: ['岁己', '小岁'] }, hits: [{ ...hit, recall: { ...hit.recall } }],
    subtitles: [{ id: 'G1', start: 0, end: 10, text: '我记得当时觉得好震惊' },
        { id: 'G2', start: 12, end: 15, text: hit.text },
        { id: 'G3', start: 16, end: 28, text: '看到了消息就必须要回' }] });
const budget = () => ({ windows: 0, audioSeconds: 0, elapsedMs: 0 });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const config = { review: { audioChecks: { enabled: true } } };

describe('topic audio planning and fail-closed gates', () => {
    test('disabled and literal hits make no requests', () => {
        expect(planTopicAudio(input(), { ...settings, enabled: false }, budget()).windows).toEqual([]);
        const data = input(); data.hits[0].recall.requiresSemanticConfirmation = false;
        expect(planTopicAudio(data, settings, budget()).windows).toEqual([]);
    });
    test('one fixed bounded window covers nearby hits and excludes every suspect cue from alignment', () => {
        const data = input(); data.hits.push({ ...hit, id: 'K2' });
        const b = budget(), plan = planTopicAudio(data, settings, b);
        expect(plan.windows).toHaveLength(1);
        expect(plan.windows[0]).toMatchObject({ start: 0, end: 28, hitIds: ['K1', 'K2'] });
        expect(plan.windows[0].references.map((r: any) => r.id)).toEqual(['G1', 'G3']);
        expect(b).toEqual({ windows: 1, audioSeconds: 28, elapsedMs: 0 });
    });
    test.each([{ windows: 6, audioSeconds: 0, elapsedMs: 0 }, { windows: 0, audioSeconds: 180, elapsedMs: 0 },
        { windows: 0, audioSeconds: 0, elapsedMs: 360000 }])('recording budgets keep skipped hits on hold: %j', b => {
        const plan = planTopicAudio(input(), settings, b);
        expect(plan.windows).toEqual([]);
        expect(gateTopicAudioHits([hit], plan)[0].verdict).toBe('uncertain');
    });
    test.each(['no_speech', 'mismatch', 'inconclusive', 'unavailable'])('%s cannot become a false match or ready identity', status => {
        for (const verdict of ['mention', 'false_match', 'uncertain']) {
            expect(gateTopicAudioHits([{ ...hit, verdict }], { windows: [{ hitIds: ['K1'], status }] })[0])
                .toMatchObject({ verdict: 'uncertain', audioIssue: expect.stringContaining(status) });
        }
    });
    test('alignment does not change semantic rejection or provide an automatic positive', () => {
        expect(gateTopicAudioHits([{ ...hit, verdict: 'false_match' }], { windows: [{ hitIds: ['K1'], status: 'aligned' }] })[0].verdict).toBe('false_match');
        expect(gateTopicAudioHits([{ ...hit, verdict: 'uncertain' }], { windows: [{ hitIds: ['K1'], status: 'aligned' }] })[0].verdict).toBe('uncertain');
    });
    test('settings clamp operational cost and only use canonical configured names', () => {
        expect(topicAudioSettings({ windowSeconds: 999, hotwords: ['随即', '岁己', '岁己'], timeoutMs: 999999 }, ['岁己']))
            .toMatchObject({ enabled: false, windowSeconds: 30, timeoutMs: 300000, hotwords: ['岁己'] });
    });
});

describe('bound Python adapter', () => {
    let dir: string, source: any, runtime: any;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-audio-'));
        source = { mediaPath: path.join(dir, 'media.opus'), srtPath: path.join(dir, 'source.srt'), selectionCacheDirectory: dir };
        fs.writeFileSync(source.mediaPath, 'media'); fs.writeFileSync(source.srtPath, 'original');
        runtime = { scriptPath: path.resolve(__dirname, '../../scripts/python/topic_audio_checks.py'),
            model: 'nano', vadModel: 'vad', device: 'cpu', python: { executable: 'python', args: [] } };
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    function respond(request: any, output: string) {
        const windows = request.windows.map((w: any) => {
            const audioPath = path.join(path.dirname(output), `${w.id}.wav`); fs.writeFileSync(audioPath, 'audio');
            return { id: w.id, hitIds: w.hitIds, start: w.start, end: w.end, duration: w.end - w.start,
                audioPath, audioSha256: digest('audio'), status: 'aligned', vad: [[0, w.end - w.start]],
                alignment: { matches: w.references.map((c: any) => ({ cueId: c.id, sourceText: c.text, score: 1 })) },
                unprompted: { text: '原声随即', hotwords: [], prompted: false, timingPrecision: 'window' },
                biased: { text: '带提示岁己', hotwords: request.settings.hotwords, prompted: true, timingPrecision: 'window' } };
        });
        return { version: 1, method: 'topic_audio_pair', requestSha256: request.requestSha256,
            source: request.source, settings: request.settings, windows };
    }
    test('bound paired evidence preserves full provenance without touching source SRT', async () => {
        const run = jest.fn(async (request, _file, output) => fs.writeFileSync(output, JSON.stringify(respond(request, output))));
        const checks = await prepareTopicAudio(input(), config, source, {}, runtime, { run, now: () => 0 });
        expect(checks!.windows[0]).toMatchObject({ status: 'aligned', unprompted: { prompted: false }, biased: { prompted: true } });
        expect(checks!.evidence.resultSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(fs.readFileSync(source.srtPath, 'utf8')).toBe('original');
        expect(run).toHaveBeenCalledTimes(1);
    });
    test.each(['source', 'audio', 'binding', 'prompt', 'alignment'])('rejects %s mutation', async mutation => {
        const run = async (request: any, _file: string, output: string) => {
            const response = respond(request, output);
            if (mutation === 'source') fs.writeFileSync(source.srtPath, 'changed');
            if (mutation === 'audio') fs.writeFileSync(response.windows[0].audioPath, 'changed');
            if (mutation === 'binding') response.requestSha256 = 'other';
            if (mutation === 'prompt') response.windows[0].unprompted.hotwords = ['岁己'];
            if (mutation === 'alignment') response.windows[0].alignment.matches = [];
            fs.writeFileSync(output, JSON.stringify(response));
        };
        const checks = await prepareTopicAudio(input(), config, source, {}, runtime, { run, now: () => 0 });
        expect(checks!.windows).toEqual([]);
        expect(checks!.skipped[0].status).toBe('unavailable');
    });
    test('explicit candidate recovery can derive its local evidence directory from the source', async () => {
        delete source.selectionCacheDirectory;
        const run = async (request: any, _file: string, output: string) => fs.writeFileSync(output, JSON.stringify(respond(request, output)));
        const checks = await prepareTopicAudio(input(), config, source, {}, runtime, { run, now: () => 0 });
        expect(checks!.evidence.inputPath).toContain(path.join(dir, 'temp', 'media.opus', 'topic_selection'));
        expect(checks!.windows[0].status).toBe('aligned');
    });
    test('timeout holds, consumes cost budget, and never retries', async () => {
        let clock = 0; const diagnostics: any = {};
        const run = jest.fn(async () => { clock += 180000; throw new Error('timeout'); });
        const checks = await prepareTopicAudio(input(), config, source, diagnostics, runtime, { run, now: () => clock });
        expect(checks!.skipped[0].reason).toBe('timeout');
        expect(diagnostics.topicAudioBudget).toEqual({ windows: 1, audioSeconds: 28, elapsedMs: 180000 });
        expect(run).toHaveBeenCalledTimes(1);
    });
    test('silent result with invented text fails validation', () => {
        const request = { source: {}, settings: {}, requestSha256: 'x', windows: [{ id: 'A1', hitIds: ['K1'], start: 0, end: 20 }] };
        expect(() => validateTopicAudio({ version: 1, method: 'topic_audio_pair', ...request,
            windows: [{ ...request.windows[0], status: 'no_speech', audioSha256: digest('a'), duration: 20,
                vad: [], alignment: { matches: [] }, unprompted: { text: 'hello' } }] }, request)).toThrow('Silence');
    });
});
