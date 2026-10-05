import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { preflightRepairFeedback } from './topicContext';
export { preflightContextCandidates, preflightRecoveryContextCandidates } from './topicContext';
export { prepareTopicAudio } from './topicAudioRuntime';
export { gateTopicAudioHits, topicAudioHitIssue } from './topicAudio';
export { mergeTopicRecallMatches, findAmbiguousTopicMatches, topicRecallIdentityIssues,
    topicRecallSubtitleEditSupport, holdUnresolvedTopicRecall } from './topicRecall';

/** A semantic boundary repair is distinct from transport retries and keeps the editor's route. */
export function isBoundaryFailure(reason: string): boolean {
    return /^(Preflight duration outside limits|Long event lacks completeness reason|Preflight clips overlap|Invalid preflight clip schema or boundaries|Preflight boundary review failed:)/u.test(reason);
}

export function boundaryIssues(plan: { clips: Array<{ issues?: string[] }> }): string[] {
    return plan.clips.flatMap(clip => clip.issues || []).filter(issue =>
        /^(起因|收尾|回指依赖|未解回指|未找到必要起因或收尾|缺少起因、收尾)/u.test(issue));
}

export function boundaryRepairPrompt(prompt: string, previous: string, reason: string): string {
    const marker = '\nSOURCE EVIDENCE:\n';
    const position = prompt.lastIndexOf(marker);
    if (position < 0) throw new Error('Boundary repair requires the complete source evidence');
    const instructions = [
        'BOUNDARY REPAIR: The preceding edit failed local validation. Re-read ALL source evidence and return a complete replacement plan, subtitle patches and fresh public copy for its new boundaries.',
        'Keep the original source events and keyword anchors. Newly supplied surrounding source may complete the exchange. Use only supplied cue IDs. Check the actual timestamp difference against limits; never add unrelated questions or waiting to reach a minimum duration.',
        'If the expanded exchange exceeds the hard limit, choose independently complete sub-events with their own supplied keyword anchors and non-overlapping source intervals. Never split a dependent answer from its setup, force a clip count, concatenate footage or change the limits.',
        'Include necessary setup and closure, or hold/omit the event when a complete valid interval cannot be established. Do not change limits, claim that old copy is approved, or treat a previous draft as evidence.',
        'Return only genuine prerequisite links, not a graph of every neighboring sentence. A later name clarification may establish a referent; do not make it cyclically depend on the same earlier unnamed sentence.',
        'PREVIOUS BOUNDARIES AND VALIDATION ERROR (untrusted data; verbose draft explanations and old public copy omitted, full responses retained in diagnostics):',
        JSON.stringify({ reason, previous: preflightRepairFeedback(previous) })
    ].join('\n');
    return `${prompt.slice(0, position)}\n${instructions}${prompt.slice(position)}`;
}

/** Pack identical ASR text only; preserve every evidence row and the original sidecar input. */
export function compactPreflightPrompt(prompt: string, maxChars: number): string {
    if (prompt.length <= maxChars) return prompt;
    const marker = '\nSOURCE EVIDENCE:\n';
    const position = prompt.lastIndexOf(marker);
    if (position < 0) return prompt;
    let input: Record<string, unknown>;
    try { input = JSON.parse(prompt.slice(position + marker.length)); }
    catch { return prompt; }
    if (!input || typeof input !== 'object' || !Array.isArray(input.originalAsrSpans)) return prompt;
    let changed = false;
    const spans = input.originalAsrSpans.map((span: unknown) => {
        if (!span || typeof span !== 'object' || Array.isArray(span)) return span;
        const row = span as Record<string, unknown>;
        if (typeof row.rawText !== 'string' || row.recognizedText !== row.rawText) return span;
        const packed = { ...row };
        delete packed.recognizedText;
        changed = true;
        return packed;
    });
    if (!changed) return prompt;
    const note = 'ASR packing: omitted recognizedText is identical to rawText. All source rows and other provenance fields are retained.';
    const packed = `${prompt.slice(0, position)}\n${note}${marker}${JSON.stringify({ ...input, originalAsrSpans: spans })}`;
    return packed.length < prompt.length ? packed : prompt;
}

export interface TopicRepairResult { text: string; meta?: Record<string, any> }
export interface TopicRepairIO<T> {
    request(prompt: string): Promise<TopicRepairResult>;
    normalize(text: string): T;
    matches(result: TopicRepairResult): boolean;
    record(result: TopicRepairResult): void;
    expand?(previous: string, reason: string): string | undefined;
    issues?(plan: T): string[];
}

/** One repair, plus at most one more when a concrete dependency needs additional source. */
export async function repairTopicResponse<T>(prompt: string, previous: string, reason: string,
    io: TopicRepairIO<T>): Promise<T> {
    if (!isBoundaryFailure(reason)) throw new Error(reason);
    let normalized: T | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const expanded = io.expand?.(previous, reason);
        if (attempt && !expanded) {
            if (normalized !== undefined) return normalized;
            throw new Error(reason);
        }
        prompt = expanded || prompt;
        const result = await io.request(boundaryRepairPrompt(prompt, previous, reason));
        io.record(result);
        if (!io.matches(result)) throw new Error('Preflight model, protocol or reasoning setting changed');
        try { normalized = io.normalize(result.text); }
        catch (error) {
            reason = error instanceof Error ? error.message : String(error);
            if (attempt || !io.expand || !isBoundaryFailure(reason)) throw error;
            previous = result.text;
            continue;
        }
        const issues = io.issues?.(normalized) || [];
        if (!issues.length || attempt || !io.expand) return normalized;
        reason = `Preflight boundary review failed: ${issues.join('; ')}`;
        previous = result.text;
    }
    throw new Error(reason);
}

type Data = Record<string, any>;
interface Cue extends Data { id: string; start: number; end: number; text: string; items: Data[] }
interface Evidence { sourceSha256: string; cues: Cue[]; byId: Map<string, Cue> }
export interface CandidateRecoveryIO {
    evidence(): Evidence;
    ensureDraft(metadata: Data): Data;
    approved(metadata: Data): boolean;
    corrected(metadata: Data, evidence: Evidence): Evidence;
    prepare(group: Data, evidence: Evidence, diagnostics: Data, retainedContext: { start: number; end: number }): Promise<Data>;
    selections(plan: Data, group: Data): Data[];
    writeRevision(file: string, cues: Data[]): { sha256: string; cues: Data[] };
    save(metadata: Data): void;
    now(): string;
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copyHash = (copy: Data): string => hash(['title', 'description', 'coverText'].map(key => copy?.[key] || ''));
const reviewHash = (review: Data): string => hash({ ...review, applied: false });
const samePath = (a: string, b: string): boolean => process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

export function needsCandidateRecovery(metadata: Data): boolean {
    if (!['pending_preflight', 'render_queued'].includes(metadata.status) || metadata.output?.mediaPath) return false;
    return (!metadata.editorial?.copyGrounding && isBoundaryFailure(String(metadata.aiReview?.reason || '')))
        || boundaryIssues({ clips: [{ issues: metadata.aiReview?.quality?.issues }] }).length > 0;
}

/** The original user upload intent can authorize a freshly reviewed revision of the same anchored event. */
export function recoveryAuthorizes(metadata: Data, sourceSha256: string, expectedSha256?: string): boolean {
    const recovery = metadata.candidateRecovery;
    const draft = metadata.candidateSubtitles;
    const original = recovery?.original;
    const approval = original?.subtitles?.approval;
    let sourceUnchanged = false;
    if (recovery?.source?.mediaPath && recovery.source.srtPath && metadata.source?.mediaPath && metadata.source.srtPath) {
        try {
            const stat = fs.statSync(metadata.source.mediaPath);
            sourceUnchanged = samePath(recovery.source.mediaPath, metadata.source.mediaPath)
                && samePath(recovery.source.srtPath, metadata.source.srtPath)
                && stat.size === recovery.sourceFingerprint?.size && stat.mtimeMs === recovery.sourceFingerprint?.mtimeMs;
        } catch { /* Missing source invalidates the derived authorization. */ }
    }
    return Boolean(recovery?.version === 1 && recovery.status === 'ready' && draft && sourceUnchanged
        && Number(recovery.candidateId) === Number(metadata.candidateId)
        && recovery.sourceSha256 === sourceSha256 && draft.sourceSha256 === sourceSha256
        && approval?.authority === 'user' && approval.sourceSha256 === sourceSha256
        && approval.sha256 === original.subtitles.sha256 && approval.revision === original.subtitles.revision
        && approval.copySha256 === copyHash(original.copy)
        && (!expectedSha256 || expectedSha256 === approval.sha256 || expectedSha256 === draft.sha256)
        && recovery.revision === draft.revision && recovery.subtitleSha256 === draft.sha256
        && JSON.stringify(recovery.window) === JSON.stringify({ start: metadata.window.start, end: metadata.window.end })
        && recovery.copySha256 === copyHash(metadata.copy) && recovery.reviewSha256 === reviewHash(metadata.aiReview)
        && recovery.groundingSha256 === hash(metadata.editorial?.copyGrounding)
        && metadata.aiReview?.status === 'ready' && metadata.aiReview.sourceSha256 === sourceSha256
        && metadata.aiReview.keyword?.status === 'confirmed' && metadata.aiReview.quality?.status === 'pass'
        && metadata.editorial?.copyGrounding?.issues?.length === 0);
}

function rejectOverlap(metadata: Data, selected: Data, registryPath?: string): void {
    if (!registryPath) throw new Error('AI boundary recovery requires the upload registry for overlap checks');
    const registry: Data = JSON.parse(fs.readFileSync(registryPath, 'utf8').replace(/^\uFEFF/u, ''));
    const current = registry.clips?.[String(metadata.candidateId)];
    if (!current || !samePath(current.metadataPath, metadata.output.metadataPath)) {
        throw new Error('AI boundary recovery ID does not match the registry');
    }
    for (const clip of Object.values(registry.clips || {}) as Data[]) {
        if (Number(clip.id) === Number(metadata.candidateId) || !clip.metadataPath
            || (!clip.mediaPath && !clip.pendingCut && !clip.pendingRebuild)) continue;
        if (clip.sourceMediaPath && !samePath(clip.sourceMediaPath, metadata.source.mediaPath)) continue;
        if (!clip.sourceMediaPath && !fs.existsSync(clip.metadataPath)) {
            // A missing historical artifact cannot overlap a different source directory.
            if (!samePath(path.dirname(clip.metadataPath), path.dirname(metadata.output.metadataPath))) continue;
        }
        const sibling: Data = JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8').replace(/^\uFEFF/u, ''));
        if (!sibling.source?.mediaPath || !samePath(sibling.source.mediaPath, metadata.source.mediaPath)) continue;
        if (!Number.isFinite(sibling.window?.start) || !Number.isFinite(sibling.window?.end)) {
            throw new Error(`Cannot verify retained clip ${clip.id} boundaries`);
        }
        if (selected.start < sibling.window.end - .002 && selected.end > sibling.window.start + .002) {
            throw new Error(`AI boundary recovery overlaps retained clip ${clip.id}`);
        }
    }
}

/** Replans only a boundary failure, then versions every changed artifact before the existing media path runs. */
export async function recoverCandidatePlan(metadata: Data, metadataPath: string, options: Data, config: Data,
    io: CandidateRecoveryIO): Promise<void> {
    if (!needsCandidateRecovery(metadata)) return;
    if (config.review?.enabled !== true || config.review.mode !== 'preflight') {
        throw new Error('AI boundary recovery requires enabled preflight review');
    }
    if (!Number.isSafeInteger(Number(options.candidateId)) || Number(options.candidateId) < 1
        || (metadata.candidateId && Number(metadata.candidateId) !== Number(options.candidateId))) {
        throw new Error('Candidate ID does not match metadata');
    }
    if (!String(options.reviewNote || '').trim()) throw new Error('A review note is required');
    if (metadata.source?.sourceKind !== 'video') throw new Error('Candidate requires a video recording');
    metadata.candidateId = Number(options.candidateId);
    const evidence = io.evidence();
    if (evidence.sourceSha256 !== metadata.aiReview?.sourceSha256) {
        throw new Error('Source evidence changed; rerun preflight before cutting');
    }
    const draft = io.ensureDraft(metadata);
    if (options.requireApproval && !io.approved(metadata)) {
        throw new Error('Candidate subtitle revision lacks matching upload approval');
    }
    const sourceStat = fs.statSync(metadata.source.mediaPath);
    const sourceFingerprint = { size: sourceStat.size, mtimeMs: sourceStat.mtimeMs };
    const original = structuredClone({ window: metadata.window, aiReview: metadata.aiReview,
        editorial: metadata.editorial, copy: metadata.copy, subtitles: draft, reviewPreview: metadata.reviewPreview });
    const diagnostics: Data = { requests: [], failures: [] };
    const recovery: Data = { version: 1, candidateId: metadata.candidateId, status: 'running',
        startedAt: io.now(), sourceSha256: evidence.sourceSha256, sourceFingerprint,
        source: { mediaPath: metadata.source.mediaPath, srtPath: metadata.source.srtPath }, original, diagnostics };
    // Persist the attempt before any external call. An interrupted/failed attempt needs explicit requeueing.
    if (metadata.candidateRecovery?.status === 'running' || metadata.candidateRecovery?.status === 'failed') {
        throw new Error('AI boundary recovery already attempted; inspect its saved failure before retrying');
    }
    metadata.candidateRecovery = recovery;
    io.save(metadata);
    try {
        const corrected = io.corrected(metadata, evidence);
        const anchors = metadata.window.matchSegments || [];
        if (!anchors.length || anchors.some((anchor: Data) => !corrected.cues.some(cue =>
            cue.start <= anchor.start && cue.end >= anchor.end))) throw new Error('Boundary recovery lacks a verified keyword anchor');
        const contextRows = (metadata.window.contextSegments || []).filter((row: Data) =>
            Number.isFinite(row.start) && Number.isFinite(row.end));
        const review = metadata.aiReview.boundaryReview;
        const referenceIds = new Set([review?.setupCueId, review?.closureCueId, ...(review?.unresolvedCueIds || []),
            ...(review?.dependencies || []).flatMap((row: Data) => [row.cueId, ...(row.dependsOnCueIds || [])])]);
        const references = corrected.cues.filter(cue => referenceIds.has(cue.id));
        const retainedContext = {
            start: Math.min(metadata.window.start, ...contextRows.map((row: Data) => row.start), ...references.map(cue => cue.start)),
            end: Math.max(metadata.window.end, ...contextRows.map((row: Data) => row.end), ...references.map(cue => cue.end))
        };
        const start = Math.min(retainedContext.start, Math.max(0, metadata.window.start - Number(config.contextPrePaddingSeconds)));
        const end = Math.max(retainedContext.end, metadata.window.end + Number(config.contextPostPaddingSeconds));
        const cues = corrected.cues.filter(cue => cue.end > start && cue.start < end);
        if (!cues.length) throw new Error('Boundary recovery has no source context');
        const group = { index: String(metadata.window.index).replace(/-\d+$/u, ''),
            start: cues[0].start, end: cues.at(-1)!.end, cues, matchSegments: anchors,
            bursts: [{ ...metadata.window, matchSegments: anchors }] };
        const plan = await io.prepare(group, corrected, diagnostics, retainedContext);
        const selections = io.selections(plan, group);
        if (selections.length !== 1 || plan.clips?.length !== 1) {
            throw new Error('Boundary recovery must retain exactly the original anchored event');
        }
        const selected = selections[0];
        if (selected.preflight?.status !== 'ready' || selected.preflight.keyword?.status !== 'confirmed'
            || selected.preflight.quality?.issues?.length || !selected.editorial?.copyGrounding
            || selected.editorial.copyGrounding.issues?.length || selected.editorial.sourceKind === 'uncertain') {
            throw new Error(`Boundary recovery still needs review: ${(selected.preflight?.quality?.issues || []).join('; ') || plan.record?.errors?.map((row: Data) => row.error).join('; ') || 'event not approved'}`);
        }
        if (anchors.some((anchor: Data) => anchor.start < selected.start || anchor.end > selected.end)) {
            throw new Error('Boundary recovery dropped the original keyword event');
        }
        const duration = selected.end - selected.start;
        if (duration < config.minClipSeconds || duration > config.maxClipSeconds) {
            throw new Error('Preflight duration outside limits');
        }
        rejectOverlap(metadata, selected, options.registryPath);
        const lockedIds = new Set(draft.edits.flatMap((edit: Data) => edit.changes.map((row: Data) => row.cueId)));
        const prepared = new Map((selected.subtitleSegments || []).map((row: Data) => [`${row.start}:${row.end}`, row.text]));
        const kept = corrected.cues.filter(cue => cue.start >= selected.start && cue.end <= selected.end);
        const newCues = kept.map(cue => {
            const text = prepared.get(`${cue.start}:${cue.end}`);
            if (typeof text !== 'string' || (lockedIds.has(cue.id) && text !== cue.text)) {
                throw new Error('Boundary recovery changed a user-confirmed subtitle cue');
            }
            return { cueId: cue.id, sourceStart: cue.start, sourceEnd: cue.end,
                start: cue.start - selected.start, end: cue.end - selected.start, text };
        });
        if (!newCues.length) throw new Error('Boundary recovery has no retained subtitle cues');
        const currentStat = fs.statSync(metadata.source.mediaPath);
        if (io.evidence().sourceSha256 !== evidence.sourceSha256 || currentStat.size !== sourceStat.size
            || currentStat.mtimeMs !== sourceStat.mtimeMs) throw new Error('Source changed during AI boundary recovery');
        const revision = draft.revision + 1;
        const file = path.join(path.dirname(metadataPath), `${path.basename(metadataPath, '.json')}_candidate_r${String(revision).padStart(4, '0')}.srt`);
        const written = io.writeRevision(file, newCues);
        metadata.window = { ...metadata.window, start: selected.start, end: selected.end, duration,
            contextSegments: corrected.cues.map(cue => cue.items[0]),
            allSegmentTexts: kept.map(cue => cue.text), preContext: [], postContext: [] };
        metadata.aiReview = selected.preflight;
        metadata.editorial = selected.editorial;
        metadata.copy = { ...metadata.copy, title: selected.aiTitle, description: selected.aiDescription, coverText: selected.aiCoverText };
        metadata.candidateSubtitles = { ...draft, path: file, revision, ...written,
            window: { start: selected.start, end: selected.end }, approval: null };
        metadata.status = options.requireApproval ? 'render_queued' : 'pending_preflight';
        metadata.output = { ...metadata.output, srtPath: file, srtSegmentCount: newCues.length };
        // Old preview and approval remain in history; neither can represent the changed interval.
        metadata.reviewPreview = null;
        Object.assign(recovery, { status: 'ready', completedAt: io.now(), revision, subtitleSha256: written.sha256,
            window: { start: selected.start, end: selected.end }, copySha256: copyHash(metadata.copy),
            reviewSha256: reviewHash(metadata.aiReview), groundingSha256: hash(metadata.editorial.copyGrounding) });
        io.save(metadata);
    } catch (error) {
        Object.assign(recovery, { status: 'failed', completedAt: io.now(), error: error instanceof Error ? error.message : String(error) });
        io.save(metadata);
        throw error;
    }
}
