import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildCollabDossier, CollabIO, fileHash, readJson, renderCollab, resolveSession } from '../../workflows/clipping/collabRuntime';
import { speechEnvelope, suggestSync } from '../../workflows/clipping/collabSync';
import { assertSpan, compileCollab } from '../../workflows/clipping/collabPolicy';
import { continuousAudioAudit } from './collabAudio';

const exec = promisify(execFile);
export function collabIO(ffmpeg = 'ffmpeg', ffprobe = 'ffprobe'): CollabIO {
    const { runFfmpeg } = require('../../scripts/clipping/media_runtime');
    const run = (args: string[]) => runFfmpeg(args, { ffmpegPath: ffmpeg, threads: 2, stage: '跨直播间本地预览', timeoutMs: 3600000 });
    return {
        probe: async file => {
            const { stdout } = await exec(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, timeout: 30000 });
            const info = JSON.parse(stdout), video = info.streams?.find((s: any) => s.codec_type === 'video');
            if (!video) throw new Error(`Missing video: ${file}`);
            return { width: Number(video.width), height: Number(video.height), duration: Number(info.format?.duration),
                audio: info.streams.some((s: any) => s.codec_type === 'audio') };
        },
        run,
        subtitleAss: (srt, width, height) => {
            const { calculateSubtitleStyle } = require('../../scripts/clipping/subtitle_encoding');
            const { buildBurnAssContentFromSrt } = require('../../scripts/topic_clipper');
            return buildBurnAssContentFromSrt(srt, calculateSubtitleStyle(width, height));
        },
        auditAudio: continuousAudioAudit(run)
    };
}
export async function main(args = process.argv.slice(2)) {
    const value = (key: string) => { const at = args.indexOf(key); return at < 0 ? undefined : args[at + 1]; };
    const required = (key: string) => { const v = value(key); if (!v || v.startsWith('--')) throw new Error(`${key} is required`); return path.resolve(v); };
    const number = (key: string, fallback?: number) => {
        const text = value(key), n = text === undefined ? fallback : Number(text);
        if (n === undefined || !Number.isFinite(n)) throw new Error(`${key} needs a finite number`); return n;
    };
    const command = args[0];
    if (!args.length || args.includes('--help')) {
        console.log('clips:collab template --output <new-dir>\n'
            + 'clips:collab sync --session <session.json> --source <id> --reference-start <seconds> --peer-start <approx-seconds> --output <new-dir> [--window 20 --search 5]\n'
            + 'clips:collab dossier --session <session.json> --output <new-json> [--start <primary-seconds> --end <primary-seconds>]\n'
            + 'clips:collab plan --dossier <dossier.json> --output <new-plan.json>\n'
            + 'clips:collab check|render --dossier <dossier.json> --plan <plan.json> [--output <new-dir> --font <CJK-font>]\n'
            + 'Local evidence and pending-review media only. No ASR/provider requests, recorder changes, queues or publication.'); return;
    }
    const io = collabIO(value('--ffmpeg'), value('--ffprobe'));
    if (command === 'template') {
        const output = required('--output'); fs.mkdirSync(output);
        const ids = ['primary', 'peer1', 'peer2', 'peer3'];
        const session = { version: 1, primaryId: ids[0], sources: ids.map((id, i) => ({
            id, name: i ? `队友${i}` : '主视角', roomId: '', mediaPath: `${id}.mp4`,
            srtPath: `${id}.srt`, xmlPath: `${id}.xml`, sync: [], protectedRegions: [] })) };
        fs.writeFileSync(path.join(output, 'SESSION.json'), JSON.stringify(session, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        console.log(JSON.stringify({ status: 'template', output, next: 'Fill actual room IDs and finalized source paths; delete unavailable optional srtPath/xmlPath. Review sync anchors and protected HUD rectangles.' })); return;
    }
    if (command === 'sync') {
        const session = resolveSession(required('--session')), source = session.sources.find(s => s.id === value('--source'));
        const primary = session.sources.find(s => s.id === session.primaryId);
        if (!source || !primary || source.id === primary.id) throw new Error('Select a peer source ID');
        const start = number('--reference-start'), guess = number('--peer-start'), duration = number('--window', 20), search = number('--search', 5);
        if (duration < 5 || duration > 60 || search < 1 || search > 15 || start < 0 || guess < 0) throw new Error('Sync bounds: window 5–60s, search 1–15s, nonnegative starts');
        const searchStart = Math.max(0, guess - search), searchEnd = guess + duration + search;
        const a = await io.probe(primary.mediaPath), b = await io.probe(source.mediaPath);
        assertSpan({ start, end: start + duration }, a.duration); assertSpan({ start: searchStart, end: searchEnd }, b.duration);
        if (!a.audio || !b.audio) throw new Error('Sync suggestion needs both audio tracks');
        const bindings = { primary: await fileHash(primary.mediaPath), peer: await fileHash(source.mediaPath) };
        const output = required('--output'); fs.mkdirSync(output);
        const extract = async (file: string, at: number, length: number, name: string) => {
            const out = path.join(output, name);
            await io.run(['-hide_banner', '-nostdin', '-n', '-ss', String(at), '-t', String(length), '-i', file,
                '-map', '0:a:0', '-vn', '-af', 'highpass=f=200,lowpass=f=3000', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', out]);
            const buffer = fs.readFileSync(out), samples = new Float32Array(buffer.length / 4);
            for (let i = 0; i < samples.length; i++) samples[i] = buffer.readFloatLE(i * 4);
            if (samples.length < (length - .05) * 8000) throw new Error('Incomplete sync audio window');
            return speechEnvelope(samples);
        };
        const reference = await extract(primary.mediaPath, start, duration, 'reference.f32');
        const peer = await extract(source.mediaPath, searchStart, searchEnd - searchStart, 'peer.f32');
        const proposal = suggestSync(reference, peer);
        if (await fileHash(primary.mediaPath) !== bindings.primary || await fileHash(source.mediaPath) !== bindings.peer) throw new Error('Source changed during sync search');
        const result = { version: 1, sourceId: source.id, primaryPath: primary.mediaPath, peerPath: source.mediaPath, bindings,
            referenceStart: start, searchStart, duration, ...proposal,
            suggestedLocalStart: 'offsetSeconds' in proposal ? searchStart + Number(proposal.offsetSeconds) : null };
        fs.writeFileSync(path.join(output, 'SYNC_PROPOSAL.json'), JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        console.log(JSON.stringify(result)); return;
    }
    if (command === 'dossier') {
        const window = value('--start') === undefined && value('--end') === undefined ? undefined : { start: number('--start'), end: number('--end') };
        const output = required('--output'), result = await buildCollabDossier(required('--session'), output, io, window);
        console.log(JSON.stringify({ status: 'evidence', output, sha256: result.sha256, coverage: result.coverage })); return;
    }
    if (command === 'plan') {
        const dossier = readJson(required('--dossier')), output = required('--output');
        fs.writeFileSync(output, JSON.stringify({ version: 1, dossierSha256: dossier.sha256, shots: [] }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        console.log(JSON.stringify({ status: 'draft', output, next: 'Choose complete story spans with source evidence IDs; inspect source frames before adding crop/placement rectangles.' })); return;
    }
    if (command === 'check') {
        const dossier = readJson(required('--dossier')), plan = readJson(required('--plan'));
        if (plan.dossierSha256 !== dossier.sha256) throw new Error('Plan/dossier binding mismatch');
        const timeline = compileCollab(dossier.session, plan, dossier.media, dossier.subtitles, dossier.rows);
        console.log(JSON.stringify({ status: 'structurally_valid', duration: timeline.duration, shots: timeline.shots.length,
            interpretation: 'Plan structure only; render revalidates original file hashes. Visual and listening review remain pending.' })); return;
    }
    if (command === 'render') {
        const result = await renderCollab(required('--dossier'), required('--plan'), required('--output'),
            value('--font') || 'C:/Windows/Fonts/msyh.ttc', io);
        console.log(JSON.stringify({ status: result.status, output: result.output, checks: result.checks })); return;
    }
    throw new Error(`Unknown collab command: ${command}`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
