import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash, randomUUID } from 'crypto';
import { publicationSnapshot } from './publicationRuntime';
import { subtitleRepairEligible, planSubtitleProbes, consensusSubtitleEdit, applyConsensusEdits, RepairCue } from './ownSubtitleRepair';
import type { Artifact } from './enhancement';
import type { AutomaticPublicationConfig } from './publicationRuntime';
import { publicationEnabled } from './publicationReview';
import { consensusCueEdit } from './subtitleCueConsensus';
export { projectSubtitleRepairEvidence, subtitleRepairEligible } from './ownSubtitleRepair';

type Data = Record<string, any>;
const execute = promisify(execFile), hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fileHash = (file: string) => hash(fs.readFileSync(file));
const ALIGNMENT_VERSION = 'cue-consensus-v5';
export interface RepairIO {
    parse(file: string): RepairCue[];
    write(file: string, cues: RepairCue[]): void;
    render(artifact: Artifact, srtPath: string, directory: string): Promise<Artifact>;
    reviewCopy(artifact: Artifact): Promise<Artifact>;
    reviewFinal(artifact: Artifact): Promise<Artifact>;
    python: { executable: string; args: string[] };
    settings: Data; scriptPath: string; protectedNames: string[];
    runAudio?(input: string, output: string): Promise<void>;
}

export interface SubtitleRenderIO {
    mediaConfig: Data;
    withMedia<T>(work: (profile: Data) => Promise<T>): Promise<T>;
    cutMedia(source: Data, window: Artifact['window'], srt: string, output: string, config: Data): Promise<Data>;
}

/** Reuse the standard GPU/two-stage media adapter; preserve the old video and never grant a human approval. */
export async function renderRepairedSubtitles(artifact: Artifact, srt: string, directory: string, io: SubtitleRenderIO): Promise<Artifact> {
    const output = path.join(directory, path.basename(artifact.output.mediaPath));
    const media = await io.withMedia(async profile => ({ profile, result: await io.cutMedia(
        { mediaPath: artifact.source.mediaPath, kind: 'video', uploadReady: true }, artifact.window, srt, output,
        { ...io.mediaConfig, burnSubtitles: true, twoStageSubtitleBurn: true, twoStageMode: 'copy', preserveCoverSource: false,
            ffmpegThreads: profile.ffmpegThreads, clipFfmpegThreads: profile.ffmpegThreads }) }));
    if (media.result.path !== output || media.result.burnedSubtitles !== true || !fs.statSync(output).size) {
        throw new Error('Automatic subtitle rendering did not produce burned media');
    }
    return { ...artifact, output: { ...artifact.output, mediaPath: output, srtPath: srt, burnedSubtitles: true,
        mediaError: null, subtitleBurnFallbackUsed: Boolean(media.result.fallbackUsed),
        twoStageSubtitleBurn: media.result.twoStageSubtitleBurn, twoStageMode: media.result.twoStageMode,
        subtitleVideoEncoder: media.result.subtitleVideoEncoder || io.mediaConfig.subtitleVideoEncoder,
        subtitleHwaccel: media.result.subtitleHwaccel === undefined ? io.mediaConfig.subtitleHwaccel : media.result.subtitleHwaccel,
        resourceMode: media.profile.mode, ffmpegThreads: media.profile.ffmpegThreads } };
}

/** Explicit ID maintenance, with at most four short probes and no whole-recording ASR. */
export async function repairOwnSubtitles(artifact: Artifact, config: AutomaticPublicationConfig, required: Data, io: RepairIO): Promise<Artifact> {
    if (!subtitleRepairEligible(artifact) || config.mode !== 'auto' || !publicationEnabled(config, artifact.roomId)
        || !config.authorizationNote?.trim() || !Number.isFinite(Date.parse(config.activatedAt || ''))
        || !(Date.parse(artifact.generatedAt) >= Date.parse(config.activatedAt!))
        || (artifact.qaRequired || required.qaRequired)) return artifact;
    const previousRepair = artifact.automaticSubtitleRepair;
    const cues = io.parse(artifact.output.srtPath), probes = planSubtitleProbes(artifact, cues, previousRepair ? .25 : 5);
    if (!probes.length) return artifact;
    const previousChecks = previousRepair?.probeBudgetWindows || previousRepair?.checks || [];
    if (previousRepair && (previousChecks.length + probes.length > 4
        || [...previousChecks, ...probes].reduce((total, row) => total + row.end - row.start, 0) > 120)) return artifact;
    const initial = await publicationSnapshot(artifact);
    const identitySnapshot = { ...initial, digests: { ...initial.digests } };
    delete identitySnapshot.digests.subtitleDiagnostic;
    const inputIdentity = hash(JSON.stringify(identitySnapshot));
    if (JSON.stringify(initial.digests) !== JSON.stringify(artifact.publicationReview.digests)
        || JSON.stringify(initial.source) !== JSON.stringify(artifact.publicationReview.source)) throw new Error('Existing subtitle review evidence changed');
    const previousAttempt = artifact.automaticSubtitleRepairAttempt;
    const previousBudget: Data[] = previousRepair?.probeBudgetWindows || previousRepair?.checks || [];
    // One additional, narrower probe may address a NEW concrete blocker, never replay the same repaired words.
    if (previousRepair && ((previousRepair.generation || 1) >= 2 || probes.every(probe => previousRepair.edits
        .some((edit: Data) => edit.index === probe.index && [edit.from, edit.to].includes(probe.quote))))
        || previousAttempt?.inputIdentity === inputIdentity && previousAttempt.alignmentVersion === ALIGNMENT_VERSION) return artifact;
    const directory = path.join(path.dirname(artifact.output.metadataPath), 'temp', 'automatic-subtitle-repairs', randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    const stat = fs.statSync(artifact.source.mediaPath);
    const windows: Data[] = [];
    for (const probe of [...probes].sort((a, b) => a.start - b.start)) {
        const last = windows.at(-1);
        if (last && probe.start <= last.end && Math.max(last.end, probe.end) - last.start <= 30) last.end = Math.max(last.end, probe.end);
        else windows.push({ id: `A${windows.length + 1}`, start: probe.start, end: probe.end });
    }
    const request: Data = { version: 1, source: { mediaPath: path.resolve(artifact.source.mediaPath), mediaBytes: stat.size,
        mediaMtimeMs: stat.mtimeMs, srtPath: path.resolve(artifact.source.srtPath), srtSha256: initial.source.srtSha256 },
        settings: io.settings, windows };
    if (previousAttempt?.inputIdentity === inputIdentity) {
        const prior = JSON.parse(fs.readFileSync(path.join(path.dirname(previousAttempt.evidencePath), 'request.json'), 'utf8'));
        if (prior.priorWindows) request.priorWindows = prior.priorWindows;
    } else if (previousBudget.length) request.priorWindows = previousBudget.map(({ id, start, end }) => ({ id, start, end }));
    request.requestSha256 = hash(JSON.stringify(request) + fileHash(io.scriptPath));
    const input = path.join(directory, 'request.json'), output = path.join(directory, 'audio.json');
    fs.writeFileSync(input, JSON.stringify(request, null, 2), 'utf8');
    let reusedEvidence = false;
    try {
        let previous: Data | undefined;
        if (previousAttempt?.inputIdentity === inputIdentity) {
            if (previousAttempt.status !== 'inconclusive' || fileHash(previousAttempt.evidencePath) !== previousAttempt.evidenceSha256) {
                throw new Error('Previous local subtitle audio evidence changed');
            }
            previous = JSON.parse(fs.readFileSync(previousAttempt.evidencePath, 'utf8'));
            if (JSON.stringify(previous!.source) !== JSON.stringify(request.source)) throw new Error('Previous local subtitle audio source differs');
            if (previous!.requestSha256 !== request.requestSha256) {
                const all = [...(request.priorWindows || []), ...previous!.windows, ...windows];
                if (all.length > 4 || all.reduce((total, row) => total + row.end - row.start, 0) > 120) return artifact;
                request.priorWindows = all.slice(0, -windows.length).map(({ id, start, end }) => ({ id, start, end }));
                delete request.requestSha256;
                request.requestSha256 = hash(JSON.stringify(request) + fileHash(io.scriptPath));
                fs.writeFileSync(input, JSON.stringify(request, null, 2), 'utf8');
                previous = undefined;
            }
        }
        if (previous) {
            for (const row of previous.windows) {
                const oldPath = path.resolve(row.audioPath);
                if (path.dirname(oldPath) !== path.dirname(path.resolve(previousAttempt.evidencePath))
                    || fileHash(oldPath) !== row.audioSha256 || !/^A[1-4]$/u.test(row.id)) throw new Error('Previous audio window changed');
                const audioPath = path.join(directory, `${row.id}.wav`);
                fs.copyFileSync(oldPath, audioPath, fs.constants.COPYFILE_EXCL);
                row.audioPath = audioPath;
            }
            fs.writeFileSync(output, JSON.stringify(previous, null, 2), 'utf8');
            reusedEvidence = true;
        } else if (io.runAudio) await io.runAudio(input, output);
        else {
            const completed = await execute(io.python.executable, [...io.python.args, io.scriptPath, input, output],
                { windowsHide: true, shell: false, timeout: 300000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' } });
            fs.writeFileSync(path.join(directory, 'audio.log'), completed.stdout + completed.stderr, 'utf8');
        }
    } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        fs.writeFileSync(path.join(directory, 'audio.log'), `${failure.stdout || ''}${failure.stderr || ''}\n${failure.message}`, 'utf8');
        throw new Error('Local subtitle audio check unavailable; original artifact retained');
    }
    const audio = JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/u, ''));
    if (audio.version !== 1 || audio.requestSha256 !== request.requestSha256 || JSON.stringify(audio.source) !== JSON.stringify(request.source)
        || !Array.isArray(audio.windows) || JSON.stringify(audio.windows.map(({ id, start, end }: Data) => ({ id, start, end })))
            !== JSON.stringify(windows)) throw new Error('Subtitle audio result binding differs');
    const edits: Data[] = [];
    for (const probe of probes) {
        const row = audio.windows.find((item: Data) => item.start <= probe.start && item.end >= probe.end), audioPath = path.resolve(row.audioPath);
        if (path.dirname(audioPath) !== directory || fileHash(audioPath) !== row.audioSha256) throw new Error('Subtitle audio evidence changed');
        if (JSON.stringify(row.decodes?.map((decode: Data) => decode.model)) !== JSON.stringify([io.settings.model, io.settings.sensevoiceModel])) {
            throw new Error('Subtitle audio models differ from the requested independent pair');
        }
        const boundProbe = { ...probe, id: row.id, start: row.start, end: row.end };
        const edit = consensusSubtitleEdit(boundProbe, row, io.protectedNames) || consensusCueEdit(boundProbe, row, io.protectedNames);
        // A source-only numeric rebuild can be diagnosed, but its bound rendered subtitle receipt is never rewritten here.
        if (!edit || artifact.renderedSubtitles) {
            if (JSON.stringify(initial) !== JSON.stringify(await publicationSnapshot(artifact))) throw new Error('Source changed during audio diagnosis');
            return io.reviewFinal({ ...artifact, automaticSubtitleRepairAttempt: { inputIdentity, alignmentVersion: ALIGNMENT_VERSION, status: 'inconclusive',
                evidencePath: output, evidenceSha256: fileHash(output), attemptedAt: new Date().toISOString() } });
        }
        edits.push({ ...edit, sourceStart: artifact.window.start + cues[probe.index].start,
            sourceEnd: artifact.window.start + cues[probe.index].end });
    }
    if (JSON.stringify(initial) !== JSON.stringify(await publicationSnapshot(artifact))) throw new Error('Source or current artifact changed during audio check');
    const corrected = applyConsensusEdits(cues, edits), srtPath = path.join(directory, 'corrected.srt');
    io.write(srtPath, corrected);
    const evidence: Data = { version: 1, authority: 'automatic', method: 'unprompted_two_model_consensus', inputIdentity, alignmentVersion: ALIGNMENT_VERSION,
        generation: previousRepair ? (previousRepair.generation || 1) + 1 : 1,
        ...(previousRepair ? { previousRepair, allEdits: [...(previousRepair.allEdits || previousRepair.edits).filter((edit: Data) => edit.from !== edit.to), ...edits] } : {}),
        ...(reusedEvidence ? { reusedEvidencePath: previousAttempt.evidencePath, reusedEvidenceSha256: previousAttempt.evidenceSha256 } : {}),
        requestPath: input, requestSha256: fileHash(input), evidencePath: output, evidenceSha256: fileHash(output),
        source: initial.source, edits, checks: audio.windows, correctedSrtPath: srtPath, correctedSrtSha256: fileHash(srtPath),
        probeBudgetWindows: [...(request.priorWindows || []), ...windows],
        before: { output: artifact.output, copy: artifact.copy, publicationReview: artifact.publicationReview } };
    const proofPath = path.join(directory, 'proof.json');
    fs.writeFileSync(proofPath, JSON.stringify(evidence, null, 2), 'utf8');
    const bound = { ...evidence, proofPath, proofSha256: fileHash(proofPath) };
    let updated: Artifact = { ...artifact, automaticSubtitleRepair: bound, attributionRequired: true };
    if (edits.some(edit => edit.from !== edit.to)) updated = await io.render(updated, srtPath, directory);
    if (JSON.stringify(updated.source) !== JSON.stringify(artifact.source) || JSON.stringify(updated.window) !== JSON.stringify(artifact.window)
        || updated.output.metadataPath !== artifact.output.metadataPath || updated.humanReview || updated.ownStreamHumanReview) throw new Error('Automatic subtitle rendering changed identity or authority');
    updated = await io.reviewCopy(updated);
    if (updated.attributionReview?.status !== 'passed' || updated.publicCopyPending) return artifact;
    const revised = await publicationSnapshot(updated);
    if (JSON.stringify(revised.source) !== JSON.stringify(initial.source)) throw new Error('Source changed during subtitle repair');
    updated.automaticSubtitleRepair = { ...bound, resultIdentity: hash(JSON.stringify(revised)) };
    return io.reviewFinal(updated);
}
