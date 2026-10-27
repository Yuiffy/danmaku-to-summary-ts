import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import { escapeSvg, fitSocialPostImage, SocialPostPlan, socialPostDescription, validateSocialPost } from '../../workflows/clipping/socialPost';

export const hashFile = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
export interface SocialPostIO {
    run(args: string[]): Promise<unknown>;
    encoder: string;
    preset: string;
    probe(file: string): Promise<{ width: number; height: number; duration: number; audio: boolean }>;
}
export function readPlan(file: string): SocialPostPlan {
    const plan: SocialPostPlan = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const local = (value: string) => path.resolve(path.dirname(file), value);
    plan.source.image = local(plan.source.image);
    for (const page of plan.source.pages || []) page.image = local(page.image);
    if (plan.music) plan.music.path = local(plan.music.path);
    return plan;
}
function inputHashes(plan: SocialPostPlan) {
    return { screenshot: hashFile(plan.source.image), ...(plan.music ? { music: hashFile(plan.music.path) } : {}),
        ...Object.fromEntries((plan.source.pages || []).map((p, i) => [`page${i + 1}`, hashFile(p.image)])) };
}
async function sceneImage(plan: SocialPostPlan, index: number, output: string) {
    const scene = plan.scenes[index], page = scene.page ? plan.source.pages![scene.page - 1] : undefined;
    const image = page?.image || plan.source.image, meta = await sharp(image).metadata();
    const { card } = fitSocialPostImage({ width: meta.width!, height: meta.height! });
    const label = `${plan.source.author} · ${plan.source.publishedAt.slice(0, 10)} · 微博`;
    const footer = page?.label || plan.source.captureLabel;
    if (Array.from(label).length > 55 || Array.from(footer).length > 65) throw new Error('Source display label is too long');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
      <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#fff8f3"/><stop offset="1" stop-color="#fce9f0"/></linearGradient></defs>
      <rect width="1920" height="1080" fill="url(#bg)"/>
      <circle cx="1840" cy="70" r="230" fill="#f7d4df" opacity=".4"/>
      <circle cx="40" cy="1030" r="220" fill="#f7d4df" opacity=".3"/>
      <g font-family="Microsoft YaHei, sans-serif" text-anchor="middle">
        <text x="960" y="135" font-weight="bold" font-size="72" fill="#382c37">${escapeSvg(scene.heading)}</text>
        <text x="960" y="215" font-size="31" fill="#826b79">${escapeSvg(label)}</text>
        <text x="960" y="1015" font-size="27" fill="#826b79">${escapeSvg(footer)}</text>
      </g>
      <rect x="${card.x - 18}" y="${card.y - 18}" width="${card.width + 36}" height="${card.height + 36}" rx="20" fill="#ffffff"/>
    </svg>`;
    const screenshot = await sharp(image).resize(card.width, card.height).png().toBuffer();
    const layers: sharp.OverlayOptions[] = [{ input: screenshot, left: card.x, top: card.y }];
    if (scene.visibleHeight !== undefined && scene.visibleHeight < meta.height!) {
        const visible = Math.round(scene.visibleHeight / meta.height! * card.height);
        const hidden = card.height - visible, fontSize = Math.min(34, Math.max(8, Math.floor(hidden / 2.5)));
        const hint = `<svg xmlns="http://www.w3.org/2000/svg" width="${card.width}" height="${hidden}">
          <rect width="100%" height="100%" fill="#fff5f8"/>
          <path d="M 28 2 H ${card.width - 28}" stroke="#dca8bb" stroke-width="2" stroke-dasharray="10 8"/>
          <text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="Microsoft YaHei, sans-serif"
            font-size="${fontSize}" font-weight="bold" fill="#a05a77">↓ 还有一段，稍后揭晓</text>
        </svg>`;
        layers.push({ input: Buffer.from(hint), left: card.x, top: card.y + visible });
    }
    await sharp(Buffer.from(svg)).composite(layers).png().toFile(output);
}
export async function renderSocialPost(planFile: string, output: string, io: SocialPostIO) {
    const plan = readPlan(planFile), image = await sharp(plan.source.image).metadata();
    const layout = validateSocialPost(plan, { width: image.width!, height: image.height! });
    const bindings = inputHashes(plan), planSha256 = hashFile(planFile);
    fs.mkdirSync(output); // Each render is an immutable new local revision.
    const originalInputs: SocialPostPlan = JSON.parse(JSON.stringify(plan));
    const sources = path.join(output, 'sources'); fs.mkdirSync(sources);
    fs.copyFileSync(plan.source.image, path.join(sources, 'screenshot' + path.extname(plan.source.image)), fs.constants.COPYFILE_EXCL);
    plan.source.image = path.join(sources, 'screenshot' + path.extname(plan.source.image));
    for (let i = 0; i < (plan.source.pages?.length ?? 0); i++) {
        const page = plan.source.pages![i], copy = path.join(sources, `page${i + 1}` + path.extname(page.image));
        fs.copyFileSync(page.image, copy, fs.constants.COPYFILE_EXCL); page.image = copy;
    }
    if (plan.music) {
        const music = path.join(sources, 'music' + path.extname(plan.music.path));
        fs.copyFileSync(plan.music.path, music, fs.constants.COPYFILE_EXCL); plan.music.path = music;
    }
    write(path.join(output, 'PLAN.json'), plan);
    const frames: string[] = [], segments: string[] = [];
    let encoder = io.encoder;
    for (let i = 0; i < plan.scenes.length; i++) {
        const frame = path.join(output, `scene-${i + 1}.png`), segment = path.join(output, `scene-${i + 1}.mp4`);
        await sceneImage(plan, i, frame); frames.push(frame); segments.push(segment);
        const encode = (codec: string) => io.run(['-y', '-loop', '1', '-framerate', '30', '-i', frame,
            '-t', String(plan.scenes[i].seconds), '-an', '-vf', 'format=yuv420p,setsar=1', '-c:v', codec,
            '-preset', codec === 'h264_nvenc' ? io.preset : 'fast', ...(codec === 'h264_nvenc' ? ['-cq', '20'] : ['-crf', '20']),
            '-video_track_timescale', '15360', segment]);
        try { await encode(encoder); }
        catch (error) { if (encoder !== 'h264_nvenc') throw error; encoder = 'libx264'; await encode(encoder); }
    }
    // FFmpeg concat file contains generated basenames only, never user paths.
    const concat = path.join(output, 'segments.txt');
    fs.writeFileSync(concat, segments.map(s => `file '${path.basename(s)}'`).join('\n') + '\n', 'utf8');
    const mediaPath = path.join(output, 'VIDEO.mp4'), coverPath = path.join(output, 'COVER.jpg');
    await io.run(['-y', '-f', 'concat', '-safe', '0', '-i', concat,
        ...(plan.music ? ['-stream_loop', '-1', '-i', plan.music.path] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']),
        '-map', '0:v:0', '-map', '1:a:0', '-t', String(layout.duration), '-c:v', 'copy',
        '-af', `volume=${plan.music?.gainDb ?? -12}dB,afade=t=in:d=0.3,afade=t=out:st=${layout.duration - .8}:d=0.8`,
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', mediaPath]);
    await sharp(frames[0]).jpeg({ quality: 94 }).toFile(coverPath);
    const media = await io.probe(mediaPath);
    if (media.width !== 1920 || media.height !== 1080 || Math.abs(media.duration - layout.duration) > .15 || !media.audio) throw new Error('Rendered media failed dimension/duration/audio checks');
    await io.run(['-v', 'error', '-i', mediaPath, '-f', 'null', '-']);
    if (JSON.stringify(inputHashes(plan)) !== JSON.stringify(bindings) || JSON.stringify(inputHashes(originalInputs)) !== JSON.stringify(bindings)
        || hashFile(planFile) !== planSha256) throw new Error('Input changed during rendering');
    const metadata = { version: 1, type: 'social_post_video', publicationKind: 'social_post', uploadReady: false,
        source: { ...plan.source, sourceKind: 'social_post' }, plan, planSha256, inputHashes: bindings,
        copy: { ...plan.copy, description: socialPostDescription(plan) },
        window: { start: 0, end: layout.duration, duration: layout.duration },
        output: { mediaPath, coverPath }, socialPostReview: { status: 'pending' },
        render: { ...media, encoder, fullDecode: true, frames, digests: { video: hashFile(mediaPath), cover: hashFile(coverPath) } },
        upload: { prefix: '', tags: plan.copy.tags, source: plan.source.url, tid: 21 } };
    write(path.join(output, 'UPLOAD_MANIFEST.json'), metadata);
    fs.writeFileSync(path.join(output, 'REVIEW.md'), `# 微博截图视频\n\n待审核：原帖/作者/日期、完整截图、逐场文字揭示、配乐与音量、标题封面简介。\n\n${metadata.copy.title}\n\n${metadata.copy.description}\n\n视频：${mediaPath}\n\n技术检查：1920×1080，${media.duration}秒，完整解码通过。\n`, { encoding: 'utf8', flag: 'wx' });
    return metadata;
}
/** A local operator review records actual checks; it never enqueues or publishes. */
export function reviewSocialPost(manifest: string, note: string, reviewer: string) {
    if (!note.trim() || !reviewer.trim()) throw new Error('Review needs a reviewer identity and concrete note');
    const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (metadata.type !== 'social_post_video' || metadata.uploadReady || metadata.socialPostReview?.status !== 'pending') throw new Error('Expected an unreviewed social-post render');
    const plan: SocialPostPlan = metadata.plan;
    if (JSON.stringify(inputHashes(plan)) !== JSON.stringify(metadata.inputHashes)) throw new Error('Source changed after rendering');
    const { mediaPath, coverPath } = metadata.output;
    if (metadata.render?.digests?.video !== hashFile(mediaPath) || metadata.render?.digests?.cover !== hashFile(coverPath)) throw new Error('Rendered video or cover changed before review; render a new revision');
    metadata.uploadReady = true;
    metadata.socialPostReview = { version: 1, status: 'passed', reviewer, note, reviewedAt: new Date().toISOString(),
        digests: { video: hashFile(mediaPath), cover: hashFile(coverPath) },
        evidence: { source: metadata.source, plan: metadata.plan, inputHashes: metadata.inputHashes,
            copy: metadata.copy, window: metadata.window, upload: metadata.upload } };
    fs.copyFileSync(manifest, manifest + '.pending.json', fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(manifest, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
    return metadata;
}
