import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { renderSocialPost, reviewSocialPost, SocialPostIO } from './socialPostRuntime';

let root: string, plan: string, output: string;
beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'social-post-')); plan = path.join(root, 'plan.json'); output = path.join(root, 'render');
    await sharp({ create: { width: 600, height: 240, channels: 3, background: '#fff' } }).png().toFile(path.join(root, 'source.png'));
    fs.writeFileSync(plan, JSON.stringify({ version: 1,
        source: { image: 'source.png', author: '作者', url: 'https://weibo.com/detail/123', captureUrl: 'https://weibo.com/detail/123',
            publishedAt: '2026-08-28T14:24:00+08:00', text: '原帖', captureLabel: '原帖截图' },
        copy: { title: '标题', description: '说明', tags: ['微博'] }, scenes: [{ seconds: 4, heading: '完整原帖' }] }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const fake = (): SocialPostIO => ({ encoder: 'h264_nvenc', preset: 'p4',
    run: async args => { const file = args[args.length - 1]; if (file.endsWith('.mp4')) fs.writeFileSync(file, 'fake adapter media'); },
    probe: async () => ({ width: 1920, height: 1080, duration: 4, audio: true }) });

test('render snapshots evidence and remains pending; local review binds actual files without queues', async () => {
    const result = await renderSocialPost(plan, output, fake());
    expect(result.uploadReady).toBe(false);
    expect(result.source.image.startsWith(output)).toBe(true);
    fs.unlinkSync(path.join(root, 'source.png')); // Durable artifact does not depend on the scratch input.
    const reviewed = reviewSocialPost(path.join(output, 'UPLOAD_MANIFEST.json'), 'Inspected source and final media', 'test operator');
    expect(reviewed.socialPostReview.status).toBe('passed');
    expect(reviewed.socialPostReview.reviewer).toBe('test operator');
    expect(fs.existsSync(path.join(output, 'UPLOAD_MANIFEST.json.pending.json'))).toBe(true);
});
test('changed output before review is rejected instead of reblessing an unverified render', async () => {
    await renderSocialPost(plan, output, fake());
    fs.appendFileSync(path.join(output, 'VIDEO.mp4'), 'changed');
    expect(() => reviewSocialPost(path.join(output, 'UPLOAD_MANIFEST.json'), 'note', 'operator')).toThrow('changed before review');
});
test('bad probe or failed rendering never produces an upload manifest', async () => {
    const io = fake(); io.probe = async () => ({ width: 100, height: 100, duration: 4, audio: true });
    await expect(renderSocialPost(plan, output, io)).rejects.toThrow('checks');
    expect(fs.existsSync(path.join(output, 'UPLOAD_MANIFEST.json'))).toBe(false);
});
test('NVENC failure uses explicit CPU fallback and records the actual encoder', async () => {
    const io = fake(), run = io.run, codecs: string[] = [];
    io.run = async args => {
        const codec = args[args.indexOf('-c:v') + 1]; codecs.push(codec);
        if (codec === 'h264_nvenc') throw new Error('GPU unavailable');
        return run(args);
    };
    const result = await renderSocialPost(plan, output, io);
    expect(codecs).toEqual(expect.arrayContaining(['h264_nvenc', 'libx264']));
    expect(result.render.encoder).toBe('libx264');
});
test('additional comment pages are snapshotted and included in review evidence', async () => {
    fs.copyFileSync(path.join(root, 'source.png'), path.join(root, 'comments.png'));
    const p = JSON.parse(fs.readFileSync(plan, 'utf8'));
    p.source.pages = [{ image: 'comments.png', label: '观众评论截图', comments: [{ author: '观众', text: '评论', publishedAt: '2026-08-28' }] }];
    p.scenes = [{ seconds: 2, heading: '原帖' }, { seconds: 2, heading: '评论区', page: 1 }];
    fs.writeFileSync(plan, JSON.stringify(p));
    const result = await renderSocialPost(plan, output, fake());
    expect(result.source.pages?.[0].image.startsWith(output)).toBe(true);
    expect(result.inputHashes).toHaveProperty('page1');
    fs.appendFileSync(result.source.pages![0].image, 'changed');
    expect(() => reviewSocialPost(path.join(output, 'UPLOAD_MANIFEST.json'), 'note', 'operator')).toThrow('Source changed');
});
