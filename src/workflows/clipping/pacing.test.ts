import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Artifact, EnhancementIO, enhancePacing } from './enhancement';
describe('daily precision pacing', () => {
    let directory: string, baseline: Artifact;
    const speech = [{ start: 0, end: 5, text: 'Setup' }, { start: 15, end: 20, text: 'No, corrected ending' }]
        .map(row => ({ ...row, asrEvidence: { sourceSpan: { start: row.start, end: row.end } } }));
    const input = { sourceId: 'v', window: { start: 0, end: 20 }, speech, audience: [], allowEditing: true,
        streamerName: 'Host', audioEvidence: [{ id: 'P1', sourceId: 'v', kind: 'silence' as const, start: 6, end: 10, verified: true, precisionSeconds: .01 }] };
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pacing-'));
        for (const name of ['video.mp4', 'video.srt', 'cover.jpg']) fs.writeFileSync(path.join(directory, name), Buffer.from([255, 216, 255, 217]));
        baseline = { copy: { title: 'Verified specific title', coverText: 'Verified\nCover', description: 'Verified source event' },
            uploadReady: true, window: { start: 0, end: 20, duration: 20 }, precisionExperiment: { selected: true },
            output: { mediaPath: path.join(directory, 'video.mp4'), srtPath: path.join(directory, 'video.srt'), coverPath: path.join(directory, 'cover.jpg'), burnedSubtitles: true } };
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
    const hooks = (keep = false, approved = true): EnhancementIO => ({
        request: jest.fn(async stage => JSON.stringify(stage === 'edit' ? { removeEvidenceIds: keep ? [] : ['P1'], reason: 'Verified idle delay' }
            : { approved, checks: { meaning: approved, continuity: approved }, issues: approved ? [] : ['visual action matters'] })),
        inspectPauses: async () => Array(3).fill(baseline.output.coverPath),
        renderEdit: jest.fn(async plan => ({ ...baseline, output: { ...baseline.output }, editPlan: plan })),
        renderCover: async () => baseline.output.coverPath!,
        inspectMedia: async () => ({ passed: true, issues: [], frames: [baseline.output.coverPath!] })
    });
    test('no useful evidence makes zero model requests and retains the ordinary artifact', async () => {
        const io = hooks(); const result = await enhancePacing(baseline, { ...input, audioEvidence: [] }, io);
        expect(io.request).not.toHaveBeenCalled(); expect(result.output).toEqual(baseline.output);
        expect(result.uploadReady).toBe(true); expect(result.precisionExperiment.selected).toBe(false);
    });
    test('successful pacing needs only edit and continuity QA and preserves reviewed copy', async () => {
        const io = hooks(); const result = await enhancePacing(baseline, input, io);
        expect((io.request as jest.Mock).mock.calls.map(call => call[0])).toEqual(['edit', 'qa']);
        expect(result.pacingResult.status).toBe('edited'); expect(result.pacingResult.removedSeconds).toBeCloseTo(3.4);
        expect(result.copy.title).toBe(baseline.copy.title); expect(result.qaResult.status).toBe('passed');
    });
    test.each(['keep', 'reject', 'timeout', 'attribution'])('%s restores the ordinary version without a repackaging retry chain', async mode => {
        const io = hooks(mode === 'keep', mode !== 'reject');
        if (mode === 'timeout') io.request = jest.fn(async () => { throw new Error('timeout'); });
        const result = await enhancePacing(baseline, { ...input, attributionRequired: mode === 'attribution' }, io);
        expect(result.output).toEqual(baseline.output); expect(result.copy).toEqual(baseline.copy);
        expect(result.uploadReady).toBe(true); expect(result.precisionExperiment.selected).toBe(false);
        expect((io.request as jest.Mock).mock.calls.length).toBeLessThanOrEqual(2);
    });
});
