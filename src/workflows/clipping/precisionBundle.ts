import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';

const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));

export function bundleAudioFilter(duration: number): string {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid bundle source duration');
    return `aresample=async=1:first_pts=0,apad=whole_dur=${duration},atrim=duration=${duration},asetpts=N/SR/TB`;
}

/** A bundle is a separate, unpublished revision; it never replaces a member's numeric identity. */
export function bundleMembers(ids: number[], registry: any, queue: any): any[] {
    if (ids.length < 2 || ids.length > 5 || new Set(ids).size !== ids.length
        || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Select 2–5 distinct numeric candidates');
    const active = new Set((queue.jobs || []).filter((job: any) => ['pending', 'running', 'retry_wait'].includes(job.status))
        .flatMap((job: any) => job.clipIds.filter((id: number) => !job.cancellationAcknowledgedIds?.includes(id))));
    const members = ids.map(id => {
        const record = registry.clips?.[String(id)];
        if (!record || active.has(id) || record.uploadState?.bvid || record.status === 'uploaded' || record.editorialExclusion
            || record.pendingRebuild || !record.pendingCut) throw new Error(`Candidate ${id} is unavailable for a new bundle`);
        const metadata = read(record.metadataPath);
        if (metadata.candidateId && metadata.candidateId !== id || metadata.aiReview?.status !== 'ready'
            || metadata.aiReview?.keyword?.status !== 'confirmed' || metadata.aiReview?.quality?.issues?.length
            || metadata.candidateSubtitles?.edits?.length || metadata.candidateSubtitles?.approval
            || metadata.humanReview || !Number.isFinite(metadata.window?.start) || !Number.isFinite(metadata.window?.end)
            || metadata.window.start < 0 || metadata.window.end <= metadata.window.start) {
            throw new Error(`Candidate ${id} needs source/preflight review before bundling`);
        }
        const stat = fs.statSync(metadata.source.mediaPath);
        return { id, record, metadata, metadataSha256: digest(record.metadataPath),
            candidateSrtPath: record.candidateSrtPath, candidateSrtSha256: digest(record.candidateSrtPath),
            sourceSnapshot: { mediaPath: metadata.source.mediaPath, bytes: stat.size, mtimeMs: stat.mtimeMs,
                srtSha256: digest(metadata.source.srtPath), xmlSha256: metadata.source.xmlPath ? digest(metadata.source.xmlPath) : null } };
    }).sort((a, b) => a.metadata.window.start - b.metadata.window.start);
    if (members.some((member, index) => member.metadata.roomId !== members[0].metadata.roomId
        || member.sourceSnapshot.mediaPath !== members[0].sourceSnapshot.mediaPath
        || member.metadata.source.srtPath !== members[0].metadata.source.srtPath
        || index > 0 && member.metadata.window.start < members[index - 1].metadata.window.end)) {
        throw new Error('Bundle members must be disjoint windows from the same recording and room');
    }
    return members;
}

export function assertBundleRetention(mappings: any[], retained: Array<{ start: number; end: number }>): void {
    for (const member of mappings) {
        if (!member.keywordSpans.length || member.keywordSpans.some((cue: any) =>
            !retained.some(span => span.start <= cue.start + .002 && span.end >= cue.end - .002))) {
            throw new Error(`Precision omitted a member's keyword evidence: ${member.id}`);
        }
    }
}

export async function main(args: string[], dependencies: { modules?: (name: string) => any } = {}): Promise<void> {
    const value = (key: string) => args[args.indexOf(key) + 1];
    const root = path.resolve(value('--project-root'));
    const requireProject = dependencies.modules || createRequire(path.join(root, 'package.json'));
    if (args.includes('--check-source')) {
        const metadata = read(value('--metadata'));
        const actual = await requireProject('./src/scripts/clipping/creative_source_expansion').creativeSourceIdentity(metadata.source, metadata.source);
        if (actual !== metadata.creativePlan?.sourceId) throw new Error('Compiled bundle source changed since rendering');
        console.log('BUNDLE_SOURCE: ' + JSON.stringify(requireProject('./src/scripts/clipping/source_snapshot').sourceSnapshot(metadata)));
        return;
    }
    const registryPath = path.resolve(value('--registry'));
    const queuePath = path.resolve(value('--queue'));
    const ids = value('--ids').split(',').map(Number);
    const note = value('--note');
    if (!note?.trim()) throw new Error('A bundle editorial note is required');
    const members = bundleMembers(ids, read(registryPath), read(queuePath));
    const config = requireProject('./src/scripts/config-loader').getConfig();
    const topic = requireProject('./src/scripts/topic_clipper');
    const { srtText } = requireProject('./src/scripts/clipping/creative_subtitles');
    const { buildSubtitleEvidence } = requireProject('./src/scripts/clipping/subtitle_evidence');
    const { buildPreflightEvidence } = requireProject('./src/scripts/clipping/preflight_evidence');
    const parent = path.join(path.dirname(members[0].record.metadataPath), 'precision_bundles', members.map(m => m.id).join('-'));
    fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'r-'));
    const save = (name: string, data: unknown) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data, null, 2), 'utf8');
    const identity = () => bundleMembers(ids, read(registryPath), read(queuePath)).map(member => ({
        id: member.id, metadataPath: member.record.metadataPath, metadataSha256: member.metadataSha256, candidateSrtPath: member.candidateSrtPath,
        candidateSrtSha256: member.candidateSrtSha256, sourceSnapshot: member.sourceSnapshot }));
    const originalIdentity = identity();
    save('MEMBERS.json', { version: 1, note, members: originalIdentity, uploadAuthorized: false });
    console.log('PRECISION_BUNDLE_STARTED: ' + JSON.stringify({ ids, directory }));
    try {
        const sources: any[] = [], clips: any[] = [];
        for (const member of members) {
            const { metadata, id } = member;
            const parsed = topic.parseTopicSrt(metadata.source.srtPath);
            if (buildPreflightEvidence(parsed.segments).sourceSha256 !== metadata.aiReview.sourceSha256) throw new Error('Source evidence changed');
            if (member.candidateSrtSha256 !== member.record.candidateSrtSha256) throw new Error('Candidate subtitles changed');
            const cues = topic.parseTopicSrt(member.candidateSrtPath).segments;
            if (!cues.length || cues.some((c: any) => c.start < 0 || c.end > metadata.window.end - metadata.window.start + .002)) throw new Error('Invalid candidate timeline');
            const srt = path.join(directory, `source-${id}.srt`);
            fs.writeFileSync(srt, srtText(cues.map((cue: any) => ({ ...cue,
                start: cue.start + metadata.window.start, end: cue.end + metadata.window.start }))), 'utf8');
            sources.push({ id: String(id), mediaPath: metadata.source.mediaPath, srtPath: srt });
            clips.push({ id: String(id), sourceId: String(id), sequence: clips.length + 1, ...metadata.window,
                duration: metadata.window.end - metadata.window.start, eventDateTime: '', needsReAsr: false,
                evidence: ['numeric_candidate_preflight'], matchedTerms: [], subtitlePreview: cues.map((cue: any) => cue.text).join(' ') });
        }
        const plan = { version: 1, topic: value('--title'), sources, clips, profile: { name: 'explicit_numeric_bundle' },
            summary: { totalPlannedDuration: clips.reduce((n, clip) => n + clip.duration, 0) } };
        save('PLAN.json', plan);
        const compiled = await requireProject('./src/scripts/clipping/topic_compilation').buildCompilation(plan,
            path.join(directory, 'source.mp4'), { rootConfig: config, noBurn: true, workDir: path.join(directory, 'temp', 'compile'),
                ffmpegPath: config.ffmpegPath || 'ffmpeg', ffprobePath: topic.resolveFfprobePath(config.ffmpegPath || 'ffmpeg'),
                overlayTemplate: '话题{sequence}' });
        // Packet-copy compilation can leave an AAC tail shorter than the video.
        // Normalize this actual source once, before baseline/creative comparisons.
        const normalizedSource = path.join(directory, 'source-aligned.mp4');
        const scheduler = requireProject('./src/scripts/clipping/resource_scheduler').createClipResourceAdaptiveScheduler({
            ownConfig: config.ownStreamClips || {}, rootConfig: config });
        const lease = scheduler.enabled ? await scheduler.acquire() : null;
        try {
            await topic.runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', compiled.outputVideo,
                '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy',
                '-af', bundleAudioFilter(compiled.manifest.actualDuration),
                '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', normalizedSource], {
                ffmpegPath: config.ffmpegPath || 'ffmpeg', threads: (lease?.profile || scheduler.getProfile()).ffmpegThreads,
                timeoutMs: 1200000, stage: 'precision bundle source audio alignment' });
        } finally { lease?.release(); }
        let offset = 0;
        const mappings = members.map((member, index) => {
            const start = offset; offset += compiled.manifest.segments[index].actualDuration;
            return { id: member.id, originalWindow: member.metadata.window, start, end: offset,
                keywordSpans: member.metadata.aiReview.keyword.hits.map((hit: any) => ({
                    start: start + hit.start - member.metadata.window.start,
                    end: start + hit.end - member.metadata.window.start })) };
        });
        save('TIMELINE.json', { version: 1, timebase: 'compiled-source seconds', mappings });
        const first = members[0].metadata;
        const cut = await requireProject('./src/scripts/manual_clip_queue').cutTask({
            id: members.map(m => m.id).join('-'), mediaPath: normalizedSource, srtPath: compiled.outputSrt,
            start: 0, end: compiled.manifest.actualDuration, title: value('--title'),
            description: value('--description'), coverText: value('--cover-text'), upload: first.upload,
            roomId: first.roomId, streamerName: first.streamerName, recordedAt: first.recordedAt,
            outputDir: directory, outputStem: 'baseline', reviewPath: path.join(directory, 'REVIEW.md') }, config);
        const baseline = read(cut.output.metadataPath);
        baseline.window.index = 1;
        baseline.mode = 'keyword_topic_bundle';
        baseline.publicationKind = 'keyword_topic_bundle';
        baseline.candidateBundle = { version: 1, ids, mappings, membersPath: path.join(directory, 'MEMBERS.json'),
            membersSha256: digest(path.join(directory, 'MEMBERS.json')), uploadAuthorized: false };
        const parsed = topic.parseTopicSrt(compiled.outputSrt);
        const [result] = await requireProject('./src/scripts/clipping/editorial_styles').applyStyles([baseline], {
            config: { ...topic.getClipTopicsConfig(config), editorialStyles: { enabled: true, mode: 'precision', requirePrecision: true },
                enhancements: { ...config.ownStreamClips?.enhancements, creative: { ...config.ownStreamClips?.enhancements?.creative, style: 'compact' } } },
            rootConfig: config, info: { roomId: first.roomId, recordedAt: first.recordedAt, sessionId: directory }, topic,
            parsed, evidence: buildSubtitleEvidence(parsed.segments), danmaku: [],
            options: { srtPath: compiled.outputSrt, mediaPath: normalizedSource, creativeEditorialFeedback: note } });
        if (JSON.stringify(identity()) !== JSON.stringify(originalIdentity)) throw new Error('Bundle members or sources changed during rendering');
        if (result.creativeResult?.status !== 'edited' || result.qaResult?.status !== 'passed' || result.audioQa?.status !== 'passed') {
            throw new Error('Precision did not pass: ' + (result.creativeResult?.reason || result.editorialStyle?.failure || 'media QA'));
        }
        assertBundleRetention(mappings, result.editPlan.keep);
        result.uploadReady = false;
        result.candidateBundle = baseline.candidateBundle;
        fs.writeFileSync(result.output.metadataPath, JSON.stringify(result, null, 2), 'utf8');
        const summary = { status: 'pending_review', ids, directory, duration: result.window.duration,
            mediaPath: result.output.mediaPath, srtPath: result.output.srtPath, coverPath: result.output.coverPath,
            metadataPath: result.output.metadataPath, uploadAuthorized: false };
        save('RESULT.json', summary);
        console.log('PRECISION_BUNDLE_RESULT: ' + JSON.stringify(summary));
    } catch (error) {
        save('RESULT.json', { status: 'failed', ids, directory, error: String(error), uploadAuthorized: false });
        throw error;
    }
}
