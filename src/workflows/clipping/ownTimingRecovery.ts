import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

type Data = Record<string, any>;
type Cue = { start: number; end: number; text: string };
const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Bounded unprompted speech from the rebuilt file, used to catch topic/timeline mismatch, never to rewrite words. */
export async function verifyRenderedTimingAudio(artifact: Data, io: {
    python: { executable: string; args: string[] }; scriptPath: string; settings: Data;
    runAudio?(input: string, output: string): Promise<void>;
}): Promise<Data> {
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const media = path.resolve(artifact.output.mediaPath), srt = path.resolve(artifact.output.srtPath);
    const stat = fs.statSync(media), duration = artifact.window.duration;
    if (!(duration > 0)) throw new Error('A rebuilt duration is required for final audio verification');
    const count = Math.ceil(duration / 30);
    const windows = duration <= 120 ? Array.from({ length: count }, (_, index) => ({
        id: `A${index + 1}`, start: index * duration / count, end: (index + 1) * duration / count }))
        : [0, duration / 2 - 7.5, duration - 15].map((start, index) => ({ id: `A${index + 1}`, start, end: start + 15 }));
    const directory = path.join(path.dirname(artifact.output.metadataPath), 'temp', 'final-timing-audio', randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    const request: Data = { version: 1, source: { mediaPath: media, mediaBytes: stat.size, mediaMtimeMs: stat.mtimeMs,
        srtPath: srt, srtSha256: hash(fs.readFileSync(srt)) }, windows, settings: io.settings };
    request.requestSha256 = hash(JSON.stringify(request) + hash(fs.readFileSync(io.scriptPath)));
    const input = path.join(directory, 'request.json'), output = path.join(directory, 'audio.json');
    fs.writeFileSync(input, JSON.stringify(request, null, 2), 'utf8');
    if (io.runAudio) await io.runAudio(input, output);
    else await promisify(execFile)(io.python.executable, [...io.python.args, io.scriptPath, input, output], {
        windowsHide: true, shell: false, timeout: 600000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    });
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (result.requestSha256 !== request.requestSha256 || JSON.stringify(result.source) !== JSON.stringify(request.source)
        || result.windows?.length !== windows.length || result.windows.some((row: Data, index: number) =>
            row.start !== windows[index].start || row.end !== windows[index].end || row.decodes?.length !== 2
            || row.decodes.some((decode: Data) => decode.prompted !== false || decode.hotwords?.length || decode.useItn !== false))) {
        throw new Error('Independent final audio evidence is incomplete');
    }
    return { ...artifact, renderedTimingRepair: { ...artifact.renderedTimingRepair, finalAudio: {
        version: 1, method: 'unprompted_final_audio', source: request.source, windows: result.windows,
        requestPath: input, requestSha256: hash(fs.readFileSync(input)),
        evidencePath: output, evidenceSha256: hash(fs.readFileSync(output)) } } };
}

/** A verified transcript prepares a new revision; it never blesses the existing burned video. */
export function prepareRenderedTimingRevision(metadata: Data, transcript: Data, original: Data, note: string): Data {
    if (!note?.trim() || transcript.mode !== 'repaired_source_audio'
        || !samePath(transcript.originalSrtPath, original.srtPath)
        || transcript.originalSrtSha256 !== original.srtSha256
        || samePath(transcript.path, original.srtPath)) throw new Error('A bound timing transcript and revision note are required');
    if (metadata.renderedSubtitles?.edits?.length || metadata.candidateSubtitles?.edits?.length) {
        throw new Error('Timing recovery must not discard existing confirmed word corrections');
    }
    const revised: Data = { ...metadata, source: { ...metadata.source, srtPath: transcript.path },
        renderedTimingRepair: { version: 1, id: randomUUID(), note: note.trim(), transcript,
            originalSource: original, originalWindow: metadata.window, originalOutput: metadata.output },
        rebuildRequired: true, uploadReady: false };
    // Old cue IDs, speaker/QA approvals and output bindings belong to the old timeline.
    for (const key of ['renderedSubtitles', 'candidateSubtitles', 'ownStreamHumanReview', 'humanReview',
        'attributionReview', 'qaResult', 'grounding', 'preRenderSource', 'manualRevisionSource',
        'publicationReview', 'publicationDecision', 'automaticPublicationAuthorization', 'automaticSubtitleRepair',
        'sourceReview', 'topicEditPlan', 'subtitleProofreading', 'quoteEchoes', 'endingHold', 'candidate',
        'creativeResult', 'creativePlan', 'editPlan', 'sourceExpansionRequest', 'storyRepairRequest', 'audioQa',
        'automaticCopyRepair', 'automaticQaRepair', 'automaticCoverLayoutRepair']) delete revised[key];
    return revised;
}

/** Exact unique original words propose a search window, never an approved boundary or speaker identity. */
export function timingSearchWindow(window: { start: number; end: number }, original: Cue[], corrected: Cue[]): Data | null {
    const rows = corrected.map(cue => ({ ...cue, normalized: normalized(cue.text) }));
    let text = '';
    const offsets = rows.map(row => { const offset = text.length; text += row.normalized; return offset; });
    const matches: Data[] = [];
    for (const cue of original.filter(cue => cue.start >= window.start && cue.end <= window.end)) {
        const quote = normalized(cue.text);
        if (quote.length < 8) continue;
        const index = text.indexOf(quote);
        if (index < 0 || text.indexOf(quote, index+1) >= 0) continue;
        let rowIndex = offsets.findIndex((offset, i) => offset <= index && (offsets[i+1] ?? text.length+1) > index);
        if (rowIndex < 0) continue;
        const end = index+quote.length;
        const startTime = rows[rowIndex].start;
        while (rowIndex+1 < rows.length && offsets[rowIndex+1] < end) rowIndex++;
        matches.push({ quote: cue.text, start: startTime, end: rows[rowIndex].end, delta: startTime-cue.start });
    }
    if (!matches.length) return null;
    const cluster = matches.map(anchor => matches.filter(match => Math.abs(match.delta-anchor.delta) <= 20))
        .sort((a, b) => b.length-a.length)[0];
    if (cluster.length < 2 && !cluster.some(match => normalized(match.quote).length >= 16)) return null;
    // Conflicting temporal clusters cannot be resolved by a guessed global offset.
    if (cluster.length*2 < matches.length) return null;
    const delta = cluster.map(match => match.delta).sort((a,b) => a-b)[Math.floor(cluster.length/2)];
    return { start: Math.max(0, window.start+delta-30), end: Math.min(corrected.at(-1)!.end, window.end+delta+60),
        anchors: cluster, authority: 'unverified_search_window' };
}

export function prepareOwnTimingRecovery(directory: string, source: Data, original: Cue[], corrected: Cue[], registry: Data, note: string): Data {
    if (!note?.trim()) throw new Error('Timing recovery requires a substantive revision note');
    const planPath = path.join(directory, 'PLAN.json');
    const statePath = path.join(directory, 'REVIEW_STATE.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!samePath(plan.source.mediaPath, source.mediaPath) || !samePath(plan.source.srtPath, source.srtPath)) {
        throw new Error('Timing recovery differs from the original plan source');
    }
    const originals = state.entries.map((entry: Data) => JSON.parse(fs.readFileSync(entry.metadataPath, 'utf8')));
    const candidates: Data[] = [];
    for (const row of originals) {
        const registered = Object.values(registry.clips || {}).find((clip: any) => clip.metadataPath && samePath(clip.metadataPath, row.output.metadataPath)) as Data | undefined;
        if (!registered || !['needs_review', 'review'].includes(registered.status) || registered.bvid || registered.aid
            || registered.uploadState?.bvid || registered.automaticPublicationAuthorization
            || row.ownStreamHumanReview || row.humanReview || !samePath(row.source.mediaPath, source.mediaPath)) {
            throw new Error('Timing recovery only edits existing unpublished pending IDs');
        }
        if (row.selectionRejection || row.status === 'selection_rejected') continue;
        const window = timingSearchWindow(row.window, original, corrected);
        if (window) candidates.push({ index: row.reviewIndex ?? row.window.index, start: window.start, end: window.end,
            score: row.recommendationScore || 0, event: row.copy.title,
            globalSelection: { reason: `修复原候选：${row.copy.title}。${row.copy.description}；核对当前原话，不支持则保留待核。` },
            timingRecovery: { metadataPath: row.output.metadataPath, reviewIndex: row.reviewIndex ?? row.window.index, anchors: window.anchors,
                requiredReviews: { attributionRequired: Boolean(row.attributionRequired || registered.attributionRequired),
                    qaRequired: Boolean(row.qaRequired || registered.qaRequired) } } });
    }
    const id = randomUUID(), backupDirectory = path.join(directory, 'temp', 'timing-revisions', id);
    fs.mkdirSync(path.join(backupDirectory, 'metadata'), { recursive: true });
    for (const name of ['PLAN.json', 'REVIEW.md', 'REVIEW_STATE.json', 'UPLOAD_MANIFEST.json']) {
        const file = path.join(directory, name);
        if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backupDirectory, name));
    }
    for (const row of originals) fs.copyFileSync(row.output.metadataPath, path.join(backupDirectory, 'metadata', path.basename(row.output.metadataPath)));
    fs.mkdirSync(path.join(backupDirectory, 'media'));
    return { id, note, backupDirectory, originals, candidates, startedAt: new Date().toISOString() };
}

export function retainTimingRecoveryIds(clips: Data[], recovery: Data): Data[] {
    return clips.map(clip => {
        const candidate = recovery.candidates.find((candidate: Data) => String(candidate.index) === String(clip.candidateIndex));
        if (!candidate) throw new Error('Timing recovery returned a different candidate identity');
        const required = candidate.timingRecovery.requiredReviews || {};
        return { ...clip, ...Object.fromEntries(Object.entries(required).filter(([, value]) => value === true)),
            timingRecovery: { ...candidate.timingRecovery, id: recovery.id } };
    });
}

export function retainUnrecoveredTimingRows(results: Data[], recovery: Data): Data[] {
    const paths = new Set(results.map(row => path.resolve(row.output.metadataPath).toLowerCase()));
    return [...results, ...recovery.originals.filter((row: Data) => !paths.has(path.resolve(row.output.metadataPath).toLowerCase()))];
}
