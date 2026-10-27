import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { renderSocialPost, reviewSocialPost, SocialPostIO } from './socialPostRuntime';
const exec = promisify(execFile);

export async function main(args = process.argv.slice(2)) {
    const value = (key: string) => { const at = args.indexOf(key); return at < 0 ? undefined : args[at + 1]; };
    const required = (key: string) => { const text = value(key); if (!text || text.startsWith('--')) throw new Error(`${key} is required`); return text; };
    if (!args.length || args.includes('--help')) {
        console.log('clips:post render --plan <post.json> --output <new-directory>\nclips:post review --manifest <UPLOAD_MANIFEST.json> --reviewer <identity> --note <actual-checks>\nLocal rendering and review only. Import/enqueue use the existing upload registry after authorized review.'); return;
    }
    if (args[0] === 'review') {
        const result = reviewSocialPost(path.resolve(required('--manifest')), required('--note'), required('--reviewer'));
        console.log(JSON.stringify({ status: 'reviewed', output: result.output })); return;
    }
    if (args[0] !== 'render') throw new Error(`Unknown command: ${args[0]}`);
    const config = require('../../scripts/config-loader').getConfig(), own = config.ownStreamClips || {};
    const { runFfmpeg } = require('../../scripts/clipping/media_runtime');
    const scheduler = require('../../scripts/clipping/resource_scheduler').createClipResourceAdaptiveScheduler({ ownConfig: own, rootConfig: config });
    const ffmpegPath = own.ffmpegPath || config.ffmpegPath || 'ffmpeg', ffprobePath = own.ffprobePath || 'ffprobe';
    const io: SocialPostIO = {
        encoder: own.subtitleVideoEncoder || 'h264_nvenc', preset: own.subtitleVideoPreset || 'p4',
        run: async parameters => {
            const lease = await scheduler.acquire();
            try { return await runFfmpeg(parameters, { ffmpegPath, threads: lease.profile.ffmpegThreads, stage: '微博截图视频' }); }
            finally { lease.release(); }
        },
        probe: async file => {
            const result = await exec(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, timeout: 30000 });
            const p = JSON.parse(result.stdout), video = p.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
            return { width: Number(video?.width), height: Number(video?.height), duration: Number(p.format.duration),
                audio: p.streams.some((s: { codec_type: string }) => s.codec_type === 'audio') };
        }
    };
    const output = path.resolve(required('--output'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const result = await renderSocialPost(path.resolve(required('--plan')), output, io);
    console.log(JSON.stringify({ status: 'pending_review', manifest: path.join(output, 'UPLOAD_MANIFEST.json'), output: result.output }));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
