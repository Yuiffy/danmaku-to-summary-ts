import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertBundleRetention, bundleAudioFilter, bundleMembers, main } from './precisionBundle';
import { createHash } from 'crypto';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'precision-bundle-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
    const put = (name: string, contents: string) => { const file = path.join(directory, name); fs.writeFileSync(file, contents); return file; };
    const source = { mediaPath: put('source.mp4', 'media'), srtPath: put('source.srt', 'speech') };
    const clips = Object.fromEntries([1, 2].map(id => [id, { id, pendingCut: true,
        candidateSrtPath: put(`${id}.srt`, 'speech'), metadataPath: put(`${id}.json`, JSON.stringify({ roomId: 'room', source,
            window: { start: id * 10, end: id * 10 + 5 }, aiReview: { status: 'ready', keyword: { status: 'confirmed' }, quality: { issues: [] } } })),
    }]));
    return { clips };
}
test('members keep their numeric IDs, sort by source time and bind all original files without mutating the registry', () => {
    const registry = fixture(), before = JSON.stringify(registry);
    const result = bundleMembers([2, 1], registry, { jobs: [] });
    expect(result.map(m => m.id)).toEqual([1, 2]);
    expect(result[0].metadataSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(registry)).toBe(before);
});
test.each(['active', 'published', 'overlap', 'source', 'preflight', 'edits'])('refuses %s members before rendering', kind => {
    const registry = fixture(), queue: any = { jobs: [] }, clip = registry.clips[2];
    const metadata = JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8'));
    if (kind === 'active') queue.jobs.push({ status: 'pending', clipIds: [2] });
    if (kind === 'published') Object.assign(clip, { uploadState: { bvid: 'BV1234567890' } });
    if (kind === 'overlap') metadata.window.start = 12;
    if (kind === 'source') metadata.roomId = 'another room';
    if (kind === 'preflight') metadata.aiReview.keyword.status = 'uncertain';
    if (kind === 'edits') metadata.candidateSubtitles = { edits: [{ from: 'one', to: 'two' }] };
    fs.writeFileSync(clip.metadataPath, JSON.stringify(metadata));
    expect(() => bundleMembers([1, 2], registry, queue)).toThrow();
});
test('a successful creative QA cannot silently omit the second topic or its mention', () => {
    const mappings = [{ id: 1, keywordSpans: [{ start: 1, end: 2 }] }, { id: 2, keywordSpans: [{ start: 11, end: 12 }] }];
    expect(() => assertBundleRetention(mappings, [{ start: 0, end: 5 }])).toThrow('2');
    expect(() => assertBundleRetention(mappings, [{ start: 0, end: 5 }, { start: 11.5, end: 15 }])).toThrow('2');
    expect(() => assertBundleRetention(mappings, [{ start: 0, end: 5 }, { start: 10, end: 15 }])).not.toThrow();
});

const realMedia = process.env.DANMAKU_TEST_REAL_MEDIA === '1' ? test : test.skip;
realMedia('normalization preserves an internal timestamp gap as silence instead of shortening decoded dialogue', async () => {
    const { runFfmpeg } = require('../../scripts/clipping/media_runtime');
    const source = path.join(directory, 'gap.mka'), output = path.join(directory, 'aligned.pcm');
    await runFfmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=230:sample_rate=48000:duration=3',
        '-af', "asetpts=PTS+if(gte(T\\,1)\\,0.15/TB\\,0)", '-c:a', 'pcm_f32le', source], { threads: 1 });
    await runFfmpeg(['-v', 'error', '-y', '-i', source, '-af', bundleAudioFilter(3.15),
        '-ar', '48000', '-ac', '1', '-f', 'f32le', output], { threads: 1 });
    const data = fs.readFileSync(output), samples = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
    expect(samples.length / 48000).toBeCloseTo(3.15, 3);
    const rms = (start: number, end: number) => Math.sqrt(samples.slice(start * 48000, end * 48000)
        .reduce((sum, sample) => sum + sample * sample, 0) / ((end - start) * 48000));
    expect(rms(.6, .8)).toBeGreaterThan(.05);
    expect(rms(1.05, 1.12)).toBeLessThan(.005);
    expect(rms(1.4, 1.6)).toBeGreaterThan(.05);
}, 120000);

test('the registry bundle uses complete saved baseline metadata, publishes no members and leaves one reviewed artifact', async () => {
    const registry = fixture(), registryPath = path.join(directory, 'registry.json'), queuePath = path.join(directory, 'queue.json');
    for (const clip of Object.values(registry.clips)) {
        const metadata = JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8'));
        metadata.aiReview.sourceSha256 = 'original-evidence';
        metadata.aiReview.keyword.hits = [{ start: metadata.window.start + 1, end: metadata.window.start + 2 }];
        Object.assign(metadata, { upload: {}, streamerName: '主播' });
        fs.writeFileSync(clip.metadataPath, JSON.stringify(metadata));
        Object.assign(clip, { candidateSrtSha256: createHash('sha256').update(fs.readFileSync(clip.candidateSrtPath)).digest('hex') });
    }
    fs.writeFileSync(registryPath, JSON.stringify(registry)); fs.writeFileSync(queuePath, JSON.stringify({ jobs: [] }));
    const before = fs.readFileSync(registryPath, 'utf8');
    const apply = jest.fn(async ([baseline]) => {
        expect(baseline.uploadReady).toBe(true);
        expect(baseline.output.burnedSubtitles).toBe(true);
        expect(baseline.candidateBundle.ids).toEqual([1, 2]);
        return [{ ...baseline, creativeResult: { status: 'edited' }, qaResult: { status: 'passed' }, audioQa: { status: 'passed' },
            editPlan: { keep: [{ start: 0, end: 10 }] } }];
    });
    const modules = (name: string): any => {
        if (name.endsWith('config-loader')) return { getConfig: () => ({}) };
        if (name.endsWith('topic_clipper')) return { parseTopicSrt: () => ({ segments: [{ start: 0, end: 3, text: '原话' }] }),
            resolveFfprobePath: () => 'ffprobe', getClipTopicsConfig: () => ({}),
            runFfmpeg: async (args: string[]) => { expect(args).toContain('-c:v'); fs.writeFileSync(args.at(-1)!, 'aligned source'); } };
        if (name.endsWith('resource_scheduler')) return { createClipResourceAdaptiveScheduler: () => ({ enabled: false, getProfile: () => ({ ffmpegThreads: 1 }) }) };
        if (name.endsWith('creative_subtitles')) return { srtText: () => 'subtitles' };
        if (name.endsWith('preflight_evidence')) return { buildPreflightEvidence: () => ({ sourceSha256: 'original-evidence' }) };
        if (name.endsWith('subtitle_evidence')) return { buildSubtitleEvidence: () => ({}) };
        if (name.endsWith('topic_compilation')) return { buildCompilation: async (_plan: unknown, out: string) => {
            fs.writeFileSync(out, 'raw combined source');
            return { outputVideo: out, outputSrt: out + '.srt', manifest: { actualDuration: 10, segments: [{ actualDuration: 5 }, { actualDuration: 5 }] } };
        } };
        if (name.endsWith('manual_clip_queue')) return { cutTask: async (task: any) => {
            const output = { metadataPath: path.join(task.outputDir, 'baseline.json'), burnedSubtitles: true };
            fs.writeFileSync(output.metadataPath, JSON.stringify({ uploadReady: true, window: { start: 0, end: 10, duration: 10 }, output }));
            return { output }; // The actual shared cutter returns a summary, not the metadata.
        } };
        if (name.endsWith('editorial_styles')) return { applyStyles: apply };
        throw new Error('Unexpected dependency: ' + name);
    };
    await main(['--project-root', directory, '--registry', registryPath, '--queue', queuePath, '--ids', '1,2',
        '--note', '用户指定两个话题', '--title', '双话题', '--description', '分别保留两段', '--cover-text', '两个话题'], { modules });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(registryPath, 'utf8')).toBe(before);
    const parent = path.join(directory, 'precision_bundles', '1-2'), revision = path.join(parent, fs.readdirSync(parent)[0]);
    expect(JSON.parse(fs.readFileSync(path.join(revision, 'RESULT.json'), 'utf8'))).toMatchObject({ status: 'pending_review', uploadAuthorized: false });
    expect(JSON.parse(fs.readFileSync(path.join(revision, 'baseline.json'), 'utf8')).uploadReady).toBe(false);
});
