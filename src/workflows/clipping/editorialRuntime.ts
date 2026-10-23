import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { composeTimeline, HookPlan, parseSrt, projectCues, writeSrt } from './editorialStyle';

export interface Probe { duration: number; width: number; height: number; audio: boolean }
export interface StyleIO {
    probe(file: string): Promise<Probe>;
    render(input: string, output: string, start: number, end: number, size: Probe): Promise<void>;
    concat(list: string, output: string): Promise<void>;
}
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');

/** Separate local revision. Baseline approval, queues and published artifacts are never mutated. */
export async function renderHighlightFirst(input: {
    metadata: string; opManifest: string; plan: HookPlan; output: string;
}, io: StyleIO) {
    const metadata = path.resolve(input.metadata), opManifest = path.resolve(input.opManifest);
    const baseline = read(metadata), op = read(opManifest);
    const media = baseline.output?.mediaPath, subtitles = baseline.output?.srtPath;
    if (baseline.output?.burnedSubtitles !== true) throw new Error('Use a baseline with burned, reviewed subtitles');
    const opMedia = path.resolve(path.dirname(opManifest), op.mediaPath);
    const opSrt = path.resolve(path.dirname(opManifest), op.srtPath);
    const binding = { metadata: digest(metadata), media: digest(media), subtitles: digest(subtitles),
        opManifest: digest(opManifest), opMedia: digest(opMedia), opSubtitles: digest(opSrt) };
    if (input.plan.baselineMediaSha256 && input.plan.baselineMediaSha256 !== binding.media) throw new Error('Highlight plan belongs to a different baseline');
    if (input.plan.baselineSubtitlesSha256 && input.plan.baselineSubtitlesSha256 !== binding.subtitles
        || input.plan.baselineMetadataSha256 && input.plan.baselineMetadataSha256 !== binding.metadata)
        throw new Error('Highlight plan subtitles or metadata changed');
    if (op.mediaSha256 !== binding.opMedia || op.srtSha256 !== binding.opSubtitles) throw new Error('OP manifest hashes do not match media/subtitles');
    const size = await io.probe(media), opSize = await io.probe(opMedia);
    if (!size.audio || !opSize.audio) throw new Error('Baseline and OP must both contain original audio');
    const cues = parseSrt(fs.readFileSync(subtitles, 'utf8')), opCues = parseSrt(fs.readFileSync(opSrt, 'utf8'));
    const timeline = composeTimeline(size.duration, opSize.duration, input.plan, cues);
    if (cues.some(c => c.end > size.duration + .1) || opCues.some(c => c.end > opSize.duration + .1)) throw new Error('Subtitles exceed media duration');
    const directory = path.resolve(input.output);
    // Refuse overwriting baseline or a prior review revision, including failed attempts.
    fs.mkdirSync(directory);
    const output = { mediaPath: path.join(directory, 'highlight_first.mp4'),
        srtPath: path.join(directory, 'highlight_first.srt'), metadataPath: path.join(directory, 'highlight_first.json'),
        burnedSubtitles: true, duration: timeline.duration };
    try {
        const parts = [];
        for (const [index, piece] of timeline.pieces.entries()) {
            const part = path.join(directory, `part-${index}.mp4`);
            await io.render(piece.kind === 'op' ? opMedia : media, part, piece.start, piece.end, size);
            parts.push(part);
        }
        const list = path.join(directory, 'concat.txt');
        fs.writeFileSync(list, parts.map(file => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
        await io.concat(list, output.mediaPath);
        const actual = await io.probe(output.mediaPath);
        if (!actual.audio || Math.abs(actual.duration - timeline.duration) > .2 || actual.width !== size.width || actual.height !== size.height)
            throw new Error('Rendered timeline duration, dimensions or audio stream mismatch');
        if (digest(media) !== binding.media || digest(subtitles) !== binding.subtitles || digest(metadata) !== binding.metadata
            || digest(opMedia) !== binding.opMedia || digest(opSrt) !== binding.opSubtitles || digest(opManifest) !== binding.opManifest)
            throw new Error('Source changed during composition');
        fs.writeFileSync(output.srtPath, writeSrt(projectCues(timeline.pieces, cues, opCues)), 'utf8');
        const result = { version: 1, style: 'highlight_first', styleLabel: '重点前置', status: 'pending_review',
            generatedAt: new Date().toISOString(), source: baseline.source, copy: baseline.copy,
            roomId: baseline.roomId, streamerName: baseline.streamerName, recordedAt: baseline.recordedAt,
            uploadReady: false, qaRequired: true, qaResult: { status: 'pending' }, output,
            editorialTimeline: { version: 1, timeBasis: 'rendered_baseline_seconds', ...timeline, plan: input.plan,
                baseline: { metadata, media, subtitles }, opManifest, opMedia, opSubtitles: opSrt,
                op: { id: op.id, source: op.source, subtitles: opCues }, binding, measuredDuration: actual.duration } };
        save(output.metadataPath, result);
        fs.writeFileSync(path.join(directory, 'REVIEW.md'), `# 重点前置待审\n\n预告 ${timeline.hookSeconds.toFixed(2)} 秒 → OP ${opSize.duration.toFixed(2)} 秒 → 正文。\n\n正文策略：${timeline.repetition}。检查原话完整、语境、OP 接缝及重排后字幕。原片审核不继承，本命令不登记或投稿。\n`, 'utf8');
        return result;
    } catch (error) {
        save(path.join(directory, 'FAILED.json'), { status: 'failed', uploadReady: false, error: (error as Error).message, binding });
        throw error;
    }
}
