import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { planBoundaryAudio, prepareBoundaryAudio } from './topicBoundaryAudio';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const input = { target: { names: ['岁己'] }, subtitles: [
    { id: 'G1', start: 10, end: 18, text: '明确的回答和模糊尾句' },
    { id: 'G2', start: 18, end: 24, text: '下一句' }, { id: 'G3', start: 24, end: 40, text: '后续上下文' }] };
const plan = { clips: [{ status: 'needs_review', reason: '尾句需听音判断是否补充回应',
    boundaryReview: { unresolvedCueIds: ['G1', 'G2'] } }] };

describe('bounded pre-render boundary audio diagnosis', () => {
    let dir: string, source: any, runtime: any;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-audio-'));
        source = { mediaPath: path.join(dir, 'source.mp4'), srtPath: path.join(dir, 'source.srt') };
        runtime = { scriptPath: path.join(dir, 'audio.py'), model: 'nano', sensevoiceModel: 'sensevoice' };
        for (const file of [source.mediaPath, source.srtPath, runtime.scriptPath]) fs.writeFileSync(file, 'original');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = { review: { audioChecks: { enabled: true } } };
    function adapter(change?: (result: any) => void) {
        return { now: () => 1, run: jest.fn(async (file: string, output: string) => {
            const request = JSON.parse(fs.readFileSync(file, 'utf8'));
            expect(request.settings.use_itn).toBe(false);
            expect(request.settings.hotwords).toBeUndefined();
            expect(request.windows[0]).not.toHaveProperty('text');
            const result = { version: 1, requestSha256: request.requestSha256, source: request.source,
                windows: request.windows.map((window: any) => {
                    const audioPath = path.join(path.dirname(output), window.id + '.wav');
                    fs.writeFileSync(audioPath, 'audio');
                    return { ...window, audioPath, audioSha256: digest('audio'), decodes: ['nano', 'sensevoice'].map(model => ({
                        model, text: '完整回答，接着聊别的话题', prompted: false, hotwords: [], useItn: false, timingPrecision: 'window' })) };
                }) };
            change?.(result); fs.writeFileSync(output, JSON.stringify(result));
        }) };
    }
    test('merges adjacent concrete doubts, without demanding audio for a passing or vague plan', () => {
        expect(planBoundaryAudio(plan, input)).toEqual([{ id: 'A1', start: 10, end: 27, cueIds: ['G1', 'G2'] }]);
        expect(planBoundaryAudio({ clips: [{ ...plan.clips[0], status: 'ready' }] }, input)).toEqual([]);
        expect(planBoundaryAudio({ clips: [{ ...plan.clips[0], reason: '结尾感觉不好' }] }, input)).toEqual([]);
        expect(planBoundaryAudio({ clips: [{ ...plan.clips[0], boundaryReview: { unresolvedCueIds: ['G99'] } }] }, input)).toEqual([]);
    });
    test('diagnoses six adjacent doubtful cues within two windows and the shared audio budget', async () => {
        const cues = [10, 14, 18, 40, 44, 48].map((start, index) => ({
            id: `G${index + 1}`, start, end: start + 3, text: '需要核对原音的连续字幕'
        }));
        const manyInput = { ...input, subtitles: [
            { id: 'before', start: 0, end: 5, text: '前文' }, ...cues,
            { id: 'after', start: 60, end: 65, text: '后文' }
        ] };
        const manyPlan = { clips: [{ ...plan.clips[0],
            boundaryReview: { unresolvedCueIds: cues.map(cue => cue.id) } }] };
        const diagnostics = {}, io = adapter();
        const result = await prepareBoundaryAudio(manyPlan, manyInput, config, source, diagnostics, runtime, io);
        expect(result?.status).toBe('available');
        expect(result?.windows.map(({ start, end, cueIds }: any) => ({ start, end, cueIds }))).toEqual([
            { start: 7, end: 24, cueIds: ['G1', 'G2', 'G3'] },
            { start: 37, end: 54, cueIds: ['G4', 'G5', 'G6'] }
        ]);
        expect(io.run).toHaveBeenCalledTimes(1);
        expect(diagnostics).toMatchObject({ topicAudioBudget: { windows: 2, audioSeconds: 34 } });
        expect(manyPlan.clips[0].status).toBe('needs_review');
        expect(planBoundaryAudio(manyPlan, { ...manyInput, subtitles: manyInput.subtitles.map(cue =>
            cue.id === 'G6' ? { ...cue, start: 60, end: 63 } : cue) })).toEqual([]);
    });
    test('keeps two independent bound hypotheses and leaves all source words unchanged', async () => {
        const io = adapter(), before = JSON.stringify(input), diagnostics = {};
        const result = await prepareBoundaryAudio(plan, input, config, source, diagnostics, runtime, io);
        expect(result?.status).toBe('available');
        expect(result?.windows[0].cueIds).toEqual(['G1', 'G2']);
        expect(result?.windows[0].decodes).toHaveLength(2);
        expect(JSON.stringify(input)).toBe(before);
        expect(fs.readFileSync(source.srtPath, 'utf8')).toBe('original');
        expect(diagnostics).toMatchObject({ topicAudioBudget: { windows: 1, audioSeconds: 17 } });
    });
    test.each(['source', 'window', 'prompt', 'audio', 'mutation'])('rejects changed %s evidence', async kind => {
        const io = adapter(result => {
            if (kind === 'source') result.source.srtSha256 = 'bad';
            if (kind === 'window') result.windows[0].end++;
            if (kind === 'prompt') result.windows[0].decodes[0].hotwords = ['岁己'];
            if (kind === 'audio') result.windows[0].audioSha256 = 'bad';
            if (kind === 'mutation') fs.writeFileSync(source.srtPath, 'changed');
        });
        expect((await prepareBoundaryAudio(plan, input, config, source, {}, runtime, io))?.status).toBe('unavailable');
    });
    test('shared recording budget blocks additional requests and failures do not approve the plan', async () => {
        const io = adapter();
        const result = await prepareBoundaryAudio(plan, input, config, source,
            { topicAudioBudget: { windows: 6, audioSeconds: 180, elapsedMs: 0 } }, runtime, io);
        expect(result?.status).toBe('unavailable'); expect(io.run).not.toHaveBeenCalled();
        expect(plan.clips[0].status).toBe('needs_review');
    });
});
