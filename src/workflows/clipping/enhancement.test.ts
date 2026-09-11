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
        expect(result.copy.title).toBe(artifact.copy.title);
        expect(result.editPlan?.removed).toEqual([]);
        expect(result.qaResult.history.filter(row => row.phase === 'independent_qa')).toHaveLength(3);
        expect((hooks.request as jest.Mock).mock.calls.filter(call => call[0] === 'packaging')).toHaveLength(2);
    });

    test('JSON punctuation repair keeps the same generation and QA separates producer tags from event claims', async () => {
        const hooks = io();
        artifact.copy.tags = ['AI切片'];
        const original = hooks.request;
        hooks.request = jest.fn(async (stage, prompt, images) => {
            if (stage === 'packaging') return '{"variants":[{"title":"准确标题"，"coverText":"第一行\\n第二行"，"description":"准确描述"}]}';
            if (stage === 'qa') {
                const copy = prompt.split('FINAL COPY ')[1].split('\nPRODUCER METADATA')[0];
                expect(JSON.parse(copy)).not.toHaveProperty('tags');
                expect(prompt).toContain('"tags":["AI切片"]');
            }
            return original(stage, prompt, images);
        });
        const result = await enhanceArtifact(artifact, input, hooks);
        expect(result.qaResult.status).toBe('passed');
        expect(hooks.request).toHaveBeenCalledTimes(3);
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

    test('experiment disclosure is present during final QA and included in its content binding', async () => {
        const hooks = io();
        const result = await enhanceArtifact(artifact, { ...input, experimentSelected: true }, hooks);
        expect(result.copy.description).toContain('\u7cbe\u5207\u5b9e\u9a8c\u6a21\u5f0f');
        const audit = (hooks.request as jest.Mock).mock.calls.find(call => call[0] === 'qa');
        expect(audit[1]).toContain(result.copy.description.split('\n')[0]);
        expect(await qaIsCurrent(result)).toBe(true);
    });

    test('actor approval for changed copy precedes final QA, and a rejection enters bounded repair', async () => {
        const hooks = io();
        const order: string[] = [];
        const request = hooks.request;
        hooks.request = async (stage, prompt, images) => { if (stage === 'qa') order.push('qa'); return request(stage, prompt, images); };
        hooks.reviewAttribution = jest.fn(async current => {
            order.push('actor');
            expect(current.copy.description).toContain('精切实验模式');
            return { passed: order.length > 1, issues: order.length === 1 ? ['wrong_actor'] : [],
                attributionReview: { status: order.length === 1 ? 'needs_review' : 'passed' } };
        });
        const result = await enhanceArtifact(artifact, { ...input, experimentSelected: true, attributionRequired: true }, hooks);
        expect(order).toEqual(['actor', 'actor', 'qa']);
        expect(result.attributionReview.status).toBe('passed');
        expect(result.uploadReady).toBe(true);
    });

    test('unavailable final actor review cannot be bypassed by a permissive visual reviewer', async () => {
        const hooks = io();
        const result = await enhanceArtifact(artifact, { ...input, experimentSelected: true, attributionRequired: true }, hooks);
        expect(result.uploadReady).toBe(false);
        expect((hooks.request as jest.Mock).mock.calls.filter(call => call[0] === 'qa')).toHaveLength(0);
    });
});
