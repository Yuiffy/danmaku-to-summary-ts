import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Artifact, EnhancementIO, enhanceArtifact, qaIsCurrent, fullEvidence } from './enhancement';

describe('independent clip QA', () => {
    let directory: string, artifact: Artifact;
    const input = { sourceId: 'video', window: { start: 0, end: 60 }, allowEditing: false,
        speech: [{ start: 0, end: 10, text: 'Setup' }, { start: 25, end: 35, text: 'MIDDLE CORRECTION' },
            { start: 50, end: 60, text: 'Conclusion' }], audience: [], audioEvidence: [], streamerName: 'Host' };
    const approved = { approved: true, checks: { meaning: true, attribution: true, title: true, cover: true, subtitles: true, completeStory: true }, issues: [] };
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-qa-'));
        const mediaPath = path.join(directory, 'clip.mp4'), srtPath = path.join(directory, 'clip.srt'), coverPath = path.join(directory, 'cover.jpg');
        fs.writeFileSync(mediaPath, 'fixture video'); fs.writeFileSync(srtPath, 'fixture subtitles');
        fs.writeFileSync(coverPath, Buffer.from([255, 216, 255, 217]));
        artifact = { copy: { title: 'Initial', description: 'Initial', coverText: 'Initial' }, window: { start: 0, end: 60, duration: 60 },
            uploadReady: true, output: { mediaPath, srtPath, coverPath, burnedSubtitles: true } };
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
    const io = (qaResults: unknown[] = [approved]): EnhancementIO => ({
        request: jest.fn(async (stage, prompt, images) => {
            expect(prompt).toContain('MIDDLE CORRECTION');
            if (stage === 'packaging') return JSON.stringify({ variants: [{ title: 'Final', description: 'Final', coverText: 'First\nSecond' }] });
            expect(images?.[0]).toMatch(/^data:image\/jpeg;base64,/);
            return JSON.stringify(stage === 'cover' ? { selectedIndex: 0 } : qaResults.shift() || { approved: false, issues: ['meaning changed'] });
        }),
        renderEdit: jest.fn(async () => artifact), renderCover: jest.fn(async () => artifact.output.coverPath!),
        inspectMedia: jest.fn(async () => ({ passed: true, issues: [], frames: [artifact.output.coverPath!] }))
    });

    test('uses rendered images and complete evidence, binds artifacts, but never authorizes upload', async () => {
        const hooks = io();
        const result = await enhanceArtifact(artifact, input, hooks);
        expect(result.uploadReady).toBe(true);
        expect(result.qaResult.status).toBe('passed');
        expect(result).not.toHaveProperty('uploadApproved');
        expect(await qaIsCurrent(result)).toBe(true);
        result.copy.title = 'Changed fact';
        expect(await qaIsCurrent(result)).toBe(false);
        expect(hooks.request).toHaveBeenCalledTimes(3);
    });

    test('at most one repair then a separately reviewed conservative continuous fallback', async () => {
        const hooks = io([{ approved: false, issues: ['bad'] }, { approved: false, issues: ['still bad'] }, approved]);
        const result = await enhanceArtifact(artifact, input, hooks);
        expect(result.enhancementFallback).toBe(true);
        expect(result.editPlan?.removed).toEqual([]);
        expect(result.qaResult.history.filter(row => row.phase === 'independent_qa')).toHaveLength(3);
        expect((hooks.request as jest.Mock).mock.calls.filter(call => call[0] === 'packaging')).toHaveLength(2);
    });

    test('persistent rejection or media/image failure never produces an upload-ready clip', async () => {
        const hooks = io([]);
        const result = await enhanceArtifact(artifact, input, hooks);
        expect(result.uploadReady).toBe(false);
        expect(result.qaResult.status).toBe('failed');
        const broken = io();
        broken.inspectMedia = async () => ({ passed: false, issues: ['missing audio'], frames: [] });
        expect((await enhanceArtifact(artifact, input, broken)).uploadReady).toBe(false);
        fs.writeFileSync(artifact.output.coverPath!, 'broken image');
        expect((await enhanceArtifact(artifact, input, io())).uploadReady).toBe(false);
    });

    test('deleted audience content remains source context but cannot support final copy', () => {
        const evidence = JSON.parse(fullEvidence({ ...input, audience: [{ id: 'D1', time: 25, text: 'removed' },
            { id: 'D2', time: 45, text: 'retained' }] }, { version: 1, sourceId: 'video', sourceWindow: input.window,
            keep: [{ start: 0, end: 20 }, { start: 40, end: 60 }],
            removed: [{ start: 20, end: 40, reason: 'silence', evidenceIds: ['A1'] }] }));
        expect(evidence.sourceAudience).toHaveLength(2);
        expect(evidence.retainedAudience).toEqual([{ id: 'D2', time: 45, text: 'retained', outputTime: 25 }]);
    });
});
