import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { artifactDigests, fileDigest, Artifact } from './enhancement';
import { publicationEnabled, publicationPolicyVersion, topicPublicationEvidence, reviewPublication,
    PublicationConfig, PublicationInspection, PublicationSnapshot, TOPIC_PUBLICATION_POLICY_VERSION } from './publicationReview';
import type { Subtitle } from './editPlan';
import { subtitleRepairEvidenceDigest } from './ownSubtitleRepairEvidence';
import { sourceTimingMetadata, validateRenderedTimingRepair } from './publicationTiming';
import { projectRetainedSubtitleEvidence } from './subtitleWindowEvidence';
export { projectRetainedSubtitleEvidence } from './subtitleWindowEvidence';

export interface AutomaticPublicationConfig extends PublicationConfig {
    activatedAt?: string; authorizationNote?: string; concurrency?: number;
}
export interface PublicationContext {
    config: AutomaticPublicationConfig; roomId: string; streamerName: string;
    excludedCategories: string[]; ffmpegPath: string; ffprobePath: string;
    planPath?: string; aiEnabled: boolean; persist?: boolean;
    configuredPeople?: Array<{ id: string; label: string; names: string[] }>;
}
export interface PublicationAdapters {
    parse(file: string): Subtitle[];
    evidence(segments: Subtitle[]): { sourceSha256: string; cues?: Array<{ id: string; start: number; end: number; text: string; [key: string]: unknown }> };
    audience(file: string): Promise<Array<{ time: number; text: string }>>;
    request(artifact: Artifact, prompt: string, images: string[]): Promise<{ text: string; meta?: Record<string, any> }>;
    withMedia<T>(work: (profile: { ffmpegThreads?: number } | null) => Promise<T>): Promise<T>;
    runFfmpeg(args: string[], profile: { ffmpegThreads?: number } | null): Promise<unknown>;
    inspect?: (artifact: Artifact, subtitles: Subtitle[]) => Promise<PublicationInspection>;
    now?: () => string;
}

function writeJson(file: string, value: unknown): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export async function publicationSnapshot(artifact: Artifact): Promise<PublicationSnapshot> {
    const source = artifact.source;
    const timing = sourceTimingMetadata(source.srtPath);
    const timingAudio = validateRenderedTimingRepair(artifact);
    const stat = fs.statSync(source.mediaPath, { bigint: true });
    const originalSrt = String(source.srtPath).replace(/\.speaker\.srt$/iu, '.srt');
    const sidecar = path.join(path.dirname(originalSrt), path.basename(originalSrt, path.extname(originalSrt)) + '.asr_evidence.json');
    const snapshot: PublicationSnapshot = { digests: await artifactDigests(artifact), source: {
        mediaPath: path.resolve(source.mediaPath), mediaBytes: String(stat.size), mediaMtimeNs: String(stat.mtimeNs),
        srtPath: path.resolve(source.srtPath), srtSha256: await fileDigest(source.srtPath),
        xmlPath: source.xmlPath ? path.resolve(source.xmlPath) : null,
        xmlSha256: source.xmlPath ? await fileDigest(source.xmlPath) : null,
        asrEvidencePath: fs.existsSync(sidecar) ? path.resolve(sidecar) : null,
        asrEvidenceSha256: fs.existsSync(sidecar) ? await fileDigest(sidecar) : null,
        ...(timing ? { asrMetaPath: timing.path, asrMetaSha256: timing.sha256 } : {})
    } };
    const subtitleAudio = subtitleRepairEvidenceDigest(artifact, snapshot.source);
    if (subtitleAudio) snapshot.digests.subtitleAudio = subtitleAudio;
    if (timingAudio) snapshot.digests.timingAudio = timingAudio;
    return snapshot;
}

function image(file: string): string {
    const bytes = fs.readFileSync(file);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!png && !(bytes[0] === 255 && bytes[1] === 216)) throw new Error('Invalid publication review image');
    return `data:image/${png ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
}

function probe(file: string, ffprobe: string): Promise<any> {
    return new Promise((resolve, reject) => execFile(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
        { windowsHide: true, shell: false, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
            if (error) return reject(error);
            try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        }));
}

/** Full decode checks media integrity; the AI sees explicitly labelled sampled frames, not a fictitious full-video review. */
export async function inspectPublicationMedia(artifact: Artifact, subtitles: Subtitle[], context: PublicationContext,
    adapters: PublicationAdapters): Promise<PublicationInspection> {
    return adapters.withMedia(async profile => {
        const media = await probe(artifact.output.mediaPath, context.ffprobePath);
        const streams = Array.isArray(media.streams) ? media.streams : [];
        const video = streams.find((row: any) => row.codec_type === 'video');
        const audio = streams.find((row: any) => row.codec_type === 'audio');
        const duration = Number(media.format?.duration), expected = artifact.window.duration;
        const issues: string[] = [];
        if (!video || !audio || !(video.width > 0 && video.height > 0)) issues.push('missing_audio_or_video');
        if (!Number.isFinite(duration) || duration <= 0 || Math.abs(duration - expected) > 0.75) issues.push('duration_mismatch');
        if (video && audio && Math.abs(Number(video.start_time || 0) - Number(audio.start_time || 0)) > 0.15) issues.push('av_start_mismatch');
        if (!subtitles.length || subtitles.some(row => row.start < 0 || row.end <= row.start || row.end > duration + 0.1)) issues.push('subtitle_timeline_invalid');
        if (artifact.output.burnedSubtitles !== true) issues.push('missing_burned_subtitles');
        const facts = { duration, expectedDuration: expected, videoWidth: video?.width, videoHeight: video?.height,
            audioCodec: audio?.codec_name, subtitleCount: subtitles.length, fullDecode: false, sampledFrameTimes: [] as number[] };
        if (issues.length) return { passed: false, issues, frames: [], facts };
        await adapters.runFfmpeg(['-v', 'error', '-xerror', '-i', artifact.output.mediaPath,
            '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], profile);
        facts.fullDecode = true;
        const cueMid = (cue: Subtitle) => (cue.start + cue.end) / 2;
        const times = [...new Set([0.25, cueMid(subtitles[0]), duration / 2, cueMid(subtitles.at(-1)!), duration - 0.25]
            .map(time => Math.max(0, Math.min(duration - 0.05, time))))];
        facts.sampledFrameTimes = times;
        const scratch = path.join(path.dirname(artifact.output.metadataPath), 'temp', path.basename(artifact.output.metadataPath) + '.publication');
        fs.mkdirSync(scratch, { recursive: true });
        const frames = [image(artifact.output.coverPath!)];
        for (const [index, time] of times.entries()) {
            const output = path.join(scratch, `frame-${index}.jpg`);
            await adapters.runFfmpeg(['-y', '-ss', String(time), '-i', artifact.output.mediaPath,
                '-frames:v', '1', '-vf', 'scale=960:-2', output], profile);
            frames.push(image(output));
        }
        return { passed: true, issues: [], frames, facts };
    });
}

export function automaticContextEnabled(context: PublicationContext): boolean {
    return !context.planPath && publicationEnabled(context.config, context.roomId)
        && Boolean(context.config.authorizationNote?.trim()) && Number.isFinite(Date.parse(context.config.activatedAt || ''));
}

function unavailable(artifact: Artifact, context: PublicationContext, now: string, reason: string): Artifact {
    const policyVersion = publicationPolicyVersion(context.config);
    return { ...artifact, automaticPublicationRequired: true,
        publicationReview: { version: 1, policyVersion, status: 'unavailable', reviewedAt: now,
            roomId: context.roomId, issues: [reason], checks: { content: false, attribution: false, subtitles: false, visuals: false, policy: false },
            technical: { passed: false, issues: [reason] }, digests: null, source: null,
            artifactWindow: { start: artifact.window?.start, end: artifact.window?.end, duration: artifact.window?.duration },
            ...(policyVersion === TOPIC_PUBLICATION_POLICY_VERSION ? { topicEvidence: topicPublicationEvidence(artifact) } : {}) },
        publicationDecision: { version: 1, policyVersion, action: 'needs_human', reasons: [reason] } };
}

/** Called only by the newly generated final-artifact path. Import and review-refresh never invoke it. */
export async function reviewOwnPublications(artifacts: Artifact[], context: PublicationContext,
    adapters: PublicationAdapters): Promise<Artifact[]> {
    if (!automaticContextEnabled(context)) return artifacts;
    const results = [...artifacts];
    let next = 0;
    const concurrency = Math.max(1, Math.min(3, Math.floor(context.config.concurrency || 2)));
    await Promise.all(Array.from({ length: Math.min(concurrency, artifacts.length) }, async () => {
        for (let index = next++; index < artifacts.length; index = next++) {
            const artifact = artifacts[index], now = adapters.now?.() || new Date().toISOString();
            // Opening the policy never sweeps old rendered artifacts into the queue.
            if (!Number.isFinite(Date.parse(artifact.generatedAt))
                || Date.parse(artifact.generatedAt) < Date.parse(context.config.activatedAt!)) continue;
            let result: Artifact;
            try {
                if (!context.aiEnabled) throw new Error('AI is disabled; final publication review cannot run');
                const initial = await publicationSnapshot(artifact);
                const speech = adapters.parse(artifact.source.srtPath);
                const rawEvidence = adapters.evidence(speech);
                const evidence = artifact.mode === 'own_stream_fun_review'
                    ? projectRetainedSubtitleEvidence(rawEvidence, artifact.window) : rawEvidence;
                const sourceEvidenceSha256 = evidence.sourceSha256;
                const retained = adapters.parse(artifact.output.srtPath);
                const audience = artifact.source.xmlPath ? (await adapters.audience(artifact.source.xmlPath))
                    .map((row, i) => ({ ...row, id: `D${i + 1}` })) : [];
                const start = artifact.window.start, end = artifact.window.end;
                result = await reviewPublication(artifact, {
                    config: context.config, roomId: context.roomId, streamerName: context.streamerName,
                    excludedCategories: context.excludedCategories,
                    speech: speech.filter(row => row.end > start - 30 && row.start < end + 60),
                    retainedSubtitles: retained,
                    audience: audience.filter(row => row.time >= start && row.time <= end),
                    evidence: { configuredPeople: context.configuredPeople || [], cues: evidence.cues?.filter(row => row.end > start - 30 && row.start < end + 60)
                        .map(cue => ({ ...cue })) || [] },
                    sourceEvidenceSha256, evidenceSnapshot: initial, now
                }, {
                    snapshot: publicationSnapshot,
                    inspect: current => adapters.inspect ? adapters.inspect(current, retained)
                        : inspectPublicationMedia(current, retained, context, adapters),
                    request: async (prompt, frames) => {
                        const response = await adapters.request(artifact, prompt, frames);
                        const evidencePath = path.join(path.dirname(artifact.output.metadataPath), 'temp',
                            path.basename(artifact.output.metadataPath) + '.publication', 'review-response.json');
                        writeJson(evidencePath, { prompt, response: response.text, ledgerId: response.meta?.ledgerId,
                            usage: response.meta?.usage, elapsedMs: response.meta?.elapsedMs });
                        return response.text;
                    }
                });
            } catch (error) { result = unavailable(artifact, context, now, `publication_review_unavailable:${error instanceof Error ? error.message : String(error)}`); }
            if (context.persist !== false) writeJson(artifact.output.metadataPath, result);
            results[index] = result;
        }
    }));
    return results;
}

export interface RegistrySnapshot {
    clipIdsByReviewIndex: Record<string, number>;
    clipStatusByReviewIndex?: Record<string, string>;
    reviewPendingByReviewIndex?: Record<string, boolean>;
    reviewIssuesByReviewIndex?: Record<string, string[]>;
    [key: string]: any;
}

/** The only process adapter here submits already-reviewed IDs; it never creates a second uploader. */
export async function enqueueOwnPublications(results: Artifact[], registry: RegistrySnapshot, projectRoot: string,
    invoke?: (ids: number[]) => Promise<string>): Promise<Record<string, any>> {
    const ids = results.filter(row => row.automaticPublicationRequired && row.publicationDecision?.action === 'auto_queue')
        .map(row => registry.clipIdsByReviewIndex[String(row.reviewIndex ?? (row.window as Artifact['window'] & { index?: number }).index)])
        .filter((id): id is number => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) return { enabled: true, mode: 'auto', queuedIds: [], results: [] };
    const run = invoke || ((selected: number[]) => new Promise<string>((resolve, reject) => {
        execFile('python', [path.join(projectRoot, 'src/scripts/clip_upload_registry.py'), 'enqueue', '--automatic', '--ids', selected.join(',')],
            { cwd: projectRoot, windowsHide: true, shell: false, encoding: 'utf8', timeout: 120000,
                maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
                if (error) return reject(new Error(`Automatic enqueue unavailable: ${stderr || stdout || error.message}`));
                resolve(stdout);
            });
    }));
    try {
        const output = await run([...new Set(ids)]);
        const line = output.split(/\r?\n/u).find(row => row.startsWith('AUTOMATIC_ENQUEUE_RESULT:'));
        if (!line) throw new Error('Missing automatic enqueue receipt');
        const receipt = JSON.parse(line.slice('AUTOMATIC_ENQUEUE_RESULT:'.length));
        return { enabled: true, mode: 'auto', ...receipt };
    } catch (error) {
        // Enqueue may already have committed. Leave its outcome unknown and never retry blindly here.
        return { enabled: true, mode: 'auto', queuedIds: [], error: error instanceof Error ? error.message : String(error), outcomeUnknown: true };
    }
}

/** Generic entry points; retain existing own-stream exports for source-executed callers. */
export const reviewPublications = reviewOwnPublications;
export const enqueuePublications = enqueueOwnPublications;
