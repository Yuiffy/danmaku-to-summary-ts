import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { renderHighlightFirst, StyleIO } from './styleRuntime';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-style-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function setup() {
    const put = (file: string, value: string | object) => {
        const full = path.join(dir, file); fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value)); return full;
    };
    const srt = '1\n00:00:00,000 --> 00:00:03,000\n开场\n\n2\n00:00:08,000 --> 00:00:11,000\n重点\n';
    const media = put('baseline.mp4', 'baseline'), subtitles = put('baseline.srt', srt);
    const metadata = put('baseline.json', { output: { mediaPath: media, srtPath: subtitles, burnedSubtitles: true },
        uploadReady: true, qaResult: { status: 'passed' }, publicationReview: { approved: true }, copy: { title: '重点' } });
    put('op.mp4', 'op'); put('op.srt', srt.slice(0, srt.indexOf('\n\n')));
    const opManifest = put('OP.json', { mediaPath: 'op.mp4', srtPath: 'op.srt', mediaSha256: sha('op'),
        srtSha256: sha(srt.slice(0, srt.indexOf('\n\n'))) });
    const output = path.join(dir, 'revision');
    const io: StyleIO = { probe: jest.fn(async file => ({ duration: file === media ? 30 : file.endsWith('op.mp4') ? 6 : 39,
        width: 1920, height: 1080, audio: true })),
        measureAudio: jest.fn(async file => ({ integrated: file.endsWith('op.mp4') ? -12 : -24, truePeak: -3 })),
        render: jest.fn(async (_file, out) => { fs.writeFileSync(out, 'part'); }),
        concat: jest.fn(async (_file, out) => { fs.writeFileSync(out, 'render'); }) };
    return { media, metadata, opManifest, output, io, plan: { version: 1 as const, highlights: [{ start: 8, end: 11 }], reason: '重点' } };
}
test('rendered revision has repeated teaser subtitles, source bindings and fresh pending review', async () => {
    const f = setup(), original = fs.readFileSync(f.metadata, 'utf8');
    const result = await renderHighlightFirst(f, f.io);
    expect(result.uploadReady).toBe(false);
    expect(result.qaResult.status).toBe('pending');
    expect(result).not.toHaveProperty('publicationReview');
    expect(fs.readFileSync(f.metadata, 'utf8')).toBe(original);
    expect(f.io.render).toHaveBeenCalledTimes(3);
    expect(f.io.render).toHaveBeenNthCalledWith(2, path.join(dir, 'op.mp4'), path.join(f.output, 'part-1.mp4'), 0, 6,
        expect.any(Object), -13);
    expect(result.editorialTimeline.audioMix.status).toBe('passed');
    expect(fs.readFileSync(result.output.srtPath, 'utf8').match(/重点/g)).toHaveLength(2);
    expect(result.editorialTimeline.binding.media).toBe(sha('baseline'));
    await expect(renderHighlightFirst(f, f.io)).rejects.toThrow();
});
test.each(['source', 'probe', 'render'])('a %s failure produces no success metadata', async kind => {
    const f = setup();
    if (kind === 'source') f.io.concat = async (_list, out) => { fs.writeFileSync(out, 'render'); fs.writeFileSync(f.media, 'changed'); };
    if (kind === 'probe') f.io.probe = async file => ({ duration: file === f.media ? 30 : 6, width: 1920, height: 1080, audio: true });
    if (kind === 'render') f.io.render = async () => { throw new Error('NVENC and fallback failed'); };
    await expect(renderHighlightFirst(f, f.io)).rejects.toThrow();
    expect(fs.existsSync(path.join(f.output, 'highlight_first.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(f.output, 'FAILED.json'), 'utf8')).uploadReady).toBe(false);
});
test('changed OP and another source plan fail before any media adapter runs', async () => {
    const f = setup(); fs.writeFileSync(path.join(dir, 'op.mp4'), 'changed');
    await expect(renderHighlightFirst(f, f.io)).rejects.toThrow(/hashes/);
    expect(f.io.render).not.toHaveBeenCalled();
});
test('plan bindings also reject a replaced baseline and revised subtitles', async () => {
    const f = setup();
    await expect(renderHighlightFirst({ ...f, plan: { ...f.plan, baselineMediaSha256: sha('other') } }, f.io)).rejects.toThrow(/different baseline/);
    await expect(renderHighlightFirst({ ...f, plan: { ...f.plan, baselineSubtitlesSha256: sha('other') } }, f.io)).rejects.toThrow(/subtitles/);
    expect(f.io.render).not.toHaveBeenCalled();
});
test('loud rendered OP fails the revision instead of receiving pending success metadata', async () => {
    const f = setup();
    f.io.measureAudio = jest.fn(async file => ({ integrated: file === f.media ? -24 : -10, truePeak: -2 }));
    await expect(renderHighlightFirst(f, f.io)).rejects.toThrow(/louder/);
    expect(fs.existsSync(path.join(f.output, 'highlight_first.json'))).toBe(false);
});
